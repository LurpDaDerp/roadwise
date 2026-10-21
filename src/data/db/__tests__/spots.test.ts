/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo } from '@/data/db/settings';
import { createSpotsRepo, parseSpotsMeta, SPOT_LABEL_CARRY_M, SPOTS_META_KEY } from '@/data/db/spots';
import { createTripsRepo } from '@/data/db/trips';
import type { NewProblemSpot } from '@/data/db/types';

const T0 = 1_700_000_000_000;
/** About 1 m of latitude. */
const M = 1 / 111_320;

let db: Db;
let spots: ReturnType<typeof createSpotsRepo>;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  spots = createSpotsRepo(db);
  for (const id of ['t1', 't2']) await createTripsRepo(db).insert({ client_trip_id: id, started_at: T0, tz: 'UTC', status: 'scored' }, T0);
});

const spot = (id: string, over: Partial<NewProblemSpot> = {}): NewProblemSpot => ({
  id,
  kind: 'hard_brake',
  state: 'active',
  lat: 47.6,
  lng: -122.3,
  heading_deg: 90,
  segment: '_p~iF~ps|U_ulLnnqC',
  limit_mph: null,
  hits: 3,
  passes: 6,
  recent_hits: 3,
  recent_passes: 6,
  rate: 0.4,
  clean_streak: 0,
  clean_needed: 5,
  last_hit_at: T0,
  last_hit_trip: 't1',
  last_pass_at: T0,
  cleared_at: null,
  rank: 1,
  ...over,
});

test('replaceAll writes the new spots whole and the meta record; list is active by rank, then cleared, ties by id', async () => {
  expect(await spots.replaceAll([spot('a')], { computedAt: T0, drives: 12 }, ['t1'])).toBe(true);
  expect(
    await spots.replaceAll(
      [spot('z', { state: 'cleared', rank: 0, cleared_at: T0 }), spot('c', { rank: 2 }), spot('b', { rank: 1 }), spot('y', { state: 'cleared', rank: 0, cleared_at: T0 })],
      { computedAt: T0 + 1, drives: 13 },
      ['t1', 't1']
    )
  ).toBe(true);
  const list = await spots.list();
  expect(list.map((s) => s.id)).toEqual(['b', 'c', 'y', 'z']);
  expect(list[0]).toMatchObject({ id: 'b', kind: 'hard_brake', state: 'active', lat: 47.6, heading_deg: 90, computed_at: T0 + 1, label: null, label_at: null });
  expect(parseSpotsMeta(await createSettingsRepo(db).get(SPOTS_META_KEY))).toEqual({ v: 1, computedAt: T0 + 1, drives: 13 });
});

test('a new spot keeps the label of the nearest old spot of the same kind within 60 m that was looked up; another kind or farther is not carried', async () => {
  expect(SPOT_LABEL_CARRY_M).toBe(60);
  await spots.replaceAll(
    [
      spot('near', { lat: 47.6, lng: -122.3 }),
      spot('nearer', { lat: 47.6 + 30 * M, lng: -122.3, rank: 2 }),
      spot('turn', { kind: 'hard_corner', lat: 47.6 + 50 * M, lng: -122.3, rank: 3 }),
      spot('none', { lat: 47.7, lng: -122.3, rank: 4 }),
    ],
    { computedAt: T0, drives: 10 },
    []
  );
  await spots.setLabel('near', 'Pine St', T0 + 1);
  await spots.setLabel('nearer', 'Pike St', T0 + 2);
  await spots.setLabel('turn', null, T0 + 3); // looked up, nothing found: the "tried" stamp carries too
  await spots.setLabel('gone', 'x', T0); // a spot that is not there: no-op

  await spots.replaceAll(
    [
      spot('n1', { lat: 47.6 + 40 * M, lng: -122.3 }), // 10 m from "nearer", 40 m from "near"
      spot('n2', { kind: 'hard_corner', lat: 47.6 + 55 * M, lng: -122.3, rank: 2 }),
      spot('n3', { lat: 47.6 + 100 * M, lng: -122.3, rank: 3 }), // 70 m from "nearer"
      spot('n4', { kind: 'speeding', lat: 47.6, lng: -122.3, rank: 4 }),
    ],
    { computedAt: T0 + 10, drives: 11 },
    ['t2']
  );
  const byId = Object.fromEntries((await spots.list()).map((s) => [s.id, s]));
  expect(byId.n1).toMatchObject({ label: 'Pike St', label_at: T0 + 2 });
  expect(byId.n2).toMatchObject({ label: null, label_at: T0 + 3 });
  expect(byId.n3).toMatchObject({ label: null, label_at: null });
  expect(byId.n4).toMatchObject({ label: null, label_at: null });
});

test('a recompute that raced a wipe writes nothing: a drive a spot links to is gone', async () => {
  await spots.replaceAll([spot('a')], { computedAt: T0, drives: 10 }, ['t1']);
  expect(await spots.replaceAll([spot('b')], { computedAt: T0 + 1, drives: 11 }, ['t1', 'gone'])).toBe(false);
  expect((await spots.list()).map((s) => s.id)).toEqual(['a']);
  expect(parseSpotsMeta(await createSettingsRepo(db).get(SPOTS_META_KEY))).toMatchObject({ computedAt: T0, drives: 10 });
  // An empty write has nothing to guard and clears the spots.
  expect(await spots.replaceAll([], { computedAt: T0 + 2, drives: 3 }, [])).toBe(true);
  expect(await spots.list()).toEqual([]);
});

test('the meta record parses only in the shape this build writes', () => {
  expect(parseSpotsMeta({ v: 1, computedAt: 5, drives: 2 })).toEqual({ v: 1, computedAt: 5, drives: 2 });
  for (const bad of [null, 'x', { v: 2, computedAt: 5, drives: 2 }, { v: 1, computedAt: '5', drives: 2 }, { v: 1, computedAt: 5 }]) expect(parseSpotsMeta(bad)).toBeNull();
});
