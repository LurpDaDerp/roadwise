/**
 * Restoring a driver's history from the server (M3 plan R10; M2 final review, M3 note 1).
 *
 * Every screen reads local SQLite and nothing else. Since M2, a device that changes hands is
 * wiped (correctly, on privacy grounds), and a reinstall starts empty — so without this the
 * driver's whole history is gone from their point of view while the server holds all of it. The
 * hydrator reads it back: `trips`, `trip_events`, `event_disputes`, `score_daily` and `baselines`,
 * over the owner-only `select` policies migration 0002 already grants. No server function, no new
 * privilege: the client reads exactly what RLS lets the signed-in user read, and additionally
 * filters every request on its own uid.
 *
 * **What it must never undo** (the M2 guarantees):
 * 1. *A deleted drive does not come back.* The server hides a soft-deleted trip from its owner
 *    (`deleted_at is null` in the policy, and in every request here). On the device, a trip whose
 *    row carries `deleted_at`, or whose `delete:<id>` queue item exists in any state, is never
 *    written — the item is the tombstone for the day the settled row survives.
 * 2. *A device that changed hands never receives the previous driver's data.* A run starts only
 *    when the session user is the device's recorded owner; after every await the generation and
 *    the session are checked again; and every commit asserts, inside its own transaction, that the
 *    device still records that owner. The wipe rewrites that record, so a page fetched for the
 *    previous owner writes nothing into the next owner's database.
 * 3. *Local work still owed to the server wins.* A server trip is skipped when the local row is
 *    `local | queued | uploading | failed`, is deleted or still recording, or has a `pending |
 *    inflight` queue item (its finalize, trace, role change, delete, or a report on one of its
 *    events); also when the local row changed after the page was requested — the runner applied
 *    a fresher answer in between.
 *
 * **Additive.** A server-side deletion is not propagated: the only delete path is this device's
 * own, and it already removed the rows.
 *
 * **Paging (review I19).** Trips are read in keyset order on `(updated_at, id)` — `updated_at`
 * alone would drop the rest of a tie group that straddles a page boundary, and `touch_updated_at`
 * stamps every row of one statement with the same transaction time. The cursor is the last row's
 * pair, kept exactly as the server wrote it, and it moves only after the page has committed. Each
 * page's events and disputes are fetched with `in(...)` (chunked at 100 ids): three requests per
 * page, not two per trip. `score_daily` and `baselines` are read once per run.
 *
 * **Never while the engine is busy.** A commit competes for SQLite's one write lock with the 1 Hz
 * recorder; `isBusy()` is asked before every commit, and a busy engine ends the run where it is
 * (the cursor already names the last committed page, so the next run resumes there).
 */
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { emitDataChanged } from '@/data/events';
import { setHydrationStatus } from '@/data/hydrate/status';
import { BASELINE_SETTING_KEY } from '@/data/queries/hooks';
import { deviceOwnerIs } from '@/data/sync/queue';

import {
  BASELINE_COLUMNS,
  DAY_COLUMNS,
  DISPUTE_COLUMNS,
  EVENT_COLUMNS,
  isUuid,
  parseRow,
  ServerBaselineSchema,
  ServerDaySchema,
  ServerDisputeSchema,
  ServerEventSchema,
  ServerTripSchema,
  TimestampText,
  toDayRow,
  toDisputeRecord,
  toEventRow,
  toStoredBaseline,
  toTripFields,
  TRIP_COLUMNS,
  type ServerDispute,
  type ServerEvent,
  type ServerTrip,
} from './map';

/** Settings key: where incremental runs resume — the last committed trip's `(updated_at, id)`. */
export const HYDRATE_CURSOR_KEY = 'hydrate.cursor';
/** Settings key: the newest `score_daily.updated_at` restored, for the incremental day top-up. */
export const HYDRATE_DAYS_CURSOR_KEY = 'hydrate.daysCursor';
/**
 * Settings key: when a full restore last reached the end (epoch ms). Absent on a device that has
 * never completed one — which is what makes the next foreground owe a full run. The wipe clears it.
 */
