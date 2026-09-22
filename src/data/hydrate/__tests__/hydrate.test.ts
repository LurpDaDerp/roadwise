/** @jest-environment node */
import { createClient } from '@supabase/supabase-js';

import { readRolePrior, recordRoleAnswer, roleAnswerKey } from '@/core/engine/rolePrior';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { migrate } from '@/data/db/migrate';
import { createQueueRepo } from '@/data/db/queue';
import { createScoreDailyCacheRepo } from '@/data/db/scoreDailyCache';
import { createSettingsRepo } from '@/data/db/settings';
import { readTombstones, addTombstone } from '@/data/db/tombstones';
import { createTripsRepo } from '@/data/db/trips';
import type { TripRow } from '@/data/db/types';
import { onDataChanged, type ChangeSource } from '@/data/events';
import {
  createHydrator,
  HYDRATE_CURSOR_KEY,
  HYDRATE_DAYS_CURSOR_KEY,
  HYDRATE_RECONCILED_AT_KEY,
  HYDRATE_RESTORED_AT_KEY,
  HYDRATE_UNREADABLE_KEY,
  hydrateSeam,
  UNREADABLE_TTL_MS,
  UNREADABLE_VERSION,
  RECONCILE_INTERVAL_MS,
  type HydrateQuery,
  type HydrateSupabase,
  type HydrateResult,
  type HydratorDeps,
} from '@/data/hydrate/hydrate';
import { UNKNOWN_BUILD } from '@/data/hydrate/build';
import { getHydrationStatus, setHydrationStatus } from '@/data/hydrate/status';
import { BASELINE_SETTING_KEY } from '@/data/queries/hooks';
import { parseStoredBaseline } from '@/data/queries/insights';
import { parseDispute } from '@/data/queries/rows';
import { createFakeSupabase, type FakeSupabase } from '@/data/sync/__fixtures__/fakes';
import { DEVICE_OWNER_KEY } from '@/data/sync/queue';

const UID = '0b9f7a52-7a8e-4a4f-8f38-3f1c1f5a9d10';
const OTHER = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const STAMP = '2026-09-21T10:00:00.123456+00:00';

/** A server uuid whose text order follows `n`. */
const sid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const eid = (n: number): string => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;

function serverTrip(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const started = Date.UTC(2026, 8, 1 + (n % 20), 8, 0, 0);
  return {
    id: sid(n),
    user_id: UID,
    client_trip_id: `trip-${n}`,
    started_at: new Date(started).toISOString().replace('Z', '+00:00'),
    ended_at: new Date(started + 1_800_000).toISOString().replace('Z', '+00:00'),
    tz: 'UTC',
    distance_m: 16093.44,
    duration_s: 1800,
    role: 'driver',
    role_confidence: null,
    role_source: 'manual',
    mode: 'mounted',
    camera_session: false,
    score: 88,
    scoring_version: 1,
    category_deductions: { phone: 0, speeding: 6, braking: 0, accel: 0, cornering: 0, focus: 0 },
    exposure: 1,
    data_quality: 'A',
    conditions: { night: false, precipitation: false },
    had_severe_event: false,
    limit_coverage_pct: 80,
    start_label: null,
    end_label: null,
    start_geohash5: '9q8yy',
    end_geohash5: '9q8yz',
    polyline: '_p~iF~ps|U_ulLnnqC',
    status: 'provisional',
    incomplete: false,
    deleted_at: null,
    updated_at: STAMP,
    ...over,
  };
}

function serverEvent(n: number, tripN: number, over: Record<string, unknown> = {}) {
  return {
    id: eid(n),
    trip_id: sid(tripN),
    user_id: UID,
    client_event_id: `ev-${n}`,
    category: 'speeding',
    started_at: '2026-09-02T08:05:00+00:00',
    duration_ms: 38_000,
    lat: 45.5,
    lng: -122.6,
    measured: { overMps: 3, limitMps: 15.6 },
    context: { night: false, precipitation: false },
    severity: 3.5,
    confidence: 0.9,
    deduction: 6,
    alert_shown: true,
    corrected: false,
    source: 'gnss',
    status: 'scored',
    ...over,
  };
}

function serverDay(day: string, over: Record<string, unknown> = {}) {
  return {
    user_id: UID,
    day,
    long_term_score: 84,
    band: 'good',
    provisional: false,
    safe_day: true,
    good_day: true,
    phone_free_day: true,
    camera_day: false,
    exposure: 1,
    driving_s: 1800,
    trips_scored: 1,
    severe_events: 0,
    updated_at: STAMP,
    ...over,
  };
}

let db: Db;
let supabase: FakeSupabase;
let busy: boolean;

const trips = () => createTripsRepo(db);
const settings = () => createSettingsRepo(db);

function hydrator(over: Partial<HydratorDeps> = {}) {
  return createHydrator({ db, supabase, now: () => NOW, isBusy: () => busy, ...over });
}

/** The reconciliation's listing columns. */
const LISTING = 'id,client_trip_id';
/** Reads of `table`, the reconciliation's id listing (`select('id')`) left out. */
const countOf = (table: string) =>
  supabase.selects.filter((s) => s.table === table && s.columns !== LISTING).length;
const tripPages = () => supabase.selects.filter((s) => s.table === 'trips' && s.columns !== LISTING);
const allTrips = async (): Promise<TripRow[]> => trips().list();

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await settings().set(DEVICE_OWNER_KEY, UID);
  supabase = createFakeSupabase({ uid: UID });
  busy = false;
  setHydrationStatus({ state: 'idle' });
});

