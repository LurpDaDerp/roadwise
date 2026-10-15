/** @jest-environment node */
import * as SecureStore from 'expo-secure-store';

import type { AlertPlayer } from '@/core/alerts/player';
import type { FeatureRow } from '@/core/engine/types';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';

import { createFakeBle, type FakeBle } from '../fakeTransport';
import { BT_OPT_IN_KEY, BUZZER_TOO_KEY, ENABLED_SECURE_KEY, PAIRED_KEY, type PairedDashcam } from '../keys';
import { decodeRx, encodeInfo, RX_CHAR } from '../protocol';
import { createDashcamRuntime, MIN_MOVING_S, type DashcamRuntime } from '../runtime';
import { PERIPHERAL_SECURE_KEY } from '../secure';
import { createDashcamStore } from '../store';
import { createBleTransport, type DashcamTransport } from '../transport';

const secure = SecureStore as unknown as { getItemAsync: jest.Mock; setItemAsync: jest.Mock; deleteItemAsync: jest.Mock };
// The global mock has no keychain constants, so the options argument is undefined here
// (secure.test.ts checks AFTER_FIRST_UNLOCK against a mock that has it).

const CAM = 'a4cf12b3c4d5';
const PID = 'AA:BB:CC:DD:EE:FF';
const TRIP = '11111111-1111-4111-8111-111111111111';
const PAIRED: PairedDashcam = { dashcamId: CAM, peripheralId: PID, name: 'DashPal-C4D5', pairedAt: 5 };
const INFO = encodeInfo({ ver: 1, protoMin: 1, protoMax: 1, fwMajor: 3, fwMinor: 3, mac: [0xa4, 0xcf, 0x12, 0xb3, 0xc4, 0xd5], peerBonded: true, bondCount: 1, pairingOpen: false });

const flush = async () => {
  for (let i = 0; i < 80; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  secure.setItemAsync.mockClear();
  secure.deleteItemAsync.mockClear();
});

interface Rig {
  rt: DashcamRuntime;
  ble: FakeBle;
  transportCalls: number;
  repeats: { live: number; created: number };
  host: { recording: boolean; driveOpen: boolean; playerAvailable: boolean; callActive: boolean };
  appState: { currentState: string; emit(s: string): void; addEventListener(t: 'change', fn: (s: string) => void): { remove(): void } };
  errors: string[];
}