export const HYDRATE_RESTORED_AT_KEY = 'hydrate.restoredAt';
/** How often the foreground top-up may run (H2 registers it with `runWhenForeground`). */
export const HYDRATE_INTERVAL_MS = 6 * 3600 * 1000;
/** Trips per page. Small enough that one page's events fit well inside PostgREST's row cap. */
export const DEFAULT_PAGE_SIZE = 50;
/** Ids per `in(...)` filter: keeps the request URL a few kilobytes long. */
export const IN_CHUNK = 100;
/**
 * Rows per events or disputes request. PostgREST caps a response (1000 by default on Supabase)
 * without saying so, so a chunk that fills this is read again from its last id rather than
 * trusted to be complete.
 */
export const CHILD_LIMIT = 1000;
/** Newest day rows a run reads; ~3 years of daily driving, more than any screen looks back. */
export const DAY_LIMIT = 1000;

export interface HydrateCursor {
  updatedAt: string;
  id: string;
}

export interface HydrateResult {
  /** Trips written (inserted or refreshed). */
  trips: number;
  events: number;
  days: number;
  /** Server trips left alone because the device holds newer or unfinished work for them. */
  skippedLocal: number;
  /** The server's baseline medians were stored. */
  baseline: boolean;
  /** The run reached the end of the server's rows; false when it stopped early for any reason. */
  complete: boolean;
}

export interface Hydrator {
  run(opts: { full: boolean }): Promise<HydrateResult>;
  /** Ends this hydrator's lifetime; settles when a run in flight has stopped. Nothing it fetched is written after this returns. */
  stop(): Promise<void>;
}

/** What one PostgREST request answers. */
export interface HydrateResponse {
  data: unknown[] | null;
  error: unknown;
}

/**
 * The PostgREST filter builder, narrowed to the calls the restore makes. Structural, so the real
 * client fits and a test double needs nothing else.
 */
export interface HydrateQuery extends PromiseLike<HydrateResponse> {
  eq(column: string, value: string): HydrateQuery;
  is(column: string, value: null): HydrateQuery;
  in(column: string, values: readonly string[]): HydrateQuery;
  or(filters: string): HydrateQuery;
  gt(column: string, value: string): HydrateQuery;
  gte(column: string, value: string): HydrateQuery;
  order(column: string, options?: { ascending?: boolean }): HydrateQuery;
  limit(count: number): HydrateQuery;
}

export type HydrateTable = 'trips' | 'trip_events' | 'event_disputes' | 'score_daily' | 'baselines';

export interface HydrateSupabase {
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string } } | null } }>;
  };
  from(table: HydrateTable): { select(columns: string): HydrateQuery };
}

/**
 * The minimum the real client offers: `auth` and a `from(table).select(columns)` whose result is a
 * PostgREST builder. Deliberately untyped past that point — see `hydrateSeam`.
 */
export interface PostgrestClientLike {
  auth: HydrateSupabase['auth'];
  from(table: HydrateTable): { select(columns: string): unknown };
}

/**
 * The app client, narrowed to the hydrator's seam.
 *
 * The generated client resolves every `select`/`eq`/`in` against the schema's types, which the
 * structural seam cannot spell (TypeScript gives up instantiating the select-string parser for an
 * arbitrary `string`). The builder `select` returns at runtime is exactly the thenable filter
 * builder `HydrateQuery` describes; `hydrate.test.ts` builds one from the real `supabase-js` client
 * and checks both the methods and the request it encodes.
 */
export function hydrateSeam(client: PostgrestClientLike): HydrateSupabase {
  return {
    auth: client.auth,
    from: (table) => ({
      select: (columns) => client.from(table).select(columns) as HydrateQuery,
    }),
  };
}

