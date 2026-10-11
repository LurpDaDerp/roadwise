/** @jest-environment node */
// Both finalize call sites pass the DashPal facts (plan §7.7): the drive host's `onFinalize` and
// bootstrap's crash recovery. Row 41: an orphaned drive with stored dashcam rows is finalized with
// those facts. (The payload's `dashcam` block and the candidate events are finalize's job, on the
// scoring branch; here: the dependency reaches it and yields the stored facts.)
import { createFakeDriveSense } from '@drive-sense';

import type { AlertPlayer } from '@/core/alerts/player';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { rows, TZ } from '@/core/engine/__fixtures__/drives';
import type { LimitSample } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSamplesRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { createFakeAppState, createFakeSupabase, invokeOk } from '@/data/sync/__fixtures__/fakes';
import { bootstrapApp, startForegroundJobs, type BootSupabase } from '@/boot/bootstrap';
import { activeDashcam } from '@/dashcam/registry';

import type { DashcamTripFacts } from '../facts';
import { PAIRED_KEY } from '../keys';
import { createDashcamStore } from '../store';

jest.mock('expo-notifications', () => ({}));

const finalizeCalls: { clientTripId: string; deps: Record<string, unknown> }[] = [];
jest.mock('@/core/engine/finalize', () => {
  const actual = jest.requireActual<typeof import('@/core/engine/finalize')>('@/core/engine/finalize');
  return {
    ...actual,
    finalizeTrip: (session: { clientTripId: string }, deps: Record<string, unknown>) => {
      finalizeCalls.push({ clientTripId: session.clientTripId, deps });
      return actual.finalizeTrip(session as never, deps as never);
    },
  };
});

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CAM = 'a4cf12b3c4d5';

function fakeLimits(): SpeedLimitClient {
  const sample: LimitSample = { limitMps: 35 * 0.44704, source: 'posted', matchConfidence: 0.95, parallelRoads: false };
  return {
    lookup: () => sample,
    lookupStored: async () => sample,
    startTrip: () => {},
    prefetch: () => {},
    resetTrip: jest.fn(),
    purgeExpired: async () => 0,
  } as unknown as SpeedLimitClient;
}

const player: AlertPlayer = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} };

let db: Db;
const clock = T0 + 10_000_000;

beforeEach(async () => {
  db = await createSqlJsDb();
  finalizeCalls.length = 0;
});

