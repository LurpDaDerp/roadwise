/** @jest-environment node */
import { createFakeDriveSense } from '@drive-sense';

import type { AlertPlayer } from '@/core/alerts/player';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { TZ } from '@/core/engine/__fixtures__/drives';
import type { LimitSample } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db';
import { createFakeAppState, createFakeSupabase, invokeOk } from '@/data/sync/__fixtures__/fakes';
import { bootstrapApp, type BootstrapDeps, type BootSupabase } from '@/boot/bootstrap';
import type { WeatherHeadsUpArgs } from '@/boot/weatherHeadsUp';
import type { DriveHost } from '@/drive/host';

jest.mock('expo-notifications', () => ({}));
jest.mock('@/features/drive/permissions', () => ({ ensureDrivePermissions: async () => ({ location: 'granted', motion: 'undetermined' }) }));

function fakeLimits(): SpeedLimitClient {
  const sample: LimitSample = { limitMps: 35 * 0.44704, source: 'posted', matchConfidence: 0.95, parallelRoads: false };
  return { lookup: () => sample, lookupStored: async () => sample, startTrip: () => {}, prefetch: () => {}, resetTrip: jest.fn(), purgeExpired: async () => 0 } as unknown as SpeedLimitClient;
}
const player: AlertPlayer = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} };

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
});

function deps(attachWeatherHeadsUp: BootstrapDeps['attachWeatherHeadsUp']) {
  const source = createFakeDriveSense({ platform: 'android', now: () => T0 });
  source.setState({ location: 'whenInUse', motion: 'granted' });
  const supabase = createFakeSupabase({ uid: 'user-1', invoke: () => invokeOk({}), rpc: () => ({ data: [], error: null }) });
  return {
    openDb: async () => db,
    supabase: supabase as unknown as BootSupabase,
    source,
    limits: fakeLimits(),
    createPlayer: async () => player,
    display: null,
    appState: createFakeAppState('active'),
    now: () => T0 + 10_000_000,
    tz: TZ,
    appVersion: '2.0.0',
    permissions: async () => ({ location: 'granted' as const }),
    attachSummaryNotifier: null,
    mountDiagnostics: null,
    createNet: null,
    mayDrain: () => false,
    onError: () => {},
    attachWeatherHeadsUp,
  };
}

test('the launch attaches the weather heads-up to its drive host, signed in, and detaches it when it stops', async () => {
  const seen: { host: DriveHost; db: Db; args: WeatherHeadsUpArgs }[] = [];
  const detach = jest.fn();
  const settled = jest.fn(async () => {});
  const rt = await bootstrapApp(
    deps((host, d, args) => {
      seen.push({ host, db: d, args });
      return { detach, settled };
    })
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]?.host).toBe(rt.drive);
  expect(seen[0]?.db).toBe(db);
  expect(await seen[0]?.args.signedIn()).toBe(true);
  expect(seen[0]?.args.appState.currentState).toBe('active');
  expect(detach).not.toHaveBeenCalled();
  await rt.stop();
  expect(detach).toHaveBeenCalledTimes(1);
  expect(settled).toHaveBeenCalled();
});

test('a heads-up that will not attach is reported and the launch goes on', async () => {
  const errors: string[] = [];
  const rt = await bootstrapApp({
    ...deps(() => {
      throw new Error('no notifications');
    }),
    onError: (_e, ctx) => void errors.push(ctx),
  });
  expect(errors).toContain('weather heads-up');
  await rt.stop();
});

test('null: none attached', async () => {
  const rt = await bootstrapApp(deps(null));
  expect(rt.drive.snapshot().status).toBe('idle');
  await rt.stop();
});

test('the default attaches quietly, even with no notifications module', async () => {
  const errors: string[] = [];
  const rt = await bootstrapApp({ ...deps(undefined), onError: (_e, ctx) => void errors.push(ctx) });
  await rt.stop();
  expect(errors.filter((c) => c.includes('weather'))).toEqual([]);
});
