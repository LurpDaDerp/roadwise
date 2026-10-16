/** @jest-environment node */
import type { AlertPlayer } from '@/core/alerts/player';
import type { FeatureRow } from '@/core/engine/types';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { createPausableTimerBase } from '@/lib/__fixtures__/pausableTimers';
import { createPumpedTimers, processTimers } from '@/lib/timers';

import { createFakeDashcam, type FakeDashcam } from '../__fixtures__/fakeDashcam';
import { createFakeBle, type FakeBle } from '../fakeTransport';
import { BT_OPT_IN_KEY, BUZZER_TOO_KEY, ENABLED_SECURE_KEY, LAST_PHONES_KEY, PAIRED_KEY, type PairedDashcam } from '../keys';
import { parseCode, formatCode } from '../label';
import { decodeRx, encodeTx, fromHex, RX_CHAR, toHex } from '../protocol';
import { AUDIO_PROBE_MEMO_MS, createDashcamRuntime, linkServiceStateFor, MIN_MOVING_S, type DashcamRuntime, type LinkServicePort, type LinkServiceResult, type LinkServiceState } from '../runtime';
import { AUTH_SECURE_KEY, createDashpalSecrets, PERIPHERAL_SECURE_KEY, type DashpalSecrets } from '../secure';
import { createDashcamStore } from '../store';
import { createBleTransport, SOFT_REPAIR_FIRST_MS, type DashcamTransport } from '../transport';

const CAM = 'a4cf12b3c4d5';
const MAC = [0xa4, 0xcf, 0x12, 0xb3, 0xc4, 0xd5];
const PID = 'A4:CF:12:B3:C4:D5';
const TRIP = '11111111-1111-4111-8111-111111111111';
const PAIRED: PairedDashcam = { dashcamId: CAM, peripheralId: PID, name: 'DashPal-C4D5', pairedAt: 5, secure: true };
const PHONE_ID = '0102030405060708';
const K_PAIR = '42'.repeat(32);
const S = Uint8Array.from({ length: 16 }, (_, i) => i);

const flush = async () => {
  for (let i = 0; i < 120; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

let db: Db;
/** The phone's SecureStore (an in-memory one: the runtime reads its key from it). */
const mem = new Map<string, string>();
let secrets: DashpalSecrets;

async function seedKey(dashcamId = CAM): Promise<void> {
  await secrets.writePendingAuth({ dashcamId, phoneId: PHONE_ID, kPair: K_PAIR, code: null });
  await secrets.finalizeAuth();
}

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  mem.clear();
  secrets = createDashpalSecrets(() => ({
    getItemAsync: async (k: string) => mem.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void mem.set(k, v),
    deleteItemAsync: async (k: string) => void mem.delete(k),
  }));
  await seedKey();
});

/** A link v2 DashPal that knows this phone (unless `known: false`). */
function dashcam(ble: FakeBle, o: { known?: boolean } = {}): FakeDashcam {
  return createFakeDashcam({ ble, id: PID, mac: MAC, S, phones: o.known === false ? [] : [{ id: Uint8Array.from(fromHex(PHONE_ID)), kPair: Uint8Array.from(fromHex(K_PAIR)) }] });
}

interface Rig {
  rt: DashcamRuntime;
  ble: FakeBle;
  cam: FakeDashcam;
  transportCalls: number;
  repeats: { live: number; created: number };
  host: { recording: boolean; driveOpen: boolean; playerAvailable: boolean; callActive: boolean };
  appState: { currentState: string; emit(s: string): void; addEventListener(t: 'change', fn: (s: string) => void): { remove(): void } };
  errors: string[];
  clock: { t: number };
}

function rig(platform: 'ios' | 'android' = 'android', foreground = true, o: { known?: boolean } = {}): Rig {
  const ble = createFakeBle();
  const cam = dashcam(ble, o);
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
  const clock = { t: 1_791_600_000_000 };
  const r: Rig = { rt: null as unknown as DashcamRuntime, ble, cam, transportCalls: 0, repeats, host, appState, errors, clock };
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
    now: () => clock.t,
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
    secrets,
    ensureInstallMarker: async () => {},
  });
  return r;
}