export interface HydratorDeps {
  db: Db;
  supabase: HydrateSupabase;
  now: () => number;
  /** True while the engine is recording or finalizing: nothing is committed then. */
  isBusy: () => boolean;
  pageSize?: number;
  onError?: (e: unknown, ctx: string) => void;
}

/** Thrown to end a run quietly: the device changed hands, the hydrator stopped, or the engine is busy. */
class Halt extends Error {
  constructor(readonly why: 'fenced' | 'busy') {
    super(`hydration halted: ${why}`);
    this.name = 'Halt';
  }
}

/** A request PostgREST answered with an error. */
export class HydrateRequestError extends Error {
  constructor(
    readonly table: HydrateTable,
    readonly reason: unknown
  ) {
    super(`hydration request to ${table} failed`);
    this.name = 'HydrateRequestError';
  }
}

const emptyResult = (): HydrateResult => ({
  trips: 0,
  events: 0,
  days: 0,
  skippedLocal: 0,
  baseline: false,
  complete: false,
});

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A stored cursor, or null when there is none or it is not one this build wrote. */
function readCursor(value: unknown): HydrateCursor | null {
  if (typeof value !== 'object' || value === null) return null;
  const { updatedAt, id } = value as Record<string, unknown>;
  if (typeof updatedAt !== 'string' || typeof id !== 'string') return null;
  // Both values are interpolated into a PostgREST filter: only a timestamp and a uuid may pass.
  if (!TimestampText.safeParse(updatedAt).success || !isUuid(id)) return null;
  return { updatedAt, id };
}

/** Queue items still owed, and the trips they concern. */
const PENDING_ITEMS_SQL =
  "SELECT kind, payload_json FROM sync_queue WHERE status IN ('pending', 'inflight')";

/** Trip ids named by pending work, resolved on `tx` so the check and the write agree. */
async function tripsWithPendingWork(tx: Db): Promise<Set<string>> {
  const ids = new Set<string>();
  const eventIds: string[] = [];
  const { rows } = await tx.execute(PENDING_ITEMS_SQL);
  for (const row of rows) {
    let body: unknown;
    try {
      body = JSON.parse(String(row.payload_json));
    } catch {
      continue;
    }
    if (typeof body !== 'object' || body === null) continue;
    const { clientTripId, clientEventId } = body as Record<string, unknown>;
    if (typeof clientTripId === 'string') ids.add(clientTripId);
    if (typeof clientEventId === 'string') eventIds.push(clientEventId);
  }
  for (const group of chunks(eventIds, IN_CHUNK)) {
    const marks = group.map(() => '?').join(',');
    const found = await tx.execute(
      `SELECT DISTINCT client_trip_id FROM trip_events WHERE id IN (${marks})`,
      group
    );
    for (const row of found.rows) ids.add(String(row.client_trip_id));
  }
  return ids;
}

