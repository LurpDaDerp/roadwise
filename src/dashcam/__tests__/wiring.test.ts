/** @jest-environment node */
// Both finalize call sites pass the DashPal facts (plan §7.7): the drive host's `onFinalize` and
// bootstrap's crash recovery. Row 41: an orphaned drive with stored dashcam rows is finalized with
// those facts. (The payload's `dashcam` block and the candidate events are finalize's job, on the
// scoring branch; here: the dependency reaches it and yields the stored facts.)
import { createFakeDriveSense } from '@drive-sense';
import { Platform } from 'react-native';

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
import { createFakeBle } from '../fakeTransport';
import { PAIRED_KEY } from '../keys';
import { createFakeDashcam } from '../__fixtures__/fakeDashcam';
import { encodeTx, fromHex } from '../protocol';
import { createDashcamStore } from '../store';
import { createBleTransport, type DashcamTransport } from '../transport';

jest.mock('expo-notifications', () => ({}));

// The phone's SecureStore: the DashPal runtime reads its pairing key there (a pairing without one
// is dropped at load).
const mockSecure = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => mockSecure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void mockSecure.set(k, v),
  deleteItemAsync: async (k: string) => void mockSecure.delete(k),
}));
const PHONE_ID = '0102030405060708';
const K_PAIR = '42'.repeat(32);

// The process transport, when a test hands one in (the BLE native module is absent in Jest).
const mockTransportRef: { current: DashcamTransport | null } = { current: null };
jest.mock('@/dashcam/transport', () => {
  const actual = jest.requireActual<typeof import('@/dashcam/transport')>('@/dashcam/transport');
  return {
    ...actual,
    getDashcamTransport: () => {
      if (!mockTransportRef.current) throw new Error('no BLE native module in Jest');
      return mockTransportRef.current;
    },
  };
});

