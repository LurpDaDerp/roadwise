/** @jest-environment node */
import { QueryClient } from '@tanstack/react-query';

import type { Db } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';
import { createSpotsRepo } from '@/data/db/spots';
import type { NewProblemSpot } from '@/data/db/types';
import { createTestDb, seedEvents, seedTrips } from '@/data/queries/__fixtures__/harness';
import { invalidateAfterSync } from '@/data/queries/invalidate';
import { queryKeys, QUERY_ROOTS } from '@/data/queries/keys';
import { hiddenByZone, middleOf, readSpotInputs, readSpotsView, readWatchSpots, SPOT_READ } from '@/data/queries/spots';
import { encodePolyline } from '@/lib/polyline';


const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const M = 1 / 111_320;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROAD = encodePolyline([{ lat: 47.6, lng: -122.3 }, { lat: 47.61, lng: -122.3 }]);

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const spot = (id: string, over: Partial<NewProblemSpot> = {}): NewProblemSpot => ({
  id,
  kind: 'hard_brake',
  state: 'active',
  lat: 47.6,
  lng: -122.3,
  heading_deg: 0,
  segment: encodePolyline([{ lat: 47.6 - 60 * M, lng: -122.3 }, { lat: 47.6 + 20 * M, lng: -122.3 }]),
  limit_mph: null,
  hits: 3,
  passes: 6,
  recent_hits: 3,
  recent_passes: 6,
  rate: 0.4,
  clean_streak: 0,
  clean_needed: 5,
  last_hit_at: T0,
  last_hit_trip: uuid(1),
  last_pass_at: T0,
  cleared_at: null,
  rank: 1,
  ...over,
});

const zone = (lat: number, lng: number, radiusM = 300) => ({ id: 'z', name: 'Home', lat, lng, radiusM });

test('the read numbers are spots.md’s', () => {
  expect(SPOT_READ).toEqual({ windowDays: 120, maxDrives: 400, maxEvents: 3000, minDrivesForCard: 10, clearedShownDays: 30 });
});

describe('inputs', () => {
  beforeEach(async () => {
    await seedTrips(db, [
      { client_trip_id: uuid(1), started_at: T0 - DAY, tz: 'UTC', status: 'scored', polyline: ROAD },
      { client_trip_id: uuid(2), started_at: T0 - 2 * DAY, tz: 'UTC', status: 'pending', polyline: ROAD },
      { client_trip_id: uuid(3), started_at: T0 - 3 * DAY, tz: 'UTC', status: 'not_driving', polyline: ROAD },
      { client_trip_id: uuid(4), started_at: T0 - 4 * DAY, tz: 'UTC', status: 'merged', polyline: ROAD },
      { client_trip_id: uuid(5), started_at: T0 - 5 * DAY, tz: 'UTC', status: 'recording', polyline: ROAD },
      { client_trip_id: uuid(6), started_at: T0 - 6 * DAY, tz: 'UTC', status: 'unscored', reason: 'too_short', polyline: ROAD },
      { client_trip_id: uuid(7), started_at: T0 - 7 * DAY, tz: 'UTC', status: 'pending', reason: 'too_short', polyline: ROAD },
      { client_trip_id: uuid(8), started_at: T0 - 121 * DAY, tz: 'UTC', status: 'scored', polyline: ROAD },
      { client_trip_id: uuid(9), started_at: T0 - 9 * DAY, tz: 'UTC', status: 'scored', polyline: null },
    ]);
    const event = (n: number, trip: number, over: Record<string, unknown> = {}) => ({
      id: uuid(100 + n),
      client_trip_id: uuid(trip),
      type: 'hard_brake' as const,
      tier: 'minor' as const,
      started_at: T0 - trip * DAY + n,
      lat: 47.605,
      lng: -122.3,
      measured_json: '{"speedMph":31}',
      ...over,
    });
    await seedEvents(db, [
      event(1, 1, { type: 'speeding', measured_json: '{"speedMph":52,"limitMph":40,"overMphS":30}', duration_s: 25 }),
      event(2, 2),
      event(3, 3),
      event(4, 4),
      event(5, 5),
      event(6, 6),
      event(7, 7),
      event(8, 8),
      event(9, 1, { status: 'removed', dispute_status: 'accepted' }),
      event(10, 1, { dispute_status: 'pending' }),
      event(11, 1, { dispute_status: 'rejected', type: 'hard_corner' }),
      event(12, 1, { type: 'drowsy', tier: 'severe', measured_json: '{"source":"dashcam"}' }),
      event(13, 1, { lat: null, lng: null }),
      event(14, 2, { type: 'hard_accel', measured_json: 'not json' }),
      // a phone pickup is never a spot's
      event(15, 1, { type: 'phone_pickup', tier: 'moderate', duration_s: 12, measured_json: '{"speedMph":35,"maxSpeedMph":40}' }),
    ]);
  });

  test('only scored, long-enough drives of the last 120 days with a route, and their active, unreported (or turned down) events of the four kinds with a place (never a phone pickup)', async () => {
    const inputs = await readSpotInputs(db, T0);
    expect(inputs.drives).toEqual([
      { clientTripId: uuid(1), startedAt: T0 - DAY, polyline: ROAD },
      { clientTripId: uuid(2), startedAt: T0 - 2 * DAY, polyline: ROAD },
    ]);
    expect(inputs.events.map((e) => e.id).sort()).toEqual([uuid(101), uuid(102), uuid(111), uuid(114)].sort());
    expect(inputs.events.find((e) => e.id === uuid(101))).toEqual({
      id: uuid(101),
      clientTripId: uuid(1),
      type: 'speeding',
      startedAt: T0 - DAY + 1,
      durationS: 25,
      lat: 47.605,
      lng: -122.3,
      speedMph: 52,
      limitMph: 40,
    });
    expect(inputs.events.find((e) => e.id === uuid(114))).toMatchObject({ type: 'hard_accel', speedMph: null, limitMph: null });
  });
});