function rig(platform: 'ios' | 'android' = 'android', foreground = true): Rig {
  const ble = createFakeBle();
  ble.addPeripheral({ id: PID, info: INFO });
  let transport: DashcamTransport | null = null;
  const errors: string[] = [];
  const repeats = { live: 0, created: 0 };
  const listeners = new Set<(s: string) => void>();
  const appState = {
    currentState: foreground ? 'active' : 'background',
    emit(s: string) {
      appState.currentState = s;
      for (const fn of [...listeners]) fn(s);
    },
    addEventListener: (_t: 'change', fn: (s: string) => void) => {
      listeners.add(fn);
      return { remove: () => void listeners.delete(fn) };
    },
  };
  const host = { recording: false, driveOpen: false, playerAvailable: true, callActive: false };
  const player: AlertPlayer = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} };
  const r: Rig = {
    rt: null as unknown as DashcamRuntime,
    ble,
    transportCalls: 0,
    repeats,
    host,
    appState,
    errors,
  };
  r.rt = createDashcamRuntime({
    db,
    player,
    transport: () => {
      r.transportCalls += 1;
      transport ??= createBleTransport(ble, { platform, setTimer: () => 0, clearTimer: () => {} });
      return transport;
    },
    host: () => host,
    styleAllowsSound: () => true,
    platform,
    appState,
    now: () => 1_791_600_000_000,
    newId: () => '00000000-0000-4000-8000-000000000001',
    setTimer: () => 0,
    clearTimer: () => {},
    setRepeat: () => {
      repeats.live += 1;
      repeats.created += 1;
      return repeats.created;
    },
    clearRepeat: () => void (repeats.live -= 1),
    onError: (e, ctx) => errors.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`),
  });
  return r;
}

test('no DashPal and no opt-in: the transport is never created, and the next launch will not start the BLE manager', async () => {
  const r = rig();
  await r.rt.ready;
  expect(r.transportCalls).toBe(0);
  expect(r.rt.state()).toMatchObject({ loaded: true, buzzerToo: false, btOptIn: false, link: { lifecycle: 'unpaired' } });
  expect(secure.deleteItemAsync).toHaveBeenCalledWith(ENABLED_SECURE_KEY, undefined);
  expect(secure.deleteItemAsync).toHaveBeenCalledWith(PERIPHERAL_SECURE_KEY, undefined);
  expect(r.repeats.created).toBe(0);
});

test('an opted-in phone without a pairing keeps the launch flag', async () => {
  await createSettingsRepo(db).set(BT_OPT_IN_KEY, true);
  const r = rig();
  await r.rt.ready;
  expect(secure.deleteItemAsync).not.toHaveBeenCalledWith(ENABLED_SECURE_KEY, undefined);
  expect(r.rt.state().btOptIn).toBe(true);
});

test('a paired dashcam: settings loaded, the transport started and connected, the 1 s tick only while in the foreground', async () => {
  await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
  await createSettingsRepo(db).set(BUZZER_TOO_KEY, true);
  const r = rig();
  await r.rt.ready;
  await flush();
  expect(r.rt.state()).toMatchObject({ buzzerToo: true, link: { lifecycle: 'connected', paired: PAIRED } });
  expect(r.ble.calls).toContain(`connect:${PID}:auto`);
  expect(r.repeats.live).toBe(1);
  r.appState.emit('background');
  expect(r.repeats.live).toBe(0);
  r.appState.emit('active');
  expect(r.repeats.live).toBe(1);
  // The link's first frame went out over the transport: COMMAND 7 hello.
  expect(r.ble.writes.map((w) => [w.characteristic, decodeRx(w.bytes)])).toEqual([[RX_CHAR, { ok: true, frame: { type: 'COMMAND', op: 7, arg: 0 } }]]);
  r.rt.dispose();
  expect(r.repeats.live).toBe(0);
});

test('pair: settings, opt-in and both SecureStore entries, then connect; forget: COMMAND 4, cancel, Android removeBond, everything cleared', async () => {
  const r = rig('android');
  await r.rt.ready;
  await r.rt.pair(PAIRED);
  await flush();
  const settings = createSettingsRepo(db);
  expect(await settings.get(PAIRED_KEY)).toEqual(PAIRED);
  expect(await settings.get(BT_OPT_IN_KEY)).toBe(true);
  expect(secure.setItemAsync).toHaveBeenCalledWith(ENABLED_SECURE_KEY, '1', undefined);
  expect(secure.setItemAsync).toHaveBeenCalledWith(PERIPHERAL_SECURE_KEY, JSON.stringify({ peripheralId: PID, dashcamId: CAM }), undefined);
  expect(r.rt.state().link.lifecycle).toBe('connected');

  r.ble.writes.length = 0;
  await r.rt.forget();
  await flush();
  expect(r.ble.writes.map((w) => decodeRx(w.bytes))).toEqual([{ ok: true, frame: { type: 'COMMAND', op: 4, arg: 0 } }]);
  expect(r.ble.calls).toContain(`disconnect:${PID}`);
  expect(r.ble.calls).toContain(`removeBond:${PID}`);
  expect(await settings.get(PAIRED_KEY)).toBeNull();
  expect(secure.deleteItemAsync).toHaveBeenCalledWith(PERIPHERAL_SECURE_KEY, undefined);
  expect(r.rt.state().link.lifecycle).toBe('unpaired');
  // Forgotten: no reconnect.
  const connects = r.ble.calls.filter((c) => c.startsWith('connect')).length;
  r.ble.drop(PID);
  await flush();
  expect(r.ble.calls.filter((c) => c.startsWith('connect')).length).toBe(connects);
});

test('iOS forget never calls removeBond (the driver forgets it in Settings › Bluetooth)', async () => {
  await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
  const r = rig('ios');
  await r.rt.ready;
  await r.rt.forget();
  expect(r.ble.calls.some((c) => c.startsWith('removeBond'))).toBe(false);
});

const row = (speed: number): FeatureRow => ({
  ts: 0, lat: 0, lng: 0, hAcc: 5, speed, speedAcc: 0.5, course: 0, alt: 0, gnssValid: true,
  aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0, jerkMax: 0, gravityStability: 1, orientationDelta: 0, handlingScore: 0,
  locked: false, screenOn: true, appForeground: true,
});

test('estimateOn follows the drive totals (≥ 60 s moving, ≥ 80 % covered); adopt reloads them from the drive', async () => {
  await createTripsRepo(db).insert({ client_trip_id: TRIP, started_at: 0, tz: 'UTC', status: 'recording' }, 0);
  await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
  const r = rig();
  await r.rt.ready;
  const drive = { clientTripId: TRIP, recording: true, dryRun: false };
  for (let i = 0; i < MIN_MOVING_S; i++) r.rt.row(row(10), drive);
  // Connected but no live/primary STATUS: moving, not covered.
  expect(r.rt.estimateOn(TRIP)).toBe(false);
  await r.rt.link.settled();
  expect(await createDashcamStore(db).coverage(TRIP)).toMatchObject({ movingS: 60, coveredS: 0 });

  // A relaunch continues the drive: totals come back from SQLite.
  await createDashcamStore(db).addCoverage(TRIP, 0, 60, null);
  const again = rig();
  await again.rt.ready;
  expect(again.rt.estimateOn(TRIP)).toBe(false);
  await again.rt.adopt(TRIP);
  expect(again.rt.estimateOn(TRIP)).toBe(true);
  expect(again.rt.estimateOn(null)).toBe(false);
});

test('Android in the background (JS timers paused): the drive-end wait does not hang, and a backgrounding mid-wait ends it', async () => {
  // This rig's timers never fire, like Android's while the app is in the background. The link is
  // connected but not synced (COMMAND 7 got no HELLO).
  await createTripsRepo(db).insert({ client_trip_id: TRIP, started_at: 0, tz: 'UTC', status: 'recording' }, 0);
  await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
  const bg = rig('android', false);
  await bg.rt.ready;
  await flush();
  expect(bg.rt.state().link).toMatchObject({ lifecycle: 'connected', synced: false });
  await bg.rt.beforeFinalize(TRIP);

  const fg = rig('android', true);
  await fg.rt.ready;
  await flush();
  expect(fg.rt.state().link).toMatchObject({ lifecycle: 'connected', synced: false });
  let done = false;
  const ending = fg.rt.beforeFinalize(TRIP).then(() => (done = true));
  await flush();
  expect(done).toBe(false);
  fg.appState.emit('background');
  await ending;
  expect(await createDashcamStore(db).coverage(TRIP)).toBeNull();
  expect([...bg.errors, ...fg.errors]).toEqual([]);
});

test('setBuzzerToo is saved and reaches the next STATE; optIn writes the launch flag', async () => {
  const r = rig();
  await r.rt.ready;
  await r.rt.setBuzzerToo(true);
  expect(await createSettingsRepo(db).get(BUZZER_TOO_KEY)).toBe(true);
  expect(r.rt.state().buzzerToo).toBe(true);
  await r.rt.optIn();
  expect(secure.setItemAsync).toHaveBeenCalledWith(ENABLED_SECURE_KEY, '1', undefined);
  expect(r.rt.state().btOptIn).toBe(true);
});

test('a transport that cannot be created is reported once and the runtime keeps working', async () => {
  await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
  let calls = 0;
  const rt = createDashcamRuntime({
    db,
    player: { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} },
    transport: () => {
      calls += 1;
      throw new Error('BleManagerModule not found');
    },
    host: () => ({ recording: false, driveOpen: false, playerAvailable: true, callActive: false }),
    styleAllowsSound: () => true,
    platform: 'android',
    newId: () => 'x',
    setRepeat: () => 1,
    clearRepeat: () => {},
  });
  await rt.ready;
  expect(rt.transport()).toBeNull();
  expect(calls).toBe(1);
  expect(rt.state().link.lifecycle).toBe('idle');
  await expect(rt.command(1)).resolves.toBe(false);
  rt.dispose();
});

test('a screen that created the transport before the settings were read: the already-linked dashcam still reaches the link', async () => {
  await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
  const ble = createFakeBle();
  ble.addPeripheral({ id: PID, info: INFO });
  const t = createBleTransport(ble, { platform: 'android', setTimer: () => 0, clearTimer: () => {} });
  // The transport is up before the runtime exists (early start).
  t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await t.start();
  await flush();
  expect(t.linked()).toBe(true);
  const rt = createDashcamRuntime({
    db,
    player: { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} },
    transport: () => t,
    host: () => ({ recording: false, driveOpen: false, playerAvailable: true, callActive: false }),
    styleAllowsSound: () => true,
    platform: 'android',
    newId: () => 'x',
    setRepeat: () => 1,
    clearRepeat: () => {},
  });
  // A screen asks for the transport before `ready` read the pairing.
  expect(rt.transport()).toBe(t);
  await rt.ready;
  await flush();
  expect(rt.state().link.lifecycle).toBe('connected');
  // …without dropping and re-making the connection.
  expect(ble.calls.filter((c) => c.startsWith('connect'))).toHaveLength(1);
  expect(ble.calls.filter((c) => c.startsWith('disconnect'))).toHaveLength(0);
  expect(ble.writes.some((w) => decodeRx(w.bytes).ok && (decodeRx(w.bytes) as { frame: { type: string } }).frame.type === 'COMMAND')).toBe(true);
  rt.dispose();
});