describe('a full restore on an empty device', () => {
  test('brings back trips, events, reports, days and the baseline', async () => {
    supabase.tables = {
      trips: [serverTrip(1), serverTrip(2, { updated_at: '2026-09-21T10:00:01+00:00' })],
      trip_events: [serverEvent(1, 1), serverEvent(2, 1, { status: 'removed', deduction: 0, corrected: true })],
      event_disputes: [
        {
          event_id: eid(2),
          user_id: UID,
          reason: 'wrong_limit',
          note: null,
          stated_limit_mph: 45,
          auto_accepted: true,
          denied_reason: null,
          decided_at: '2026-09-02T09:00:00+00:00',
          created_at: '2026-09-02T08:59:00+00:00',
        },
      ],
      score_daily: [serverDay('2026-09-01'), serverDay('2026-09-02', { long_term_score: 86 })],
      baselines: [{ user_id: UID, medians: { score: 83, speeding: 2 }, computed_at: STAMP }],
    };
    const changes: ChangeSource[] = [];
    const off = onDataChanged((e) => changes.push(e.source));

    const result = await hydrator().run({ full: true });

    expect(result).toEqual<HydrateResult>({
      trips: 2,
      events: 2,
      days: 2,
      skippedLocal: 0,
      removed: 0,
      redeleted: 0,
      refetched: 0,
      baseline: true,
      complete: true,
    });
    const rows = await allTrips();
    expect(rows.map((r) => [r.client_trip_id, r.sync_state, r.server_id])).toEqual([
      ['trip-2', 'synced', sid(2)],
      ['trip-1', 'synced', sid(1)],
    ]);
    const events = await createEventsRepo(db).listByTrip('trip-1');
    expect(events.map((e) => e.id)).toEqual(['ev-1', 'ev-2']);
    expect(events[0]).toMatchObject({ duration_s: 38, severity: '3.5', dispute_json: null });
    expect(parseDispute(events[1]!.dispute_json)).toMatchObject({
      reason: 'wrong_limit',
      outcome: 'accepted',
      statedLimitMph: 45,
    });
    const days = await createScoreDailyCacheRepo(db).range<{ longTermScore: number }>('2026-01-01', '2026-12-31');
    expect(days.map((d) => [d.day, d.payload.longTermScore])).toEqual([
      ['2026-09-01', 84],
      ['2026-09-02', 86],
    ]);
    expect(parseStoredBaseline(await settings().get(BASELINE_SETTING_KEY))).toEqual({ score: 83, speeding: 2 });
    expect(getHydrationStatus()).toEqual({ state: 'idle' });
    await expect(settings().get(HYDRATE_RESTORED_AT_KEY)).resolves.toBe(NOW);

    await new Promise((resolve) => setTimeout(resolve, 0));
    off();
    expect(changes).toContain('hydrate');
  });

  test('every request is scoped to the signed-in user, and deleted trips are asked out', async () => {
    supabase.tables = { trips: [serverTrip(1)], trip_events: [serverEvent(1, 1)] };
    await hydrator().run({ full: true });
    for (const select of supabase.selects) expect(select.calls).toContain(`eq user_id ${UID}`);
    const tripReads = supabase.selects.filter((s) => s.table === 'trips');
    expect(tripReads[0]!.calls).toContain('is deleted_at null');
  });
});

describe('paging (review I19)', () => {
  test('five trips sharing one updated_at across a page boundary at page size 3 are all restored', async () => {
    supabase.tables = { trips: [5, 3, 1, 4, 2].map((n) => serverTrip(n)) };
    const result = await hydrator({ pageSize: 3 }).run({ full: true });

    expect(result).toMatchObject({ trips: 5, complete: true });
    expect((await allTrips()).map((r) => r.client_trip_id).sort()).toEqual([
      'trip-1',
      'trip-2',
      'trip-3',
      'trip-4',
      'trip-5',
    ]);
    const second = tripPages()[1]!;
    expect(second.calls).toContain(
      `or updated_at.gt.${STAMP},and(updated_at.eq.${STAMP},id.gt.${sid(3)})`
    );
    expect(second.calls.slice(-3)).toEqual(['order updated_at asc', 'order id asc', 'limit 3']);
    await expect(settings().get(HYDRATE_CURSOR_KEY)).resolves.toEqual({ updatedAt: STAMP, id: sid(5) });
  });

  test('three requests per page — trips, then its events and its reports in bulk — not one per trip', async () => {
    const tripRows = [1, 2, 3, 4, 5].map((n) => serverTrip(n, { updated_at: `2026-09-21T10:00:0${n}+00:00` }));
    supabase.tables = {
      trips: tripRows,
      trip_events: [1, 2, 3, 4, 5].map((n) => serverEvent(n, n)),
      event_disputes: [],
      score_daily: [],
      baselines: [],
    };
    await hydrator({ pageSize: 2 }).run({ full: true });

    // Pages of 2, 2 and 1: three pages, three requests each, plus the once-per-run reads.
    expect(countOf('trips')).toBe(3);
    expect(countOf('trip_events')).toBe(3);
    expect(countOf('event_disputes')).toBe(3);
    expect(countOf('score_daily')).toBe(1);
    expect(countOf('baselines')).toBe(1);
    const firstEvents = supabase.selects.find((s) => s.table === 'trip_events')!;
    expect(firstEvents.calls).toContain(`in trip_id ${sid(1)},${sid(2)}`);
  });

  test('the cursor moves only after its page commits, and the next run resumes there', async () => {
    supabase.tables = {
      trips: [1, 2, 3, 4].map((n) => serverTrip(n, { updated_at: `2026-09-21T10:00:0${n}+00:00` })),
    };
    // The engine starts a drive between the first page and the second page's commit.
    let tripReads = 0;
    supabase = createFakeSupabase({
      uid: UID,
      tables: supabase.tables,
      onSelect: (select) => {
        if (select.table !== 'trips') return null;
        tripReads += 1;
        if (tripReads === 2) busy = true;
        return null;
      },
    });
    const first = await hydrator({ pageSize: 2 }).run({ full: false });
    expect(first).toMatchObject({ trips: 2, complete: false });
    await expect(settings().get(HYDRATE_CURSOR_KEY)).resolves.toEqual({
      updatedAt: '2026-09-21T10:00:02+00:00',
      id: sid(2),
    });

    busy = false;
    const second = await hydrator({ pageSize: 2 }).run({ full: false });
    expect(second).toMatchObject({ trips: 2, complete: true });
    expect((await allTrips()).map((r) => r.client_trip_id).sort()).toEqual([
      'trip-1',
      'trip-2',
      'trip-3',
      'trip-4',
    ]);
    const resumed = tripPages()[2]!;
    expect(resumed.calls).toContain(
      `or updated_at.gt.2026-09-21T10:00:02+00:00,and(updated_at.eq.2026-09-21T10:00:02+00:00,id.gt.${sid(2)})`
    );
  });

  test('an event chunk that fills the row cap is read again from its last id', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => serverEvent(i + 1, 1));
    supabase.tables = { trips: [serverTrip(1)], trip_events: many };
    const result = await hydrator().run({ full: true });
    expect(result.events).toBe(1001);
    const eventReads = supabase.selects.filter((s) => s.table === 'trip_events');
    expect(eventReads).toHaveLength(2);
    expect(eventReads[1]!.calls).toContain(`gt id ${eid(1000)}`);
  });

  test('a row this build cannot read is skipped and does not hold the cursor back', async () => {
    supabase.tables = {
      trips: [serverTrip(1), serverTrip(2, { data_quality: 'Z' }), serverTrip(3, { client_trip_id: '../x' })],
    };
    const errors: string[] = [];
    const result = await hydrator({ onError: (_e, ctx) => errors.push(ctx) }).run({ full: true });
    expect(result).toMatchObject({ trips: 1, complete: true });
    expect(errors).toEqual(['hydrate trip', 'hydrate trip']);
    await expect(settings().get(HYDRATE_CURSOR_KEY)).resolves.toEqual({ updatedAt: STAMP, id: sid(3) });
  });

  test('a stored cursor that is not a timestamp and a uuid never reaches a filter', async () => {
    await settings().set(HYDRATE_CURSOR_KEY, { updatedAt: '2026),id.gt.(', id: 'x' });
    supabase.tables = { trips: [serverTrip(1)] };
    await hydrator().run({ full: false });
    const first = supabase.selects.find((s) => s.table === 'trips')!;
    expect(first.calls.some((c) => c.startsWith('or '))).toBe(false);
  });
});

