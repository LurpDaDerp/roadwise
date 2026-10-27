/** @jest-environment node */
// Replayed rows (a journal drained) are judged against the stored speed-limit tiles. A journal comes
// in a burst, faster than the live lookup's reads land, so the engine waits for the stored tiles on
// a replayed row (`EngineDeps.limits.lookupStored`), and never asks the network along the old route.
import { createDetectors } from '@/core/detectors';
import { row, T0 } from '@/core/detectors/__fixtures__/rows';
import type { TripSession } from '@/core/engine/engine.types';
import { createEngine } from '@/core/engine/machine';
import type { SpeedLimitApi } from '@/core/speedLimits/api';
import { createSpeedLimitClient } from '@/core/speedLimits/client';
import { TILE_DATA_VERSION } from '@/core/speedLimits/store';
import { tileFor, tileKey } from '@/core/speedLimits/tiles';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createTilesRepo } from '@/data/db/tiles';
import { encodePolyline } from '@/lib/polyline';

const LAT = 47.6062;
const LNG0 = -122.3321;
const M_PER_DEG = 111_320;
const mLng = (m: number): number => m / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180));

/** 20 rows east along the corridor at 20 m/s (44.7 mph), past a 35 mph limit's line (39). */
const ROWS = Array.from({ length: 20 }, (_, i) => row({ lat: LAT, lng: LNG0 + mLng(20 * i), speed: 20, course: 90, ts: T0 + i * 1000 }, i));

/** The corridor: one east-west road, 35 mph. */
const ROAD = {
  id: 'corridor',
  provider: 'osm',
  limitMph: 35,
  highway: 'primary',
  oneway: 0,
  line: encodePolyline([
    { lat: LAT, lng: -122.34 },
    { lat: LAT, lng: -122.299 },
  ]),
};

async function harness(opts: { stored: boolean }) {
  const raw = await createSqlJsDb();
  await migrate(raw);
  if (opts.stored) {
    for (const r of ROWS) {
      await createTilesRepo(raw).putTile(tileKey(tileFor(r.lat, r.lng)), T0 + 86_400_000, { v: TILE_DATA_VERSION, truncated: false, segments: [ROAD] });
    }
  }
  // expo-sqlite answers on a later task, never inside the caller's chain of microtasks.
  const db: Db = {
    execute: async (sql, params) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return raw.execute(sql, params);
    },
    transaction: (fn) => raw.transaction(fn),
  };
  const getTiles = jest.fn<ReturnType<SpeedLimitApi['getTiles']>, Parameters<SpeedLimitApi['getTiles']>>(async () => {
    throw new Error('no network in this test');
  });
  const lookupPoint = jest.fn<ReturnType<SpeedLimitApi['lookupPoint']>, Parameters<SpeedLimitApi['lookupPoint']>>(async () => {
    throw new Error('no network in this test');
  });
  const limits = createSpeedLimitClient({ db, api: { getTiles, lookupPoint }, now: () => T0, online: () => true, warmAheadM: [] });
  const finalized: Readonly<TripSession>[] = [];
  let n = 0;
  const engine = createEngine({
    now: () => T0,
    newId: () => `id${(n += 1)}`,
    limits: {
      lookup: (lat, lng, course, fix) => limits.lookup(lat, lng, course, fix ?? { gnssValid: true, speedMps: null }),
      lookupStored: (lat, lng, course) => limits.lookupStored(lat, lng, course),
      prefetch: () => {},
    },
    createDetectors: () => createDetectors(() => `e${(n += 1)}`),
    ctx: () => ({ platform: 'ios' }),
    onAlert: () => {},
    onCheckpoint: async () => {},
    onFinalize: async (s) => {
      finalized.push(s);
    },
    onCancel: async () => {},
  });
  await engine.dispatch({ type: 'start', ts: T0, origin: 'auto', continues: false });
  return { engine, finalized, getTiles, limits };
}

test('20 rows replayed in a burst over a stored tile: the speeding is an event and its seconds have a limit', async () => {
  const h = await harness({ stored: true });
  for (const r of ROWS) await h.engine.dispatch({ type: 'row', row: r, replay: true });
  await h.engine.dispatch({ type: 'end', ts: T0 + 20_000 });
  const speeding = h.finalized[0]!.events.filter((e) => e.type === 'speeding');
  expect(speeding).toHaveLength(1);
  expect(speeding[0]).toMatchObject({ startedAt: T0, durationS: 20, measured: { limitMph: 35 } });
  expect(h.finalized[0]!.exposure.limitS).toBe(20);
});

test('replayed rows over tiles the phone does not hold ask the network for nothing; the first live row does', async () => {
  const h = await harness({ stored: false });
  for (const r of ROWS) await h.engine.dispatch({ type: 'row', row: r, replay: true });
  await h.limits.settled();
  expect(h.getTiles).not.toHaveBeenCalled();
  const live = row({ lat: LAT, lng: LNG0 + mLng(400), speed: 20, course: 90, ts: T0 + 20_000 }, 20);
  await h.engine.dispatch({ type: 'row', row: live });
  await h.limits.settled();
  expect(h.getTiles).toHaveBeenCalled();
});