test('no DashPal and no opt-in: the transport is never created, and the next launch will not start the BLE manager', async () => {
  mem.set(ENABLED_SECURE_KEY, '1');
  mem.set(PERIPHERAL_SECURE_KEY, JSON.stringify({ peripheralId: PID, dashcamId: CAM }));
  const r = rig();
  await r.rt.ready;
  expect(r.transportCalls).toBe(0);
  expect(r.rt.state()).toMatchObject({ loaded: true, buzzerToo: false, btOptIn: false, newPhone: false, link: { lifecycle: 'unpaired' } });
  expect(mem.has(ENABLED_SECURE_KEY)).toBe(false);
  expect(mem.has(PERIPHERAL_SECURE_KEY)).toBe(false);
  expect(r.repeats.created).toBe(0);
});

test('an opted-in phone without a pairing keeps the launch flag', async () => {
  mem.set(ENABLED_SECURE_KEY, '1');
  await createSettingsRepo(db).set(BT_OPT_IN_KEY, true);
  const r = rig();
  await r.rt.ready;
  expect(mem.get(ENABLED_SECURE_KEY)).toBe('1');
  expect(r.rt.state().btOptIn).toBe(true);
});

test('a link v1 pairing (no secure flag) is dropped at load with its SecureStore peripheral: the app is unpaired', async () => {
  const { secure: _s, ...v1 } = PAIRED;
  void _s;
  await createSettingsRepo(db).set(PAIRED_KEY, v1);
  mem.set(PERIPHERAL_SECURE_KEY, JSON.stringify({ peripheralId: PID, dashcamId: CAM }));
  const r = rig();
  await r.rt.ready;
  expect(r.rt.state().link.lifecycle).toBe('unpaired');
  expect(await createSettingsRepo(db).get(PAIRED_KEY)).toBeNull();
  expect(mem.has(PERIPHERAL_SECURE_KEY)).toBe(false);
  expect(r.transportCalls).toBe(0);
});

test('a pairing whose key is not on this phone (a backup restored to another phone) is dropped: nothing can connect with it', async () => {
  mem.delete(AUTH_SECURE_KEY);
  await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
  const r = rig();
  await r.rt.ready;
  expect(r.rt.state().link.lifecycle).toBe('unpaired');
  expect(await createSettingsRepo(db).get(PAIRED_KEY)).toBeNull();
  // and a key for another DashPal is no key for this one
  mem.clear();
  await seedKey('0123456789ab');
  await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
  const r2 = rig();
  await r2.rt.ready;
  expect(r2.rt.state().link.lifecycle).toBe('unpaired');
});

test('a paired dashcam: settings loaded, the key read, the transport connected through a session, the 1 s tick only while in the foreground', async () => {
  await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
  await createSettingsRepo(db).set(BUZZER_TOO_KEY, true);
  const r = rig();
  await r.rt.ready;
  await flush();
  expect(r.rt.state()).toMatchObject({ buzzerToo: true, link: { lifecycle: 'connected', paired: PAIRED } });
  expect(r.ble.calls).toContain(`connect:${PID}:auto`);
  expect(r.cam.conn()?.state).toBe('up');
  expect(r.repeats.live).toBe(1);
  r.appState.emit('background');
  expect(r.repeats.live).toBe(0);
  r.appState.emit('active');
  expect(r.repeats.live).toBe(1);
  // The link's first frame went out sealed: COMMAND 7 hello.
  expect(r.cam.received[0]).toEqual({ type: 'COMMAND', op: 7, arg: 0 });
  expect(r.ble.writes.filter((w) => w.characteristic === RX_CHAR).every((w) => !decodeRx(w.bytes).ok)).toBe(true);
  r.rt.dispose();
  expect(r.repeats.live).toBe(0);
});