describe('local work wins (R10)', () => {
  const local = (over: Partial<TripRow>) =>
    trips().insert(
      {
        client_trip_id: 'trip-1',
        started_at: NOW - 86_400_000,
        tz: 'UTC',
        status: 'provisional',
        score: 70,
        sync_state: 'synced',
        server_id: sid(1),
        ...over,
      },
      NOW - 86_400_000
    );

  test.each(['local', 'queued', 'uploading', 'failed'] as const)(
    'a %s local row is left exactly as it is',
    async (syncState) => {
      await local({ sync_state: syncState, server_id: null });
      supabase.tables = { trips: [serverTrip(1)] };
      const result = await hydrator().run({ full: true });
      expect(result).toMatchObject({ trips: 0, skippedLocal: 1, complete: true });
      expect(await trips().get('trip-1')).toMatchObject({ sync_state: syncState, score: 70 });
    }
  );

  test('a drive the driver deleted does not come back, before or after the server confirmed', async () => {
    // Before: the husk is still here, its delete queued.
    await local({ deleted_at: NOW - 1000, polyline: null });
    await createQueueRepo(db).enqueue('delete-trip', { action: 'delete', clientTripId: 'trip-1' }, 'delete:trip-1', NOW, undefined, UID);
    // After: the row is gone and only the settled item is left (a page fetched before the delete).
    await createQueueRepo(db).enqueue('delete-trip', { action: 'delete', clientTripId: 'trip-2' }, 'delete:trip-2', NOW, undefined, UID);
    const claimed = await createQueueRepo(db).nextDue(NOW, 10);
    for (const item of claimed) {
      if (item.idempotency_key === 'delete:trip-2') await createQueueRepo(db).markAttempt(item.id, true, null, NOW);
      else await createQueueRepo(db).release(item.id, NOW);
    }
    supabase.tables = { trips: [serverTrip(1), serverTrip(2, { id: sid(2) })] };

    const result = await hydrator().run({ full: true });
    expect(result).toMatchObject({ trips: 0, skippedLocal: 2, redeleted: 1 });
    expect(await trips().get('trip-1')).toMatchObject({ deleted_at: NOW - 1000, polyline: null });
    expect(await trips().get('trip-2')).toBeNull();
    // The server still had trip-2 live although its delete had settled: the delete goes again.
    expect(await createQueueRepo(db).byKey('delete:trip-2')).toMatchObject({
      status: 'pending',
      attempts: 0,
      owner_uid: UID,
    });
  });

  test('a synced trip with a pending role change or a report on one of its events is left alone', async () => {
    await local({});
    await trips().insert(
      { client_trip_id: 'trip-2', started_at: NOW, tz: 'UTC', status: 'provisional', score: 70, sync_state: 'synced', server_id: sid(2) },
      NOW - 86_400_000
    );
    await createEventsRepo(db).insert({ id: 'ev-9', client_trip_id: 'trip-2', category: 'speeding', started_at: NOW });
    await createQueueRepo(db).enqueue('set-role', { action: 'set-role', clientTripId: 'trip-1', role: 'passenger' }, 'role:trip-1:1', NOW, undefined, UID);
    await createQueueRepo(db).enqueue('dispute', { action: 'dispute', clientEventId: 'ev-9', reason: 'hazard' }, 'dispute:ev-9', NOW, undefined, UID);
    supabase.tables = { trips: [serverTrip(1), serverTrip(2)] };

    const result = await hydrator().run({ full: true });
    expect(result).toMatchObject({ trips: 0, skippedLocal: 2 });
    expect(await trips().get('trip-1')).toMatchObject({ score: 70 });
    expect(await trips().get('trip-2')).toMatchObject({ score: 70 });
  });

  test('a synced trip with nothing owed follows the server, keeping what only the device knows', async () => {
    await local({ start_label: 'Home', checkpoint_ts: 123 });
    await createEventsRepo(db).insert({
      id: 'ev-1',
      client_trip_id: 'trip-1',
      category: 'speeding',
      started_at: NOW,
      // A refusal the server never recorded (the window had closed): only the device has it.
      dispute_json: JSON.stringify({ reason: 'hazard', outcome: 'window_closed', code: 'dispute_window_closed', submittedAt: 1 }),
    });
    supabase.tables = { trips: [serverTrip(1, { score: 91 })], trip_events: [serverEvent(1, 1)] };

    const result = await hydrator().run({ full: false });
    expect(result).toMatchObject({ trips: 1, events: 1 });
    expect(await trips().get('trip-1')).toMatchObject({ score: 91, start_label: 'Home', checkpoint_ts: 123 });
    const [event] = await createEventsRepo(db).listByTrip('trip-1');
    expect(parseDispute(event!.dispute_json)?.outcome).toBe('window_closed');
  });

  test('a local row the runner rewrote while the page was in flight is not overwritten', async () => {
    await local({ updated_at: 0 } as Partial<TripRow>);
    supabase = createFakeSupabase({
      uid: UID,
      tables: { trips: [serverTrip(1, { score: 60 })] },
      onSelect: async (select) => {
        if (select.table === 'trips') await trips().update('trip-1', { score: 95 }, NOW + 5);
        return null;
      },
    });
    const result = await hydrator().run({ full: true });
    expect(result).toMatchObject({ trips: 0, skippedLocal: 1 });
    expect(await trips().get('trip-1')).toMatchObject({ score: 95 });
  });

  test('a day row the runner wrote after the run began is kept', async () => {
    supabase = createFakeSupabase({
      uid: UID,
      tables: { score_daily: [serverDay('2026-09-21', { long_term_score: 70 })] },
      onSelect: async (select) => {
        if (select.table === 'score_daily') {
          await createScoreDailyCacheRepo(db).put('2026-09-21', { day: '2026-09-21', longTermScore: 88 }, NOW + 1);
        }
        return null;
      },
    });
    const result = await hydrator().run({ full: true });
    expect(result.days).toBe(0);
    await expect(createScoreDailyCacheRepo(db).get('2026-09-21')).resolves.toMatchObject({
      payload: { longTermScore: 88 },
    });
  });
});