function deps(over: Partial<Parameters<typeof bootstrapApp>[0]> = {}) {
  const source = createFakeDriveSense({ platform: 'android', now: () => clock });
  source.setState({ location: 'whenInUse', motion: 'granted' });
  const supabase = createFakeSupabase({ uid: 'user-1', invoke: () => invokeOk({}), rpc: () => ({ data: [], error: null }) });
  const errors: string[] = [];
  return {
    source,
    errors,
    deps: {
      openDb: async () => db,
      supabase: supabase as unknown as BootSupabase,
      source,
      limits: fakeLimits(),
      createPlayer: async () => player,
      display: null,
      appState: createFakeAppState('active'),
      now: () => clock,
      tz: TZ,
      appVersion: '2.0.0',
      newId: () => uuid(99),
      permissions: async () => ({ location: 'granted' as const }),
      speedProbe: async () => 0,
      attachSummaryNotifier: null,
      mountDiagnostics: null,
      mayDrain: () => false,
      onError: (e: unknown, ctx: string) => errors.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`),
      ...over,
    },
  };
}

test('row 41: crash mid-drive, then recovery finalizes the orphan with its stored DashPal facts', async () => {
  // A first launch makes the schema; then the previous process "dies" mid-drive.
  const seed = await bootstrapApp(deps().deps);
  await seed.stop();
  await migrate(db);
  const started = clock - 600_000;
  await createTripsRepo(db).insert({ client_trip_id: uuid(5), started_at: started, tz: TZ, status: 'recording' }, clock);
  await createSamplesRepo(db).appendMany(uuid(5), rows(600, { t0: started }).map((r) => ({ ts: r.ts, row: r })));
  await createSettingsRepo(db).set(PAIRED_KEY, { dashcamId: CAM, peripheralId: 'AA:BB', name: 'DashPal-C4D5', pairedAt: 1 });
  const store = createDashcamStore(db);
  for (let i = 0; i < 300; i++) await store.addCoverage(uuid(5), 1, i < 280 ? 1 : 0, null);
  await store.ensureBoot(CAM, 77, 0);
  const offset = started - 1_000_000; // dashcam uptime 1 000 000 at the drive start
  await store.offerOffset(CAM, 77, offset, 12);
  await store.insertEvent({
    dashcamId: CAM, bootKey: 77, seq: 0, id: '11111111-2222-4333-8444-555555555555', ev: 0, name: 'MICROSLEEP', tier: 3, audible: true, detail: 0,
    tMs: 1_000_000 + 120_000, durDs: 15, value: 1.5, atMs: null, startedAtMs: null, receivedAtMs: started + 120_100,
  });

  const d = deps();
  const rt = await bootstrapApp(d.deps);
  expect(rt.recovery.finalized).toEqual([uuid(5)]);
  const call = finalizeCalls.find((c) => c.clientTripId === uuid(5));
  expect(call).toBeDefined();
  expect(typeof call!.deps.dashcamFacts).toBe('function');
  const trip = await createTripsRepo(db).get(uuid(5));
  const facts = (await (call!.deps.dashcamFacts as (t: unknown) => Promise<DashcamTripFacts>)({
    clientTripId: uuid(5),
    startedAt: trip!.started_at,
    endedAt: trip!.ended_at!,
  })) as DashcamTripFacts;
  expect(facts).toMatchObject({ dashcamId: CAM, movingS: 300, coveredS: 280, synced: false });
  // Called here after the recovery finalize purged the samples, so no speed (finalize itself calls
  // it before the purge).
  expect(facts.events).toEqual([
    { id: '11111111-2222-4333-8444-555555555555', kind: 'drowsy', startedAt: started + 120_000 - 1500, durationS: 1.5, speedMph: null },
  ]);
  // The paired dashcam's transport is not available under Jest: reported, never fatal.
  expect(rt.dashcam).not.toBeNull();
  expect(activeDashcam()).toBe(rt.dashcam);
  await rt.dashcam!.ready;
  expect(d.errors.some((e) => e.startsWith('dashcam transport'))).toBe(true);
  await rt.stop();
  expect(activeDashcam()).toBeNull();
});

test('the host finalize passes the DashPal facts too, and a launch with no DashPal never creates the transport', async () => {
  const d = deps({ newId: () => uuid(7) });
  const rt = await bootstrapApp(d.deps);
  await rt.dashcam!.ready;
  // Creating the transport would require the BLE native module, which Jest lacks: no error means
  // it was never created.
  expect(d.errors.filter((e) => e.startsWith('dashcam'))).toEqual([]);
  expect(await rt.drive.start()).toEqual({ ok: true, clientTripId: uuid(7) });
  await rt.drive.end();
  expect(finalizeCalls.find((c) => c.clientTripId === uuid(7))?.deps.dashcamFacts).toEqual(expect.any(Function));
  await rt.stop();
});

test('createDashcam: null builds none', async () => {
  const rt = await bootstrapApp(deps({ createDashcam: null }).deps);
  expect(rt.dashcam).toBeNull();
  expect(activeDashcam()).toBeNull();
  await rt.stop();
});

test('row 32: the foreground jobs prune DashPal events no drive claimed after 7 days, and keep the rest', async () => {
  const rt = await bootstrapApp(deps().deps);
  const store = createDashcamStore(db);
  await store.ensureBoot(CAM, 1, 0);
  const put = (seq: number, receivedAtMs: number) =>
    store.insertEvent({
      dashcamId: CAM, bootKey: 1, seq, id: `00000000-0000-4000-8000-0000000000${10 + seq}`, ev: 3, name: 'LONG_GLANCE', tier: 2, audible: true, detail: 0,
      tMs: 1, durDs: 1, value: 0, atMs: null, startedAtMs: null, receivedAtMs,
    });
  const DAY = 24 * 60 * 60_000;
  await put(0, clock - 8 * DAY); // outside a drive, 8 days old: pruned
  await put(1, clock - 6 * DAY); // outside a drive, 6 days old: kept
  await put(2, clock - 30 * DAY); // claimed by a drive: kept
  await createTripsRepo(db).insert({ client_trip_id: uuid(9), started_at: clock - 30 * DAY, tz: TZ, status: 'scored' }, clock);
  await db.execute('UPDATE dashcam_events SET client_trip_id = ? WHERE seq = 2', [uuid(9)]);
  const jobs = await startForegroundJobs(rt, { appState: createFakeAppState('active'), onError: () => {} });
  for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await db.execute('SELECT seq FROM dashcam_events ORDER BY seq')).rows).toEqual([{ seq: 1 }, { seq: 2 }]);
  await jobs.stop();
  await rt.stop();
});