const finalizeCalls: { clientTripId: string; deps: Record<string, unknown> }[] = [];
jest.mock('@/core/engine/finalize', () => {
  const actual = jest.requireActual<typeof import('@/core/engine/finalize')>('@/core/engine/finalize');
  return {
    ...actual,
    // Both call sites close a drive through closeDrive (it finalizes, or drops one that never moved).
    closeDrive: (session: { clientTripId: string }, deps: Record<string, unknown>) => {
      finalizeCalls.push({ clientTripId: session.clientTripId, deps });
      return actual.closeDrive(session as never, deps as never);
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
  mockSecure.clear();
  mockSecure.set('dashpal.auth', JSON.stringify({ v: 2, dashcamId: CAM, phoneId: PHONE_ID, kPair: K_PAIR, code: null }));
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
  await createSettingsRepo(db).set(PAIRED_KEY, { dashcamId: CAM, peripheralId: 'AA:BB', name: 'DashPal-C4D5', pairedAt: 1, secure: true });
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
  // The finalize keeps the drive's samples through the continuation hold (they go once the upload is
  // done), so the speed at the event still comes from them: the fixture's 15 m/s.
  expect(facts.events).toEqual([
    { id: '11111111-2222-4333-8444-555555555555', kind: 'drowsy', startedAt: started + 120_000 - 1500, durationS: 1.5, speedMph: expect.closeTo(15 / 0.44704, 6) },
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
  // Start opens the wait; on Android the capture's rows confirm it once 10 mph has held 15 s.
  expect(await rt.drive.start()).toEqual({ ok: true, waiting: true });
  d.source.loadTrace(rows(30, { t0: clock }));
  while (d.source.step()) await rt.drive.settled();
  expect(rt.drive.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(7) });
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

describe('phone-first sound wiring (bootstrap → the DashPal runtime → drive-sense)', () => {
  let restoreOS: (() => void) | null = null;
  afterEach(() => {
    restoreOS?.();
    restoreOS = null;
    mockTransportRef.current = null;
  });

  async function android(paired: boolean, now: () => number = () => clock) {
    restoreOS = jest.replaceProperty(Platform, 'OS', 'android').restore;
    await migrate(db);
    if (paired) await createSettingsRepo(db).set(PAIRED_KEY, { dashcamId: CAM, peripheralId: 'A4:CF:12:B3:C4:D5', name: 'DashPal-C4D5', pairedAt: 1, secure: true });
    const ble = createFakeBle();
    const cam = createFakeDashcam({ ble, id: 'A4:CF:12:B3:C4:D5', mac: [0xa4, 0xcf, 0x12, 0xb3, 0xc4, 0xd5], phones: [{ id: Uint8Array.from(fromHex(PHONE_ID)), kPair: Uint8Array.from(fromHex(K_PAIR)) }] });
    mockTransportRef.current = createBleTransport(ble, { platform: 'android', setTimer: () => 0, clearTimer: () => {} });
    const native = createFakeDriveSense({ platform: 'android', now });
    const d = deps({ dashpal: native, now });
    const rt = await bootstrapApp(d.deps);
    await rt.dashcam!.ready;
    for (let i = 0; i < 80; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    return { rt, native, ble, cam, errors: d.errors, source: d.source };
  }

  test('the player counts as available whenever the ports loaded, with or without a drive: a failed sound means "cannot play" for 30 s and no longer, also during a drive', async () => {
    const t = { now: clock };
    const { rt, source } = await android(false, () => t.now);
    rt.drive.reportAlertsUnavailable();
    expect(rt.dashcam!.link.canPlay(true)).toBe(true);
    // Start opens the wait; the capture's rows confirm the drive (10 mph held 15 s).
    expect(await rt.drive.start()).toEqual({ ok: true, waiting: true });
    source.loadTrace(rows(30, { t0: t.now }));
    while (source.step()) await rt.drive.settled();
    expect(rt.drive.snapshot().status).toBe('recording');
    expect(rt.dashcam!.link.canPlay(true)).toBe(true);
    // A DashPal sound fails during the drive: the host's flag stays set for the rest of the drive
    // (no DashPal sound plays to clear it), the link's rule holds 30 s.
    rt.drive.reportAlertsUnavailable();
    rt.dashcam!.playerUnavailable();
    expect(rt.drive.snapshot().alertsAvailable).toBe(false);
    expect(rt.dashcam!.link.canPlay(true)).toBe(false);
    t.now += 30_000 - 1;
    expect(rt.dashcam!.link.canPlay(true)).toBe(false);
    t.now += 2;
    expect(rt.drive.snapshot().alertsAvailable).toBe(false);
    expect(rt.dashcam!.link.canPlay(true)).toBe(true);
    await rt.drive.end();
    await rt.stop();
  });

  test('the ports did not load: no sound with or without a drive', async () => {
    restoreOS = jest.replaceProperty(Platform, 'OS', 'android').restore;
    const d = deps({
      dashpal: createFakeDriveSense({ platform: 'android', now: () => clock }),
      createPlayer: async () => {
        throw new Error('no ports');
      },
    });
    const rt = await bootstrapApp(d.deps);
    await rt.dashcam!.ready;
    expect(rt.dashcam!.link.canPlay(true)).toBe(false);
    await rt.stop();
  });

  test('the audio probe is drive-sense audioOutputState: a quiet phone cannot play', async () => {
    const { rt, native } = await android(false);
    native.setAudioOutput({ volume: 0.1 });
    expect(rt.dashcam!.link.canPlay(true)).toBe(false);
    native.setAudioOutput({ volume: 0.8, headphones: true });
    expect(rt.dashcam!.link.canPlay(true)).toBe(false);
    native.setAudioOutput({ headphones: false, callActive: true });
    expect(rt.dashcam!.link.canPlay(true)).toBe(false);
    native.setAudioOutput({ callActive: false });
    expect(rt.dashcam!.link.canPlay(true)).toBe(true);
    expect(native.queries).toContain('audioOutputState');
    await rt.stop();
  });

  test('Android with a DashPal paired: the link service runs (connected once linked), a routed ALERT takes the wake lock, the tick is subscribed; forget stops the service', async () => {
    const { rt, native, cam, errors } = await android(true);
    expect(rt.dashcam!.state().link.lifecycle).toBe('connected');
    expect(native.dashpalLink).toBe('connected');
    expect(native.calls.filter((c) => c.startsWith('setDashpalLink'))).toEqual(['setDashpalLink:waiting', 'setDashpalLink:connected']);
    expect(native.listenerCount('dashpalLinkTick')).toBe(1);
    cam.notify(encodeTx({ type: 'ALERT', alertId: 5, sound: 1, tier: 2, level: 0, mode: 1, route: 1, uptimeMs: 1000 }));
    expect(native.holdAwakeCalls).toEqual([5000]);
    await rt.dashcam!.forget();
    for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(native.dashpalLink).toBeNull();
    expect(errors.filter((e) => e.includes('link service'))).toEqual([]);
    await rt.stop();
    // The runtime's teardown leaves no tick listener behind.
    expect(native.listenerCount('dashpalLinkTick')).toBe(0);
  });

  test('iOS: no link service and no wake lock, the probe still decides', async () => {
    restoreOS = jest.replaceProperty(Platform, 'OS', 'ios').restore;
    await migrate(db);
    await createSettingsRepo(db).set(PAIRED_KEY, { dashcamId: CAM, peripheralId: '7D3E1C20-4B6A-4E8F-9A21-0C6E5A7D2B10', name: 'DashPal-C4D5', pairedAt: 1, secure: true });
    const native = createFakeDriveSense({ platform: 'ios', now: () => clock });
    const rt = await bootstrapApp(deps({ dashpal: native }).deps);
    await rt.dashcam!.ready;
    for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(native.calls.filter((c) => c.startsWith('setDashpalLink'))).toEqual([]);
    expect(native.listenerCount('dashpalLinkTick')).toBe(0);
    native.setAudioOutput({ volume: 0 });
    expect(rt.dashcam!.link.canPlay(true)).toBe(false);
    await rt.stop();
  });
});