describe('fences: a device that changes hands never receives the previous driver data', () => {
  test('a session that is not the device owner restores nothing and asks for nothing', async () => {
    supabase.setUid(OTHER);
    supabase.tables = { trips: [serverTrip(1)] };
    const result = await hydrator().run({ full: true });
    expect(result).toMatchObject({ trips: 0, complete: false });
    expect(supabase.selects).toHaveLength(0);
    expect(await allTrips()).toEqual([]);
    expect(getHydrationStatus().state).toBe('failed');
  });

  test('a restore a drive paused stays "restoring", never reported as failed (final review M8)', async () => {
    supabase.tables = { trips: [serverTrip(1)] };
    setHydrationStatus({ state: 'restoring', restored: 0 });
    busy = true;
    const result = await hydrator().run({ full: true });
    expect(result.complete).toBe(false);
    expect(getHydrationStatus()).toEqual({ state: 'restoring', restored: 0 });
    setHydrationStatus({ state: 'idle' });
  });

  test('only a full run that reached the end marks the device restored', async () => {
    supabase.tables = { trips: [serverTrip(1)] };
    await hydrator().run({ full: false });
    await expect(settings().get(HYDRATE_RESTORED_AT_KEY)).resolves.toBeNull();
    busy = true;
    await hydrator().run({ full: true });
    await expect(settings().get(HYDRATE_RESTORED_AT_KEY)).resolves.toBeNull();
  });

  test('a session change mid-run writes nothing', async () => {
    supabase = createFakeSupabase({
      uid: UID,
      tables: { trips: [serverTrip(1)], trip_events: [serverEvent(1, 1)], score_daily: [serverDay('2026-09-02')] },
      onSelect: (select) => {
        if (select.table === 'trip_events') supabase.setUid(OTHER);
        return null;
      },
    });
    const result = await hydrator().run({ full: true });
    expect(result).toMatchObject({ trips: 0, events: 0, complete: false });
    expect(await allTrips()).toEqual([]);
    await expect(settings().get(HYDRATE_CURSOR_KEY)).resolves.toBeNull();
  });

  test('a wipe that lands while a page is in flight: the commit sees the new owner and writes nothing', async () => {
    supabase = createFakeSupabase({
      uid: UID,
      tables: { trips: [serverTrip(1)] },
      onSelect: async (select) => {
        // The handover's identity stage: the database emptied, the next owner recorded.
        if (select.table === 'trips') await settings().set(DEVICE_OWNER_KEY, OTHER);
        return null;
      },
    });
    const result = await hydrator().run({ full: true });
    expect(result.trips).toBe(0);
    expect(await allTrips()).toEqual([]);
  });

  test('stop() mid-run is awaitable, and nothing fetched before it is written after it', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    supabase = createFakeSupabase({
      uid: UID,
      tables: { trips: [serverTrip(1)] },
      onSelect: async (select) => {
        if (select.table === 'trips') await held;
        return null;
      },
    });
    const h = hydrator();
    const running = h.run({ full: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let stopped = false;
    const stopping = h.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    release();
    await stopping;
    await expect(running).resolves.toMatchObject({ trips: 0, complete: false });
    expect(await allTrips()).toEqual([]);
    // A stopped hydrator stays stopped.
    await expect(h.run({ full: true })).resolves.toMatchObject({ trips: 0 });
  });

  test('never commits while the engine is busy', async () => {
    busy = true;
    supabase.tables = { trips: [serverTrip(1)], score_daily: [serverDay('2026-09-02')] };
    const result = await hydrator().run({ full: true });
    expect(result).toMatchObject({ trips: 0, days: 0, complete: false });
    expect(await allTrips()).toEqual([]);
    await expect(createScoreDailyCacheRepo(db).latest()).resolves.toBeNull();
  });
});

describe('status and the incremental top-up', () => {
  test('a full run reports progress and ends idle; a failed one says so; an incremental one is silent', async () => {
    const seen: string[] = [];
    supabase = createFakeSupabase({
      uid: UID,
      tables: { trips: [serverTrip(1), serverTrip(2, { updated_at: '2026-09-21T10:00:01+00:00' })] },
      onSelect: () => {
        seen.push(JSON.stringify(getHydrationStatus()));
        return null;
      },
    });
    await hydrator({ pageSize: 1 }).run({ full: true });
    expect(seen).toContain(JSON.stringify({ state: 'restoring', restored: 0 }));
    expect(seen).toContain(JSON.stringify({ state: 'restoring', restored: 1 }));
    expect(getHydrationStatus()).toEqual({ state: 'idle' });

    const failing = createFakeSupabase({ uid: UID, onSelect: () => ({ message: 'offline' }) });
    const errors: string[] = [];
    const failed = await hydrator({ supabase: failing, onError: (_e, ctx) => errors.push(ctx) }).run({ full: true });
    expect(failed.complete).toBe(false);
    expect(getHydrationStatus()).toEqual({ state: 'failed', at: NOW });
    expect(errors).toEqual(['hydrate']);

    setHydrationStatus({ state: 'idle' });
    await hydrator({ supabase: createFakeSupabase({ uid: UID, onSelect: () => ({ message: 'offline' }) }) }).run({ full: false });
    expect(getHydrationStatus()).toEqual({ state: 'idle' });
  });

  test('an incremental run asks only for day rows changed since the last one it saw', async () => {
    supabase.tables = { score_daily: [serverDay('2026-09-02', { updated_at: '2026-09-21T09:00:00+00:00' })] };
    await hydrator().run({ full: true });
    await expect(settings().get(HYDRATE_DAYS_CURSOR_KEY)).resolves.toBe('2026-09-21T09:00:00+00:00');
    const fullRead = supabase.selects.find((s) => s.table === 'score_daily')!;
    expect(fullRead.calls).toEqual([`eq user_id ${UID}`, 'order day desc', 'limit 1000']);

    await hydrator().run({ full: false });
    const topUp = supabase.selects.filter((s) => s.table === 'score_daily')[1]!;
    expect(topUp.calls).toEqual([
      `eq user_id ${UID}`,
      'gte updated_at 2026-09-21T09:00:00+00:00',
      'order updated_at asc',
      'limit 1000',
    ]);
  });

  test('two runs asked for at once share one', async () => {
    supabase.tables = { trips: [serverTrip(1)] };
    const h = hydrator();
    const [a, b] = await Promise.all([h.run({ full: true }), h.run({ full: true })]);
    expect(a).toBe(b);
    expect(countOf('trips')).toBe(1);
  });
});

describe('the seam', () => {
  test('the real supabase-js builder has every call the hydrator makes, and encodes the keyset filter', () => {
    const client = createClient('http://127.0.0.1:54321', 'anon-key', {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const seam = hydrateSeam(client);
    const query = seam
      .from('trips')
      .select('id,updated_at')
      .eq('user_id', UID)
      .is('deleted_at', null)
      .or(`updated_at.gt.${STAMP},and(updated_at.eq.${STAMP},id.gt.${sid(3)})`)
      .order('updated_at')
      .order('id')
      .limit(3);
    for (const method of ['eq', 'is', 'in', 'or', 'gt', 'gte', 'order', 'limit', 'then'] as const) {
      expect(typeof query[method]).toBe('function');
    }
    const url = (query as unknown as { url: URL }).url;
    expect(url.pathname).toBe('/rest/v1/trips');
    expect(url.searchParams.get('user_id')).toBe(`eq.${UID}`);
    expect(url.searchParams.get('deleted_at')).toBe('is.null');
    expect(url.searchParams.get('or')).toBe(
      `(updated_at.gt.${STAMP},and(updated_at.eq.${STAMP},id.gt.${sid(3)}))`
    );
    expect(url.searchParams.get('order')).toBe('updated_at.asc,id.asc');
    expect(url.searchParams.get('limit')).toBe('3');
    // The '+' of the offset survives encoding rather than turning into a space.
    expect(url.toString()).toContain('%2B00%3A00');
  });
});

describe('fix round 1', () => {
  test('I1: an interrupted full restore resumes where it stopped, not from page one', async () => {
    supabase.tables = {
      trips: [1, 2, 3, 4, 5, 6, 7].map((n) => serverTrip(n, { updated_at: `2026-09-21T10:00:0${n}+00:00` })),
    };
    let pages = 0;
    supabase = createFakeSupabase({
      uid: UID,
      tables: supabase.tables,
      onSelect: (select) => {
        if (select.table === 'trips' && select.columns !== LISTING) {
          pages += 1;
          // A drive starts while page 3 is loading: its commit is refused.
          if (pages === 3) busy = true;
        }
        return null;
      },
    });
    const first = await hydrator({ pageSize: 2 }).run({ full: true });
    expect(first).toMatchObject({ trips: 4, complete: false });

    busy = false;
    const before = tripPages().length;
    const second = await hydrator({ pageSize: 2 }).run({ full: true });
    expect(second).toMatchObject({ trips: 3, complete: true });
    // Pages 3 (two trips) and 4 (one) only: the four committed trips are not fetched again.
    expect(tripPages().length - before).toBe(2);
    expect(tripPages()[before]!.calls).toContain(
      `or updated_at.gt.2026-09-21T10:00:04+00:00,and(updated_at.eq.2026-09-21T10:00:04+00:00,id.gt.${sid(4)})`
    );
    expect((await allTrips())).toHaveLength(7);
  });

  test('M-5: a response that does not advance the cursor ends the run instead of looping', async () => {
    supabase.tables = { trips: [serverTrip(1), serverTrip(2)] };
    // A server that ignores the keyset filter answers every page with the same two rows.
    const base = supabase;
    const ignoringOr = (q: HydrateQuery): HydrateQuery => {
      const wrapped: HydrateQuery = {
        eq: (c, v) => ignoringOr(q.eq(c, v)),
        is: (c, v) => ignoringOr(q.is(c, v)),
        in: (c, v) => ignoringOr(q.in(c, v)),
        or: () => wrapped,
        gt: (c, v) => ignoringOr(q.gt(c, v)),
        gte: (c, v) => ignoringOr(q.gte(c, v)),
        order: (c, o) => ignoringOr(q.order(c, o)),
        limit: (n) => ignoringOr(q.limit(n)),
        then: (a, b) => q.then(a, b),
      };
      return wrapped;
    };
    const broken: HydrateSupabase = {
      auth: base.auth,
      from: (table) => ({ select: (columns) => ignoringOr(base.from(table).select(columns)) }),
    };
    const errors: string[] = [];
    const result = await hydrator({ supabase: broken, pageSize: 2, onError: (_e, ctx) => errors.push(ctx) }).run({
      full: false,
    });
    expect(result.complete).toBe(false);
    expect(errors).toEqual(['hydrate']);
    expect(countOf('trips')).toBe(2);
  });

  describe('I-1: a drive deleted on another device leaves this one too', () => {
    test('a restored trip deleted elsewhere disappears at the next reconciliation, trace and all', async () => {
      supabase.tables = { trips: [serverTrip(1), serverTrip(2)], trip_events: [serverEvent(1, 1)] };
      const removedFiles: string[] = [];
      const fs = { remove: async (path: string) => void removedFiles.push(path) };
      await hydrator({ fs }).run({ full: true });
      expect(await allTrips()).toHaveLength(2);

      // Device A deletes trip-1: the server hides it from its owner from now on.
      supabase.tables.trips = [serverTrip(2)];
      const clock = NOW + RECONCILE_INTERVAL_MS;
      const result = await hydrator({ fs, now: () => clock }).run({ full: false });
      expect(result).toMatchObject({ removed: 1, complete: true });
      expect(await trips().get('trip-1')).toBeNull();
      expect(await createEventsRepo(db).listByTrip('trip-1')).toEqual([]);
      expect(await trips().get('trip-2')).not.toBeNull();
      expect(removedFiles).toEqual(['trip-1.bin.gz']);
      // Nothing is owed to the server: it already did the delete.
      expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
    });

    test('a drive the runner synced while the ids were being listed is not removed', async () => {
      supabase = createFakeSupabase({
        uid: UID,
        tables: { trips: [serverTrip(1)] },
        onSelect: async (select) => {
          if (select.columns !== LISTING) return null;
          // The runner applies a finalize answer mid-listing: a new synced drive the list
          // cannot contain yet.
          await trips().insert(
            { client_trip_id: 'fresh', started_at: NOW, tz: 'UTC', status: 'provisional', score: 90, sync_state: 'synced', server_id: sid(99) },
            NOW + 5
          );
          return null;
        },
      });
      const result = await hydrator().run({ full: true });
      expect(result.removed).toBe(0);
      expect(await trips().get('fresh')).not.toBeNull();
    });

    test('an incomplete listing removes nothing', async () => {
      supabase.tables = { trips: [serverTrip(1), serverTrip(2)] };
      await hydrator().run({ full: true });
      await settings().remove(HYDRATE_RECONCILED_AT_KEY);
      supabase = createFakeSupabase({
        uid: UID,
        tables: { trips: [serverTrip(2)] },
        onSelect: (select) => (select.columns === LISTING ? { message: 'network' } : null),
      });
      const errors: string[] = [];
      const result = await hydrator({ onError: (_e, ctx) => errors.push(ctx) }).run({ full: false });
      expect(result.removed).toBe(0);
      expect(await trips().get('trip-1')).not.toBeNull();
      expect(errors).toEqual(['hydrate reconcile']);
      // Not recorded as done, so the next run tries again.
      await expect(settings().get(HYDRATE_RECONCILED_AT_KEY)).resolves.toBeNull();
    });

    test('a drive with local work pending, or never synced, is untouched', async () => {
      supabase.tables = { trips: [serverTrip(1), serverTrip(2)] };
      await hydrator().run({ full: true });
      // trip-1: synced but a role change is still owed. trip-9: recorded here, upload pending.
      await createQueueRepo(db).enqueue('set-role', { action: 'set-role', clientTripId: 'trip-1', role: 'passenger' }, 'role:trip-1:1', NOW, undefined, UID);
      await trips().insert({ client_trip_id: 'trip-9', started_at: NOW, tz: 'UTC', status: 'provisional', score: 80, sync_state: 'queued' }, NOW);
      supabase.tables.trips = [];
      const result = await hydrator().run({ full: true });
      expect(result.removed).toBe(1);
      expect(await trips().get('trip-1')).not.toBeNull();
      expect(await trips().get('trip-9')).toMatchObject({ sync_state: 'queued' });
      expect(await trips().get('trip-2')).toBeNull();
    });

    test('outside a full restore it lists ids at most once a day', async () => {
      supabase.tables = { trips: [serverTrip(1)] };
      await hydrator().run({ full: true });
      const idListings = () => supabase.selects.filter((s) => s.columns === LISTING).length;
      // One page, then the empty page that proves it was the last.
      expect(idListings()).toBe(2);
      await hydrator({ now: () => NOW + 6 * 3600 * 1000 }).run({ full: false });
      expect(idListings()).toBe(2);
      await hydrator({ now: () => NOW + RECONCILE_INTERVAL_MS }).run({ full: false });
      expect(idListings()).toBe(4);
    });
  });

  describe('M-2: a delete this device made is never undone by a restore', () => {
    test('a tombstoned drive the server still holds is skipped and its delete queued again', async () => {
      await addTombstone(db, 'trip-1');
      supabase.tables = { trips: [serverTrip(1)] };
      const result = await hydrator().run({ full: true });
      expect(result).toMatchObject({ trips: 0, redeleted: 1 });
      expect(await trips().get('trip-1')).toBeNull();
      const item = await createQueueRepo(db).byKey('delete:trip-1');
      expect(item).toMatchObject({ kind: 'delete-trip', status: 'pending', owner_uid: UID });
      expect(JSON.parse(item!.payload_json)).toEqual({ action: 'delete', clientTripId: 'trip-1' });
    });

    test('a delete that gave up is left for the driver to retry, and the drive stays away', async () => {
      await createQueueRepo(db).enqueue('delete-trip', { action: 'delete', clientTripId: 'trip-1' }, 'delete:trip-1', NOW, undefined, UID);
      const [item] = await createQueueRepo(db).nextDue(NOW, 1);
      await createQueueRepo(db).markAttempt(item!.id, false, 'x', NOW);
      await createQueueRepo(db).markFailed(item!.id, 'x');
      supabase.tables = { trips: [serverTrip(1)] };
      const result = await hydrator().run({ full: true });
      expect(result).toMatchObject({ trips: 0, redeleted: 0, skippedLocal: 1 });
      expect(await createQueueRepo(db).byKey('delete:trip-1')).toMatchObject({ status: 'failed' });
    });

    test('the tombstone outlives the queue item', async () => {
      await addTombstone(db, 'trip-7');
      await expect(readTombstones(db)).resolves.toEqual(new Set(['trip-7']));
      await addTombstone(db, 'trip-7');
      await expect(readTombstones(db)).resolves.toEqual(new Set(['trip-7']));
    });
  });

  test('I2: a restore announces its writes every few pages, not after every page', async () => {
    const events = jest.requireActual<typeof import('@/data/events')>('@/data/events');
    const spy = jest.spyOn(events, 'emitDataChanged');
    try {
      supabase.tables = {
        trips: Array.from({ length: 12 }, (_, i) =>
          serverTrip(i + 1, { updated_at: `2026-09-21T10:00:${String(i + 10)}+00:00` })
        ),
      };
      await hydrator({ pageSize: 1 }).run({ full: true });
      const hydrateEmits = spy.mock.calls.filter(([change]) => change.source === 'hydrate').length;
      // Twelve pages: at pages 5 and 10, then once at the end.
      expect(hydrateEmits).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  test('M2: with auth events to listen to, the session is re-read once per commit, not per await', async () => {
    supabase = createFakeSupabase({
      uid: UID,
      authEvents: true,
      tables: {
        trips: [1, 2, 3, 4].map((n) => serverTrip(n, { updated_at: `2026-09-21T10:00:0${n}+00:00` })),
        trip_events: [1, 2, 3, 4].map((n) => serverEvent(n, n)),
      },
    });
    await hydrator({ pageSize: 1 }).run({ full: true });
    // One read to start, one to open the run, then one per commit (days, 4 pages, the empty
    // last page commits nothing, the marker, the reconciliation) — far fewer than one per await.
    expect(supabase.sessions).toBeLessThanOrEqual(10);
    expect(await allTrips()).toHaveLength(4);
  });

  test('M2: a session change announced mid-run still writes nothing', async () => {
    supabase = createFakeSupabase({
      uid: UID,
      authEvents: true,
      tables: { trips: [serverTrip(1)], trip_events: [serverEvent(1, 1)] },
      onSelect: (select) => {
        if (select.table === 'trip_events') supabase.setUid(OTHER);
        return null;
      },
    });
    const result = await hydrator().run({ full: true });
    expect(result.trips).toBe(0);
    expect(await allTrips()).toEqual([]);
  });

  test('M1: one statement per event, and an id another trip owns is never re-parented', async () => {
    await trips().insert({ client_trip_id: 'mine', started_at: NOW, tz: 'UTC', status: 'provisional', score: 80, sync_state: 'queued' }, NOW);
    await createEventsRepo(db).insert({ id: 'ev-1', client_trip_id: 'mine', category: 'braking', started_at: NOW });
    supabase.tables = { trips: [serverTrip(1)], trip_events: [serverEvent(1, 1), serverEvent(2, 1)] };
    const result = await hydrator().run({ full: true });
    expect(result.events).toBe(1);
    expect(await createEventsRepo(db).get('ev-1')).toMatchObject({ client_trip_id: 'mine', category: 'braking' });
    expect(await createEventsRepo(db).get('ev-2')).toMatchObject({ client_trip_id: 'trip-1' });
  });
});

describe('fix round 2 (re-audit R-I1): the live listing ends only on an empty page', () => {
  const five = () => [1, 2, 3, 4, 5].map((n) => serverTrip(n, { updated_at: `2026-09-21T10:00:0${n}+00:00` }));

  async function restoreFive() {
    supabase.tables = { trips: five() };
    await hydrator().run({ full: true });
    expect(await allTrips()).toHaveLength(5);
  }

  test('a page shorter than the row cap in mid-list does not end the listing', async () => {
    await restoreFive();
    // The server's max_rows is 2: every response is silently cut to two rows.
    supabase = createFakeSupabase({ uid: UID, tables: { trips: five() }, maxRows: 2 });
    const result = await hydrator({ now: () => NOW + RECONCILE_INTERVAL_MS }).run({ full: false });
    expect(result.removed).toBe(0);
    expect(await allTrips()).toHaveLength(5);
    // Pages of 2, 2 and 1, then the empty page that ends it.
    expect(supabase.selects.filter((s) => s.columns === LISTING)).toHaveLength(4);
  });

  test('a listing that errors after a short page removes nothing', async () => {
    await restoreFive();
    let listings = 0;
    supabase = createFakeSupabase({
      uid: UID,
      tables: { trips: five() },
      maxRows: 2,
      onSelect: (select) => {
        if (select.columns !== LISTING) return null;
        listings += 1;
        return listings === 2 ? { message: 'network' } : null;
      },
    });
    const result = await hydrator({ now: () => NOW + RECONCILE_INTERVAL_MS, onError: () => undefined }).run({
      full: false,
    });
    expect(result.removed).toBe(0);
    expect(await allTrips()).toHaveLength(5);
  });

  test('an out-of-order page leaves the listing incomplete', async () => {
    await restoreFive();
    // A server that ignores the keyset answers every listing page with the same rows.
    const base = createFakeSupabase({ uid: UID, tables: { trips: five() }, maxRows: 2 });
    const noGt = (q: HydrateQuery): HydrateQuery => {
      const w: HydrateQuery = {
        eq: (c, v) => noGt(q.eq(c, v)),
        is: (c, v) => noGt(q.is(c, v)),
        in: (c, v) => noGt(q.in(c, v)),
        or: (f) => noGt(q.or(f)),
        gt: () => w,
        gte: (c, v) => noGt(q.gte(c, v)),
        order: (c, o) => noGt(q.order(c, o)),
        limit: (n) => noGt(q.limit(n)),
        then: (a, b) => q.then(a, b),
      };
      return w;
    };
    const broken: HydrateSupabase = {
      auth: base.auth,
      from: (table) => ({ select: (columns) => noGt(base.from(table).select(columns)) }),
    };
    supabase = base;
    const result = await hydrator({ supabase: broken, now: () => NOW + RECONCILE_INTERVAL_MS }).run({ full: false });
    expect(result.removed).toBe(0);
    expect(await allTrips()).toHaveLength(5);
    await expect(settings().get(HYDRATE_RECONCILED_AT_KEY)).resolves.toBe(NOW);
  });

  test('self-heal: a live drive missing here, behind the cursor, is fetched again with its events', async () => {
    supabase.tables = { trips: five(), trip_events: [serverEvent(1, 1)] };
    await hydrator().run({ full: true });
    // Removed earlier by mistake: no incremental restore will ever meet it again.
    await trips().remove('trip-1');
    const result = await hydrator({ now: () => NOW + RECONCILE_INTERVAL_MS }).run({ full: false });
    expect(result).toMatchObject({ refetched: 1, removed: 0 });
    expect(await trips().get('trip-1')).toMatchObject({ sync_state: 'synced', server_id: sid(1) });
    expect((await createEventsRepo(db).listByTrip('trip-1')).map((e) => e.id)).toEqual(['ev-1']);
  });

  test('self-heal never fetches a drive this device deleted', async () => {
    supabase.tables = { trips: five() };
    await hydrator().run({ full: true });
    await trips().remove('trip-1');
    await addTombstone(db, 'trip-1');
    const before = tripPages().length;
    const result = await hydrator({ now: () => NOW + RECONCILE_INTERVAL_MS }).run({ full: false });
    expect(result.refetched).toBe(0);
    expect(await trips().get('trip-1')).toBeNull();
    // Only the (empty) incremental page: no fetch by id.
    expect(tripPages().slice(before).some((s) => s.calls.some((c) => c.startsWith('in id')))).toBe(false);
  });
});

describe('fix round 3', () => {
  const five = () => [1, 2, 3, 4, 5].map((n) => serverTrip(n, { updated_at: `2026-09-21T10:00:0${n}+00:00` }));

  test("E2 delete hook: a drive removed by reconciliation stops counting in the role prior", async () => {
    supabase.tables = { trips: five() };
    await hydrator().run({ full: true });
    const neutral = await readRolePrior(db);
    await recordRoleAnswer(db, 'passenger', { start: '9q8yy', end: '9q8yz' }, 'trip-1');
    expect(await readRolePrior(db)).not.toBe(neutral);

    supabase.tables.trips = five().slice(1);
    const result = await hydrator({ now: () => NOW + RECONCILE_INTERVAL_MS }).run({ full: false });
    expect(result.removed).toBe(1);
    expect(await readRolePrior(db)).toBe(neutral);
    await expect(settings().get(roleAnswerKey('trip-1'))).resolves.toBeNull();
  });

  test("security review D2 R1-M1: a drive removed by reconciliation takes its failed reports and role answers with it", async () => {
    supabase.tables = { trips: five(), trip_events: [serverEvent(1, 1)] };
    await hydrator().run({ full: true });
    const queue = createQueueRepo(db);
    // Gave up earlier; `failed` work does not hold the removal back.
    await queue.enqueue('dispute', { action: 'dispute', clientEventId: 'ev-1', reason: 'hazard', note: 'private words' }, 'dispute:ev-1', NOW, undefined, UID);
    await queue.enqueue('set-role', { action: 'set-role', clientTripId: 'trip-1', role: 'passenger' }, 'role:trip-1:9', NOW, undefined, UID);
    await db.execute("UPDATE sync_queue SET status = 'failed', attempts = 20, next_attempt_at = ?", [Number.MAX_SAFE_INTEGER]);
    // Another drive's report stays.
    await queue.enqueue('set-role', { action: 'set-role', clientTripId: 'trip-2', role: 'driver' }, 'role:trip-2:9', NOW, undefined, UID);
    await db.execute("UPDATE sync_queue SET status = 'failed' WHERE idempotency_key = 'role:trip-2:9'");

    supabase.tables.trips = five().slice(1);
    const result = await hydrator({ now: () => NOW + RECONCILE_INTERVAL_MS }).run({ full: false });

    expect(result.removed).toBe(1);
    const { rows } = await db.execute('SELECT idempotency_key FROM sync_queue ORDER BY idempotency_key');
    expect(rows.map((r) => r.idempotency_key)).toEqual(['role:trip-2:9']);
  });

  test('R2-M1: a self-heal cut short is not recorded, so the next run heals without waiting a day', async () => {
    supabase.tables = { trips: five() };
    await hydrator().run({ full: true });
    await trips().remove('trip-1');
    await trips().remove('trip-2');
    // A drive starts as the heal fetches the first missing drive by id.
    supabase = createFakeSupabase({
      uid: UID,
      tables: { trips: five() },
      onSelect: (select) => {
        if (select.calls.some((c) => c.startsWith('in id'))) busy = true;
        return null;
      },
    });
    const later = NOW + RECONCILE_INTERVAL_MS;
    const cut = await hydrator({ now: () => later }).run({ full: false });
    expect(cut.refetched).toBe(0);
    await expect(settings().get(HYDRATE_RECONCILED_AT_KEY)).resolves.toBe(NOW);

    // Minutes later, not a day: the pass is still due, and heals.
    busy = false;
    supabase = createFakeSupabase({ uid: UID, tables: { trips: five() } });
    const healed = await hydrator({ now: () => later + 60_000 }).run({ full: false });
    expect(healed.refetched).toBe(2);
    await expect(settings().get(HYDRATE_RECONCILED_AT_KEY)).resolves.toBe(later + 60_000);
  });

  test('N2: a live trip this build cannot read is fetched by the self-heal once, not every day', async () => {
    const broken = serverTrip(9, { data_quality: 'Z' });
    supabase.tables = { trips: [...five(), broken] };
    await hydrator({ onError: () => undefined }).run({ full: true });
    await expect(settings().get(HYDRATE_UNREADABLE_KEY)).resolves.toEqual({
      version: UNREADABLE_VERSION,
      build: UNKNOWN_BUILD,
      ids: { [sid(9)]: NOW },
    });
    const idFetches = () => supabase.selects.filter((s) => s.calls.some((c) => c.startsWith('in id'))).length;
    const before = idFetches();
    await hydrator({ now: () => NOW + RECONCILE_INTERVAL_MS, onError: () => undefined }).run({ full: false });
    await hydrator({ now: () => NOW + 2 * RECONCILE_INTERVAL_MS, onError: () => undefined }).run({ full: false });
    expect(idFetches() - before).toBe(0);
  });
});

describe('fix round 4 (security R3-M1): the unreadable list cannot hide a live drive for good', () => {
  const five = () => [1, 2, 3, 4, 5].map((n) => serverTrip(n, { updated_at: `2026-09-21T10:00:0${n}+00:00` }));
  const broken = () => serverTrip(9, { data_quality: 'Z' });
  const idFetches = () =>
    supabase.selects.filter((s) => s.calls.some((c) => c.startsWith(`in id ${sid(9)}`))).length;

  async function recordBroken(buildId: () => Promise<string>) {
    supabase.tables = { trips: [...five(), broken()] };
    await hydrator({ buildId, onError: () => undefined }).run({ full: true });
  }

  test('a new app build releases the list: the row is fetched again', async () => {
    await recordBroken(async () => '2.0.0:update-a');
    const before = idFetches();
    await hydrator({
      buildId: async () => '2.0.0:update-b',
      now: () => NOW + RECONCILE_INTERVAL_MS,
      onError: () => undefined,
    }).run({ full: false });
    expect(idFetches() - before).toBe(1);
  });

  test('the same build keeps skipping it until 30 days have passed, then fetches it again', async () => {
    const buildId = async () => '2.0.0:update-a';
    await recordBroken(buildId);
    const before = idFetches();
    await hydrator({ buildId, now: () => NOW + RECONCILE_INTERVAL_MS, onError: () => undefined }).run({ full: false });
    expect(idFetches() - before).toBe(0);
    await hydrator({ buildId, now: () => NOW + UNREADABLE_TTL_MS, onError: () => undefined }).run({ full: false });
    expect(idFetches() - before).toBe(1);
  });

  test('without expo-updates (Jest, a development build) the build is a fixed id, never a crash', async () => {
    const { appBuildId } = jest.requireActual<typeof import('@/data/hydrate/build')>('@/data/hydrate/build');
    await expect(appBuildId()).resolves.toEqual(expect.any(String));
  });
});