test('pair: needs the final key; settings, opt-in and both SecureStore entries, then connect; forget: COMMAND 4, cancel, the key deleted, no OS bond step', async () => {
  const r = rig('android');
  await r.rt.ready;
  // no key for this DashPal: refused
  mem.delete(AUTH_SECURE_KEY);
  await expect(r.rt.pair(PAIRED)).rejects.toThrow('no pairing key');
  await seedKey();
  await r.rt.pair(PAIRED);
  await flush();
  const settings = createSettingsRepo(db);
  expect(await settings.get(PAIRED_KEY)).toEqual(PAIRED);
  expect(await settings.get(BT_OPT_IN_KEY)).toBe(true);
  expect(mem.get(ENABLED_SECURE_KEY)).toBe('1');
  expect(mem.get(PERIPHERAL_SECURE_KEY)).toBe(JSON.stringify({ peripheralId: PID, dashcamId: CAM }));
  expect(r.rt.state().link.lifecycle).toBe('connected');

  r.cam.received.length = 0;
  await r.rt.forget();
  await flush();
  expect(r.cam.received).toEqual([{ type: 'COMMAND', op: 4, arg: 0 }]);
  expect(r.cam.phones.size).toBe(0);
  expect(r.ble.calls).toContain(`disconnect:${PID}`);
  expect(r.ble.calls.some((c) => /Bond/.test(c))).toBe(false);
  expect(await settings.get(PAIRED_KEY)).toBeNull();
  expect(mem.has(AUTH_SECURE_KEY)).toBe(false);
  expect(mem.has(PERIPHERAL_SECURE_KEY)).toBe(false);
  expect(r.rt.state().link.lifecycle).toBe('unpaired');
  const connects = r.ble.calls.filter((c) => c.startsWith('connect')).length;
  r.ble.drop(PID);
  await flush();
  expect(r.ble.calls.filter((c) => c.startsWith('connect')).length).toBe(connects);
});

test('forget while not connected: the key and the pairing still go (the dashcam keeps a record until 10 presses or eviction)', async () => {
  await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
  const r = rig('ios');
  await r.rt.ready;
  await r.rt.forget();
  expect(mem.has(AUTH_SECURE_KEY)).toBe(false);
  expect(r.cam.received).toEqual([]);
});

test('a soft repair waits; RoadWise coming to the front and a drive starting each retry at once', async () => {
  await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
  const r = rig('android', true, { known: false });
  await r.rt.ready;
  await flush();
  expect(r.rt.state().link.lifecycle).toBe('needs_repair');
  const connects = () => r.ble.calls.filter((c) => c.startsWith('connect')).length;
  const n = connects();
  r.appState.emit('background');
  r.appState.emit('active');
  await flush();
  expect(connects()).toBe(n + 1);
  r.rt.row(row(10), { clientTripId: TRIP, recording: false, dryRun: false });
  await flush();
  expect(connects()).toBe(n + 1);
  r.rt.row(row(10), { clientTripId: TRIP, recording: true, dryRun: false });
  await flush();
  expect(connects()).toBe(n + 2);
  r.rt.row(row(10), { clientTripId: TRIP, recording: true, dryRun: false });
  await flush();
  expect(connects()).toBe(n + 2); // only the start
  r.cam.phones.set(PHONE_ID, Uint8Array.from(fromHex(K_PAIR)));
  r.appState.emit('background');
  r.appState.emit('active');
  await flush();
  expect(r.rt.state().link.lifecycle).toBe('connected');
  r.rt.dispose();
});