export function createHydrator(deps: HydratorDeps): Hydrator {
  const { db, supabase, now, isBusy } = deps;
  const pageSize = Math.max(1, deps.pageSize ?? DEFAULT_PAGE_SIZE);
  const report = (error: unknown, context: string): void => deps.onError?.(error, context);
  const settings = createSettingsRepo(db);

  let generation = 0;
  /** A stopped hydrator stays stopped: its runtime is being torn down. */
  let stopped = false;
  let inFlight: Promise<HydrateResult> | null = null;

  async function sessionUid(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  }

  /**
   * One run's fence: the hydrator still in the lifetime the run began in, and the session still
   * the user it began for. Called after every await.
   */
  function fenceFor(of: number, uid: string) {
    return async (): Promise<void> => {
      if (of !== generation) throw new Halt('fenced');
      const current = await sessionUid();
      if (of !== generation || current !== uid) throw new Halt('fenced');
    };
  }

  async function request(table: HydrateTable, query: HydrateQuery): Promise<unknown[]> {
    const { data, error } = await query;
    if (error) throw new HydrateRequestError(table, error);
    return Array.isArray(data) ? data : [];
  }

  /**
   * A commit behind every fence: the engine idle, the lifetime and session unchanged, and — inside
   * the transaction — the device still recording this owner.
   */
  async function commit(
    fence: () => Promise<void>,
    uid: string,
    fn: (tx: Db) => Promise<void>
  ): Promise<void> {
    if (isBusy()) throw new Halt('busy');
    await fence();
    await db.transaction(async (tx) => {
      if (!(await deviceOwnerIs(tx, uid))) throw new Halt('fenced');
      await fn(tx);
    });
  }

  /** Every row of `table` whose `column` is in `ids`, read in bounded, id-ordered requests. */
  async function fetchChildren(
    table: 'trip_events' | 'event_disputes',
    columns: string,
    column: string,
    ids: readonly string[],
    uid: string,
    orderBy: string,
    fence: () => Promise<void>
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const group of chunks(ids, IN_CHUNK)) {
      let after: string | null = null;
      for (;;) {
        let query = supabase
          .from(table)
          .select(columns)
          .eq('user_id', uid)
          .in(column, group);
        if (after !== null) query = query.gt(orderBy, after);
        const rows = await request(table, query.order(orderBy).limit(CHILD_LIMIT));
        await fence();
        out.push(...rows);
        if (rows.length < CHILD_LIMIT) break;
        const last = rows[rows.length - 1] as Record<string, unknown> | undefined;
        const next = typeof last?.[orderBy] === 'string' ? (last[orderBy] as string) : null;
        if (next === null || !isUuid(next) || next === after) break;
        after = next;
      }
    }
    return out;
  }

  /** The day rows and the baseline, read once and written in one transaction. */
  async function restoreDaysAndBaseline(
    full: boolean,
    uid: string,
    startedAt: number,
    fence: () => Promise<void>,
    result: HydrateResult
  ): Promise<void> {
    const since = full ? null : await settings.get<unknown>(HYDRATE_DAYS_CURSOR_KEY);
    const sinceText =
      typeof since === 'string' && TimestampText.safeParse(since).success ? since : null;
    await fence();

    let daysQuery = supabase.from('score_daily').select(DAY_COLUMNS).eq('user_id', uid);
    daysQuery =
      sinceText === null
        ? daysQuery.order('day', { ascending: false }).limit(DAY_LIMIT)
        : // `gte`, not `gt`: re-writing a day is idempotent, and a tie at the boundary is not lost.
          daysQuery.gte('updated_at', sinceText).order('updated_at').limit(DAY_LIMIT);
    const rawDays = await request('score_daily', daysQuery);
    await fence();
    const rawBaselines = await request(
      'baselines',
      supabase.from('baselines').select(BASELINE_COLUMNS).eq('user_id', uid).limit(1)
    );
    await fence();

    const days = rawDays.flatMap((raw) => {
      const parsed = parseRow(ServerDaySchema, raw);
      const row = parsed === null ? null : toDayRow(parsed);
      if (parsed === null || row === null) {
        report(new Error('unreadable score_daily row'), 'hydrate day');
        return [];
      }
      return [{ row, updatedAt: parsed.updated_at }];
    });
    const baselineRow = rawBaselines.length > 0 ? parseRow(ServerBaselineSchema, rawBaselines[0]) : null;
    const baseline = baselineRow === null ? null : toStoredBaseline(baselineRow);

    let newest = sinceText;
    for (const { updatedAt } of days) if (newest === null || updatedAt > newest) newest = updatedAt;

    await commit(fence, uid, async (tx) => {
      for (const { row } of days) {
        // A day the runner wrote after this run began is the server's newer word: keep it.
        const { rows } = await tx.execute(
          'SELECT updated_at FROM score_daily_cache WHERE day = ?',
          [row.day]
        );
        const local = rows[0]?.updated_at;
        if (typeof local === 'number' && local >= startedAt) continue;
        await tx.execute(
          'INSERT OR REPLACE INTO score_daily_cache (day, payload_json, updated_at) VALUES (?, ?, ?)',
          [row.day, JSON.stringify(row), now()]
        );
        result.days += 1;
      }
      if (baseline !== null) {
        await tx.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
          BASELINE_SETTING_KEY,
          JSON.stringify(baseline),
        ]);
        result.baseline = true;
      }
      if (newest !== null) {
        await tx.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
          HYDRATE_DAYS_CURSOR_KEY,
          JSON.stringify(newest),
        ]);
      }
    });
  }

  /** Why a server trip is left alone, or null when it may be written. */
  async function localWins(
    tx: Db,
    trip: ServerTrip,
    pending: ReadonlySet<string>,
    fetchedAt: number
  ): Promise<boolean> {
    const id = trip.client_trip_id;
    if (pending.has(id)) return true;
    // The tombstone: a delete this device made, in whatever state its item is now.
    const tomb = await tx.execute('SELECT 1 FROM sync_queue WHERE idempotency_key = ?', [
      `delete:${id}`,
    ]);
    if (tomb.rows.length > 0) return true;
    const { rows } = await tx.execute(
      'SELECT sync_state, deleted_at, status, server_id, updated_at FROM trips WHERE client_trip_id = ?',
      [id]
    );
    const local = rows[0];
    if (!local) return false;
    if (local.deleted_at !== null && local.deleted_at !== undefined) return true;
    if (local.status === 'recording') return true;
    if (local.sync_state !== 'synced') return true;
    if (local.server_id !== null && local.server_id !== trip.id) return true;
    return typeof local.updated_at === 'number' && local.updated_at > fetchedAt;
  }

  /** Write one server trip and its events; the caller has already decided it may. */
  async function writeTrip(
    tx: Db,
    trip: ServerTrip,
    events: readonly ServerEvent[],
    disputes: ReadonlyMap<string, ServerDispute>,
    result: HydrateResult
  ): Promise<void> {
    const fields = toTripFields(trip);
    if (fields === null) {
      report(new Error('unreadable trip timestamps'), 'hydrate trip');
      return;
    }
    const at = now();
    const { rows } = await tx.execute(
      'SELECT start_label, end_label FROM trips WHERE client_trip_id = ?',
      [trip.client_trip_id]
    );
    const existing = rows[0];
    if (existing) {
      // Labels are the one thing the device may know that the server does not.
      const patch = {
        ...fields,
        start_label: fields.start_label ?? (existing.start_label as string | null) ?? null,
        end_label: fields.end_label ?? (existing.end_label as string | null) ?? null,
        updated_at: at,
      };
      const columns = Object.keys(patch);
      await tx.execute(
        `UPDATE trips SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE client_trip_id = ?`,
        [...columns.map((c) => (patch as Record<string, unknown>)[c]), trip.client_trip_id]
      );
    } else {
      const row = {
        client_trip_id: trip.client_trip_id,
        ...fields,
        checkpoint_ts: null,
        sync_error: null,
        deleted_at: null,
        created_at: at,
        updated_at: at,
      };
      const columns = Object.keys(row);
      await tx.execute(
        `INSERT INTO trips (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((c) => (row as Record<string, unknown>)[c])
      );
    }
    result.trips += 1;

    for (const event of events) {
      const serverDispute = disputes.get(event.id);
      const record = serverDispute === undefined ? null : toDisputeRecord(serverDispute);
      const row = toEventRow(event, trip.client_trip_id, record);
      if (row === null) {
        report(new Error('unreadable event timestamp'), 'hydrate event');
        continue;
      }
      const found = await tx.execute(
        'SELECT client_trip_id, dispute_json FROM trip_events WHERE id = ?',
        [row.id]
      );
      const local = found.rows[0];
      if (local) {
        // An id is a trip's own: never re-parent an event that belongs to another trip.
        if (local.client_trip_id !== trip.client_trip_id) continue;
        // A report the server never recorded (a closed window, a refusal) lives only here
        // (carry-over 7): keep it unless the server has a record of its own.
        const dispute = row.dispute_json ?? (local.dispute_json as string | null) ?? null;
        await tx.execute(
          `UPDATE trip_events SET category = ?, started_at = ?, duration_s = ?, lat = ?, lng = ?,
             measured_json = ?, severity = ?, confidence = ?, context_json = ?, deduction = ?,
             alert_shown = ?, corrected = ?, status = ?, source = ?, dispute_json = ?
           WHERE id = ?`,
          [
            row.category,
            row.started_at,
            row.duration_s,
            row.lat,
            row.lng,
            row.measured_json,
            row.severity,
            row.confidence,
            row.context_json,
            row.deduction,
            row.alert_shown,
            row.corrected,
            row.status,
            row.source,
            dispute,
            row.id,
          ]
        );
      } else {
        await tx.execute(
          `INSERT INTO trip_events (id, client_trip_id, category, started_at, duration_s, lat, lng,
             measured_json, severity, confidence, context_json, deduction, alert_shown, corrected,
             status, source, dispute_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.client_trip_id,
            row.category,
            row.started_at,
            row.duration_s,
            row.lat,
            row.lng,
            row.measured_json,
            row.severity,
            row.confidence,
            row.context_json,
            row.deduction,
            row.alert_shown,
            row.corrected,
            row.status,
            row.source,
            row.dispute_json,
          ]
        );
      }
      result.events += 1;
    }
  }

  async function restoreTrips(
    full: boolean,
    uid: string,
    fence: () => Promise<void>,
    result: HydrateResult,
    progress: () => void
  ): Promise<void> {
    let cursor = full ? null : readCursor(await settings.get<unknown>(HYDRATE_CURSOR_KEY));
    await fence();

    for (;;) {
      const fetchedAt = now();
      let query = supabase
        .from('trips')
        .select(TRIP_COLUMNS)
        .eq('user_id', uid)
        .is('deleted_at', null);
      if (cursor !== null) {
        query = query.or(
          `updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`
        );
      }
      const rawTrips = await request(
        'trips',
        query.order('updated_at').order('id').limit(pageSize)
      );
      await fence();
      if (rawTrips.length === 0) {
        result.complete = true;
        return;
      }

      // The page's last row is where the next page starts, readable or not: a row this build
      // cannot parse must not hold the cursor back for ever.
      const lastRaw = rawTrips[rawTrips.length - 1] as Record<string, unknown>;
      const nextCursor = readCursor({ updatedAt: lastRaw.updated_at, id: lastRaw.id });
      if (nextCursor === null) throw new Error('hydration: the page ended on a row with no cursor');

      const trips: ServerTrip[] = [];
      for (const raw of rawTrips) {
        const parsed = parseRow(ServerTripSchema, raw);
        if (parsed === null) report(new Error('unreadable trip row'), 'hydrate trip');
        else trips.push(parsed);
      }

      const tripIds = trips.map((t) => t.id);
      const events: ServerEvent[] = [];
      for (const raw of await fetchChildren(
        'trip_events',
        EVENT_COLUMNS,
        'trip_id',
        tripIds,
        uid,
        'id',
        fence
      )) {
        const parsed = parseRow(ServerEventSchema, raw);
        if (parsed === null) report(new Error('unreadable event row'), 'hydrate event');
        else events.push(parsed);
      }
      const disputes = new Map<string, ServerDispute>();
      if (events.length > 0) {
        for (const raw of await fetchChildren(
          'event_disputes',
          DISPUTE_COLUMNS,
          'event_id',
          events.map((e) => e.id),
          uid,
          'event_id',
          fence
        )) {
          const parsed = parseRow(ServerDisputeSchema, raw);
          if (parsed === null) report(new Error('unreadable dispute row'), 'hydrate dispute');
          else disputes.set(parsed.event_id, parsed);
        }
      }
      const eventsByTrip = new Map<string, ServerEvent[]>();
      for (const event of events) {
        const list = eventsByTrip.get(event.trip_id) ?? [];
        list.push(event);
        eventsByTrip.set(event.trip_id, list);
      }

      const before = result.trips;
      await commit(fence, uid, async (tx) => {
        const pending = await tripsWithPendingWork(tx);
        for (const trip of trips) {
          if (await localWins(tx, trip, pending, fetchedAt)) {
            result.skippedLocal += 1;
            continue;
          }
          await writeTrip(tx, trip, eventsByTrip.get(trip.id) ?? [], disputes, result);
        }
        await tx.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
          HYDRATE_CURSOR_KEY,
          JSON.stringify(nextCursor),
        ]);
      });
      cursor = nextCursor;
      if (result.trips > before) {
        progress();
        emitDataChanged({ source: 'hydrate' }, (error) => report(error, 'data change listener'));
      }
      if (rawTrips.length < pageSize) {
        result.complete = true;
        return;
      }
    }
  }

  async function execute(full: boolean, of: number): Promise<HydrateResult> {
    const result = emptyResult();
    const startedAt = now();
    try {
      const uid = await sessionUid();
      // Only the device's own owner is ever restored into it: a session that is somebody else's
      // is a handover the host has not processed yet, and the rebuild will wipe first.
      if (of !== generation || uid === null || !(await deviceOwnerIs(db, uid))) {
        if (full && of === generation) setHydrationStatus({ state: 'failed', at: now() });
        return result;
      }
      const fence = fenceFor(of, uid);
      await fence();

      if (full) setHydrationStatus({ state: 'restoring', restored: 0 });
      await restoreDaysAndBaseline(full, uid, startedAt, fence, result);
      if (result.days > 0 || result.baseline) {
        emitDataChanged({ source: 'hydrate' }, (error) => report(error, 'data change listener'));
      }
      await restoreTrips(full, uid, fence, result, () => {
        if (full && of === generation) {
          setHydrationStatus({ state: 'restoring', restored: result.trips });
        }
      });
      if (full) {
        // The marker that no full restore is owed any more, fenced like every other write.
        await commit(fence, uid, async (tx) => {
          await tx.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
            HYDRATE_RESTORED_AT_KEY,
            JSON.stringify(now()),
          ]);
        });
        if (of === generation) setHydrationStatus({ state: 'idle' });
      }
      return result;
    } catch (error) {
      result.complete = false;
      if (error instanceof Halt) {
        // Busy: the restore is still owed and resumes at the next foreground. Fenced: this
        // hydrator's lifetime is over and a new one owns the status.
        if (full && of === generation) setHydrationStatus({ state: 'failed', at: now() });
        return result;
      }
      report(error, 'hydrate');
      if (full && of === generation) setHydrationStatus({ state: 'failed', at: now() });
      return result;
    }
  }

  return {
    run({ full }): Promise<HydrateResult> {
      // One run at a time: a second request while one is in flight joins it.
      if (inFlight !== null) return inFlight;
      if (stopped) return Promise.resolve(emptyResult());
      const of = generation;
      const running = execute(full, of).finally(() => {
        if (inFlight === running) inFlight = null;
      });
      inFlight = running;
      return running;
    },

    stop(): Promise<void> {
      stopped = true;
      generation += 1;
      // Whatever this lifetime was restoring is no longer anybody's; the next runtime says its own.
      setHydrationStatus({ state: 'idle' });
      const running = inFlight;
      return running === null ? Promise.resolve() : running.then(() => undefined);
    },
  };
}