describe('view', () => {
  test('nothing computed yet: not computed, not eligible, no spots', async () => {
    expect(await readSpotsView(db, T0)).toEqual({ computed: false, eligible: false, active: [], clearedRecently: 0 });
  });

  test('eligible from the meta record; active in rank order; spots cleared in the last 30 days counted', async () => {
    await seedTrips(db, [{ client_trip_id: uuid(1), started_at: T0, tz: 'UTC', status: 'scored' }]);
    await createSpotsRepo(db).replaceAll(
      [
        spot('b', { rank: 2, lat: 47.7 }),
        spot('a', { rank: 1, kind: 'speeding', limit_mph: 35 }),
        spot('c', { state: 'cleared', rank: 0, cleared_at: T0 - 29 * DAY }),
        spot('d', { state: 'cleared', rank: 0, cleared_at: T0 - 31 * DAY }),
      ],
      { computedAt: T0, drives: 10 },
      [uuid(1)]
    );
    const view = await readSpotsView(db, T0);
    expect(view).toMatchObject({ computed: true, eligible: true, clearedRecently: 1 });
    expect(view.active.map((s) => s.id)).toEqual(['a', 'b']);
    expect(view.active[0]).toMatchObject({ kind: 'speeding', state: 'active', pin: { lat: 47.6, lng: -122.3 }, limitMph: 35, lastHitTrip: uuid(1), label: null });
    expect(view.active[0]?.segment).toHaveLength(2);
    await createSpotsRepo(db).replaceAll([], { computedAt: T0, drives: 9 }, []);
    expect(await readSpotsView(db, T0)).toMatchObject({ computed: true, eligible: false });
  });

  test('a privacy zone hides a spot whose pin or road middle is inside it: not shown, not counted as cleared, never watched for', async () => {
    await createSpotsRepo(db).replaceAll(
      [
        spot('pin', { lat: 47.7, lng: -122.3, segment: encodePolyline([{ lat: 47.7, lng: -122.3 }, { lat: 47.71, lng: -122.3 }]) }),
        // pin outside, the middle of its road inside
        spot('mid', { lat: 47.5, lng: -122.3, rank: 2, segment: encodePolyline([{ lat: 47.79, lng: -122.3 }, { lat: 47.81, lng: -122.3 }]) }),
        spot('free', { lat: 47.6, rank: 3 }),
        spot('cleared', { state: 'cleared', rank: 0, cleared_at: T0, lat: 47.7, lng: -122.3 }),
      ],
      { computedAt: T0, drives: 12 },
      []
    );
    await createSettingsRepo(db).set('privacy.zones', [zone(47.7, -122.3, 300), zone(47.8, -122.3, 300)]);
    const view = await readSpotsView(db, T0);
    expect(view.active.map((s) => s.id)).toEqual(['free']);
    expect(view.clearedRecently).toBe(0);
    expect(await readWatchSpots(db)).toEqual([{ id: 'free', kind: 'hard_brake', lat: 47.6, lng: -122.3, headingDeg: 0 }]);
    // with no zones, all come back
    await createSettingsRepo(db).set('privacy.zones', []);
    expect((await readWatchSpots(db)).map((s) => s.id)).toEqual(['pin', 'mid', 'free']);
  });

  test('the middle of a road is half way along it; a zone check reads the pin and that middle', () => {
    expect(middleOf([])).toBeNull();
    expect(middleOf([{ lat: 1, lng: 2 }])).toEqual({ lat: 1, lng: 2 });
    const mid = middleOf([{ lat: 0, lng: 0 }, { lat: 0.001, lng: 0 }, { lat: 0.003, lng: 0 }])!;
    expect(mid.lat).toBeCloseTo(0.0015, 6);
    expect(hiddenByZone({ pin: { lat: 0, lng: 0 }, segment: [] }, [])).toBe(false);
  });
});

test('the spots view has its own root: a recompute refreshes only it, any other change refreshes it with the rest', async () => {
  expect(queryKeys.spots()).toEqual(['spots']);
  expect(QUERY_ROOTS).toContain('spots');
  const qc = new QueryClient();
  const seen: unknown[] = [];
  jest.spyOn(qc, 'invalidateQueries').mockImplementation(async (filters) => {
    seen.push((filters as { queryKey: unknown }).queryKey);
  });
  await invalidateAfterSync(qc, { source: 'spots' });
  expect(seen).toEqual([['spots']]);
  seen.length = 0;
  await invalidateAfterSync(qc, { source: 'finalize' });
  expect(seen).toEqual(QUERY_ROOTS.map((r) => [r]));
});