describe('Add another phone and the new-phone notice', () => {
  async function connected(): Promise<Rig> {
    await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
    const r = rig();
    await r.rt.ready;
    await flush();
    expect(r.rt.state().link.lifecycle).toBe('connected');
    return r;
  }
  const status = (bondCount: number) => encodeTx({ type: 'STATUS', uptimeMs: 1, state: 3, flags: 0, fpsX10: 150, tempC: 30, bondCount });

  test('Add another phone: a one-time code sent sealed in ADD_PHONE (the dashcam opens its window for it); never stored', async () => {
    const r = await connected();
    const code = await r.rt.addPhone();
    expect(code?.kind).toBe('once');
    expect(parseCode(formatCode(code!.S, 'once'))?.kind).toBe('once');
    await flush();
    expect(toHex(r.cam.once!)).toBe(toHex(code!.S));
    expect(r.cam.windowOpen).toBe(true);
    expect([...mem.values()].some((v) => v.includes(toHex(code!.S)))).toBe(false);
    r.rt.dispose();
  });

  test('Add another phone while not connected: nothing sent', async () => {
    const r = rig();
    await r.rt.ready;
    expect(await r.rt.addPhone()).toBeNull();
  });

  test('a first count is adopted silently; a rise this phone did not cause raises the notice once; a fall lowers the count; dismiss is remembered', async () => {
    const r = await connected();
    r.cam.notify(status(1));
    await flush();
    expect(r.rt.state().newPhone).toBe(false);
    r.clock.t += 1000;
    r.cam.notify(status(2));
    await flush();
    expect(r.rt.state().newPhone).toBe(true);
    await r.rt.dismissNewPhone();
    expect(r.rt.state().newPhone).toBe(false);
    expect(await createSettingsRepo(db).get(LAST_PHONES_KEY)).toMatchObject({ dashcamId: CAM, count: 2, notice: false });
    r.clock.t += 1000;
    r.cam.notify(status(1));
    await flush();
    r.clock.t += 1000;
    r.cam.notify(encodeTx({ type: 'PAIRED', bondCount: 2 }));
    await flush();
    expect(r.rt.state().newPhone).toBe(true);
    r.rt.dispose();
    // a relaunch keeps the notice; forget clears it
    const again = rig();
    await again.rt.ready;
    expect(again.rt.state().newPhone).toBe(true);
    await again.rt.forget();
    expect(await createSettingsRepo(db).get(LAST_PHONES_KEY)).toBeNull();
  });

  test('a rise within 3 min of this phone’s own Add another phone, or its own setup, is no notice', async () => {
    const r = await connected();
    r.cam.notify(status(1));
    await flush();
    await r.rt.addPhone();
    r.clock.t += 2 * 60_000;
    r.cam.notify(status(2));
    await flush();
    expect(r.rt.state().newPhone).toBe(false);
    r.rt.notePhones(CAM, 3);
    r.clock.t += 1000;
    r.cam.notify(status(3));
    await flush();
    expect(r.rt.state().newPhone).toBe(false);
    r.clock.t += 4 * 60_000;
    r.cam.notify(status(4));
    await flush();
    expect(r.rt.state().newPhone).toBe(true);
    r.rt.dispose();
  });
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
  expect(mem.get(ENABLED_SECURE_KEY)).toBe('1');
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
    secrets,
    ensureInstallMarker: async () => {},
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
  dashcam(ble);
  const t = createBleTransport(ble, { platform: 'android', setTimer: () => 0, clearTimer: () => {} });
  // The transport is up before the runtime exists (early start).
  t.setTarget({ peripheralId: PID, dashcamId: CAM, auth: { phoneId: PHONE_ID, kPair: K_PAIR } });
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
    secrets,
    ensureInstallMarker: async () => {},
  });
  // A screen asks for the transport before `ready` read the pairing.
  expect(rt.transport()).toBe(t);
  await rt.ready;
  await flush();
  expect(rt.state().link.lifecycle).toBe('connected');
  // …without dropping and re-making the connection.
  expect(ble.calls.filter((c) => c.startsWith('connect'))).toHaveLength(1);
  expect(ble.calls.filter((c) => c.startsWith('disconnect'))).toHaveLength(0);
  expect(ble.writes.some((w) => w.characteristic === RX_CHAR)).toBe(true);
  rt.dispose();
});

describe('phone-first sound: the audio probe and the Android DashPal link service', () => {
  function fakeService(o: { running?: boolean } = {}) {
    const calls: LinkServiceState[] = [];
    const ticks = new Set<() => void>();
    const st = { running: o.running ?? false, allowStart: true, holding: false, held: [] as (() => void)[], runningThrows: false };
    const port: LinkServicePort = {
      set: (want) => {
        calls.push(want);
        return new Promise<LinkServiceResult>((resolve) => {
          const finish = () => {
            if (want === 'off') {
              st.running = false;
              resolve('stopped');
            } else if (st.running) resolve('running');
            else if (st.allowStart) {
              st.running = true;
              resolve('running');
            } else resolve('refused');
          };
          if (st.holding) st.held.push(finish);
          else finish();
        });
      },
      running: () => {
        if (st.runningThrows) throw new Error('running');
        return st.running;
      },
      onTick: (fn) => {
        ticks.add(fn);
        return { remove: () => void ticks.delete(fn) };
      },
    };
    return { port, calls, ticks, st, release: () => st.held.splice(0).forEach((f) => f()) };
  }

  function svcRig(o: { platform?: 'ios' | 'android'; foreground?: boolean; service?: ReturnType<typeof fakeService>; audio?: () => { callActive: boolean; volume: number | null; headphones: boolean | null }; clock?: { t: number }; host?: { recording: boolean; driveOpen: boolean; playerAvailable: boolean; callActive: boolean } } = {}) {
    const platform = o.platform ?? 'android';
    const ble = createFakeBle();
    dashcam(ble);
    let transport: DashcamTransport | null = null;
    const errors: string[] = [];
    const listeners = new Set<(s: string) => void>();
    const appState = {
      currentState: o.foreground === false ? 'background' : 'active',
      emit(s: string) {
        appState.currentState = s;
        for (const fn of [...listeners]) fn(s);
      },
      addEventListener: (_t: 'change', fn: (s: string) => void) => {
        listeners.add(fn);
        return { remove: () => void listeners.delete(fn) };
      },
    };
    const clock = o.clock ?? { t: 1_791_600_000_000 };
    const player: AlertPlayer = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} };
    const rt = createDashcamRuntime({
      db,
      player,
      transport: () => (transport ??= createBleTransport(ble, { platform, setTimer: () => 0, clearTimer: () => {} })),
      host: () => o.host ?? { recording: false, driveOpen: false, playerAvailable: true, callActive: false },
      styleAllowsSound: () => true,
      platform,
      appState,
      now: () => clock.t,
      newId: () => '00000000-0000-4000-8000-000000000001',
      setTimer: () => 0,
      clearTimer: () => {},
      setRepeat: () => 0,
      clearRepeat: () => {},
      onError: (e, ctx) => errors.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`),
      ...(o.audio ? { audioOutput: o.audio } : {}),
      ...(o.service ? { linkService: o.service.port } : {}),
      secrets,
      ensureInstallMarker: async () => {},
    });
    return { rt, ble, appState, errors, clock };
  }

  test('the probe memo: two reads within 500 ms are one native read; a fresh read always reads; a throwing probe is reported and reads as unknown', async () => {
    let reads = 0;
    let fail = false;
    const clock = { t: 1_791_600_000_000 };
    const r = svcRig({
      clock,
      audio: () => {
        reads += 1;
        if (fail) throw new Error('no audio manager');
        return { callActive: false, volume: 0.1, headphones: false };
      },
    });
    await r.rt.ready;
    expect(r.rt.link.canPlay()).toBe(false); // volume 0.1
    clock.t += AUDIO_PROBE_MEMO_MS;
    expect(r.rt.link.canPlay()).toBe(false);
    expect(reads).toBe(1);
    expect(r.rt.link.canPlay(true)).toBe(false);
    expect(reads).toBe(2);
    clock.t += AUDIO_PROBE_MEMO_MS + 1;
    r.rt.link.canPlay();
    expect(reads).toBe(3);
    fail = true;
    expect(r.rt.link.canPlay(true)).toBe(true); // unknown never blocks a sound
    expect(r.errors.some((e) => e.startsWith('audio output: no audio manager'))).toBe(true);
    r.rt.dispose();
  });

  test('the mapping (integration R3): off with no DashPal or Bluetooth not allowed; connected while linked; waiting for everything else, every repair and verification state included', () => {
    expect(linkServiceStateFor(false, 'connected')).toBe('off');
    expect(linkServiceStateFor(true, 'unpaired')).toBe('off');
    expect(linkServiceStateFor(true, 'unauthorized')).toBe('off');
    expect(linkServiceStateFor(true, 'connected')).toBe('connected');
    for (const l of ['idle', 'connecting', 'bluetooth_off', 'needs_repair', 'unverified'] as const) expect(linkServiceStateFor(true, l)).toBe('waiting');
  });

  test('cross-area (pairing v2 §8.2): an Android drive in the background, R_UNKNOWN_PHONE: the service never stops, the 30-s retry fires through its tick, then connected', async () => {
    await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
    const base = createPausableTimerBase(0);
    const pumped = createPumpedTimers(base);
    const pump = jest.spyOn(processTimers, 'pump').mockImplementation(() => pumped.pump());
    const svc = fakeService();
    const ble = createFakeBle();
    const cam = dashcam(ble, { known: false });
    const listeners = new Set<(s: string) => void>();
    const appState = {
      currentState: 'active',
      emit(s: string) {
        appState.currentState = s;
        for (const fn of [...listeners]) fn(s);
      },
      addEventListener: (_t: 'change', fn: (s: string) => void) => {
        listeners.add(fn);
        return { remove: () => void listeners.delete(fn) };
      },
    };
    const rt = createDashcamRuntime({
      db,
      player: { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} },
      transport: () => createBleTransport(ble, { platform: 'android', now: base.now, setTimer: (fn, ms) => pumped.setTimeout(fn, ms), clearTimer: (h) => pumped.clearTimeout(h), pump: () => pumped.pump() }),
      host: () => ({ recording: true, driveOpen: true, playerAvailable: true, callActive: false }),
      styleAllowsSound: () => true,
      platform: 'android',
      appState,
      now: () => 1_791_600_000_000 + base.now(),
      newId: () => 'x',
      setTimer: (fn, ms) => pumped.setTimeout(fn, ms),
      clearTimer: (h) => pumped.clearTimeout(h),
      setRepeat: () => 0,
      clearRepeat: () => {},
      linkService: svc.port,
      secrets,
      ensureInstallMarker: async () => {},
    });
    await rt.ready;
    await flush();
    expect(rt.state().link.lifecycle).toBe('needs_repair');
    expect(svc.st.running).toBe(true);
    appState.emit('background');
    base.pause(true);
    cam.phones.set(PHONE_ID, Uint8Array.from(fromHex(K_PAIR)));
    base.advance(SOFT_REPAIR_FIRST_MS + 1000);
    await flush();
    expect(rt.state().link.lifecycle).toBe('needs_repair'); // the timer is due but JS timers are paused
    for (const tick of svc.ticks) tick();
    await flush();
    expect(rt.state().link.lifecycle).toBe('connected');
    expect(svc.calls).not.toContain('off');
    expect(svc.calls.at(-1)).toBe('connected');
    expect(svc.st.running).toBe(true);
    pump.mockRestore();
    rt.dispose();
  });

  test('no DashPal: never started; iOS: never driven even when given a service', async () => {
    const svc = fakeService();
    const r = svcRig({ service: svc });
    await r.rt.ready;
    await flush();
    expect(svc.calls).toEqual([]);
    r.rt.dispose();
    await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
    const ios = fakeService();
    const r2 = svcRig({ platform: 'ios', service: ios });
    await r2.rt.ready;
    await flush();
    expect(ios.calls).toEqual([]);
    expect(ios.ticks.size).toBe(0);
    r2.rt.dispose();
  });

  test('paired, in front: started waiting, connected once linked; Bluetooth off and a repair keep it waiting; Bluetooth not allowed and forget stop it', async () => {
    await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
    const svc = fakeService();
    const r = svcRig({ service: svc });
    await r.rt.ready;
    await flush();
    expect(r.rt.state().link.lifecycle).toBe('connected');
    expect(svc.calls).toEqual(['waiting', 'connected']);
    expect(svc.st.running).toBe(true);
    r.ble.setState('off');
    await flush();
    expect(r.rt.state().link.lifecycle).toBe('bluetooth_off');
    expect(svc.calls.at(-1)).toBe('waiting');
    r.ble.setState('on');
    await flush();
    expect(svc.calls.at(-1)).toBe('connected');
    r.ble.setState('unauthorized');
    await flush();
    expect(r.rt.state().link.lifecycle).toBe('unauthorized');
    expect(svc.calls.at(-1)).toBe('off');
    expect(svc.st.running).toBe(false);
    // Allowed again (in front): started; a repair keeps it waiting.
    r.ble.setState('on');
    await flush();
    expect(svc.calls.at(-1)).toBe('connected');
    r.rt.link.needsRepair('unknown_phone');
    await flush();
    expect(r.rt.state().link.lifecycle).toBe('needs_repair');
    expect(svc.calls.at(-1)).toBe('waiting');
    expect(svc.st.running).toBe(true);
    r.rt.dispose();
  });

  test('forget stops the service', async () => {
    await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
    const svc = fakeService();
    const r = svcRig({ service: svc });
    await r.rt.ready;
    await flush();
    await r.rt.forget();
    await flush();
    expect(svc.calls.at(-1)).toBe('off');
    expect(svc.st.running).toBe(false);
    r.rt.dispose();
  });

  test('in the background a running service is updated (link up) but a stopped one is not started until RoadWise is back in front', async () => {
    await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
    const svc = fakeService();
    const r = svcRig({ service: svc, foreground: false });
    await r.rt.ready;
    await flush();
    expect(r.rt.state().link.lifecycle).toBe('connected');
    expect(svc.calls).toEqual([]);
    r.appState.emit('active');
    await flush();
    expect(svc.calls).toEqual(['connected']);
    r.appState.emit('background');
    r.ble.setState('off');
    await flush();
    expect(svc.calls).toEqual(['connected', 'waiting']);
    r.ble.setState('on');
    await flush();
    expect(svc.calls).toEqual(['connected', 'waiting', 'connected']);
    r.rt.dispose();
  });

  test('a refused start is not retried on every change, only at the next return to the front', async () => {
    await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
    const svc = fakeService();
    svc.st.allowStart = false;
    const r = svcRig({ service: svc });
    await r.rt.ready;
    await flush();
    expect(svc.calls).toEqual(['waiting']);
    r.ble.setState('off');
    r.ble.setState('on');
    await flush();
    expect(svc.calls).toEqual(['waiting']);
    svc.st.allowStart = true;
    r.appState.emit('background');
    r.appState.emit('active');
    await flush();
    expect(svc.calls).toEqual(['waiting', 'connected']);
    expect(svc.st.running).toBe(true);
    r.rt.dispose();
  });

  test('one call in flight: changes meanwhile wait, and the newest state goes out when it settles; a rejection counts as refused and is reported', async () => {
    await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
    const svc = fakeService();
    svc.st.holding = true;
    const r = svcRig({ service: svc });
    await r.rt.ready;
    await flush();
    expect(svc.calls).toEqual(['waiting']); // connected meanwhile: held back
    svc.st.holding = false;
    svc.release();
    await flush();
    expect(svc.calls).toEqual(['waiting', 'connected']);
    r.rt.dispose();

    const bad = fakeService();
    bad.port.set = () => Promise.reject(new Error('bridge'));
    const r2 = svcRig({ service: bad });
    await r2.rt.ready;
    await flush();
    expect(r2.errors.some((e) => e.startsWith('link service: bridge'))).toBe(true);
    r2.rt.dispose();
  });

  test('a runtime rebuilt in the background while the service runs updates it with no return to the front; a dispose never stops it', async () => {
    await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
    const svc = fakeService({ running: true });
    const r = svcRig({ service: svc, foreground: false });
    await r.rt.ready;
    await flush();
    expect(svc.calls.at(-1)).toBe('connected');
    expect(svc.calls).not.toContain('off');
    const n = svc.calls.length;
    r.rt.dispose();
    expect(svc.calls).toHaveLength(n);
    expect(svc.st.running).toBe(true);
    expect(svc.ticks.size).toBe(0);
  });

  test("the service's tick pumps the process timers (a connect back-off fires with JS timers paused)", async () => {
    await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
    const svc = fakeService();
    const r = svcRig({ service: svc });
    await r.rt.ready;
    const pump = jest.spyOn(processTimers, 'pump');
    expect(svc.ticks.size).toBe(1);
    for (const t of svc.ticks) t();
    expect(pump).toHaveBeenCalledTimes(1);
    pump.mockRestore();
    r.rt.dispose();
  });

  test('Android in the background with no drive recording: "can play" only while the link service runs (in front, or recording, it never matters); iOS never asks', async () => {
    await createSettingsRepo(db).set(PAIRED_KEY, PAIRED);
    const svc = fakeService();
    svc.st.allowStart = false;
    const host = { recording: false, driveOpen: false, playerAvailable: true, callActive: false };
    const r = svcRig({ service: svc, host });
    await r.rt.ready;
    await flush();
    expect(svc.st.running).toBe(false);
    // In front: the app plays whatever the service does.
    expect(r.rt.link.canPlay(true)).toBe(true);
    // In the background (a headless restart, a refused start, the service killed): the buzzer.
    r.appState.emit('background');
    expect(r.rt.link.canPlay(true)).toBe(false);
    // A drive recording keeps its own capture service: it can play.
    host.recording = true;
    host.driveOpen = true;
    expect(r.rt.link.canPlay(true)).toBe(true);
    // The drive finalizing (open, no longer recording) without the service: the buzzer.
    host.recording = false;
    expect(r.rt.link.canPlay(true)).toBe(false);
    host.driveOpen = false;
    svc.st.running = true;
    expect(r.rt.link.canPlay(true)).toBe(true);
    // A running() that throws reads as not running, and is reported.
    svc.st.runningThrows = true;
    expect(r.rt.link.canPlay(true)).toBe(false);
    expect(r.errors.some((e) => e.startsWith('link service: running'))).toBe(true);
    r.rt.dispose();
    const ios = fakeService();
    const r2 = svcRig({ platform: 'ios', service: ios, foreground: false });
    await r2.rt.ready;
    expect(r2.rt.link.canPlay(true)).toBe(true);
    r2.rt.dispose();
  });
});
