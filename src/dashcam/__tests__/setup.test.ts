// The link v3 setup flow on the real transport over the fake BLE stack and fake dashcams, with a
// virtual clock: one-tap pairing (nothing sent before Pair), the setup hold until Next, the commit
// and its outcomes, Cancel on both sides at every stage, a drive opening, a lost link during the
// hold, the hold running out, the setup's STATE (never "can play", a speed only from a fresh
// sample), the search and its choice, Set up again with prev_id, and every failure on screen 1.
import type { BluetoothAccess } from '@/core/permissions/adapters';

import { createFakeDashcam, type FakeDashcam } from '../__fixtures__/fakeDashcam';
import { R } from '../auth';
import { createFakeBle, type FakeBle } from '../fakeTransport';
import type { PairedDashcam } from '../keys';
import { AUTH_CHAR, DASHPAL_SERVICE, PAIRING_NEW, PAIRING_OPEN, PAIRING_SETUP, STATE_FLAG, toHex, type RxFrame } from '../protocol';
import { createDashpalSecrets, type DashpalSecrets } from '../secure';
import { BUSY_WAIT_MS, createSetupFlow, HOLD_MAX_MS, HOLD_RECONNECT_MS, PRESS_WAIT_MS, type SetupFlow, type SetupPhase, type SetupStart } from '../setup';
import type { SetupSpeed } from '../setupSpeed';
import { createBleTransport, type DashcamTransport } from '../transport';

const flush = async () => {
  for (let i = 0; i < 60; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const macOf = (last: number) => [0xa4, 0xcf, 0x12, 0xb3, 0xc4, last];
const camOf = (last: number) => toHex(macOf(last));
const idOf = (platform: 'ios' | 'android', last: number) => (platform === 'android' ? macOf(last).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':') : `UUID-${last}`);
const nameOfLast = (last: number) => `DashPal-${camOf(last).slice(-4).toUpperCase()}`;

interface CamSpec {
  last: number;
  windowOpen?: boolean;
  rssi?: number;
  protoMax?: number;
  protoMin?: number;
  noAuthChar?: boolean;
  phones?: { id: Uint8Array; kPair: Uint8Array }[];
}

interface Rig {
  flow: SetupFlow;
  ble: FakeBle;
  t: DashcamTransport;
  cams: Map<number, FakeDashcam>;
  secrets: DashpalSecrets;
  store: Map<string, string>;
  phases: SetupPhase[];
  paired: PairedDashcam[];
  log: string[];
  clock: { t: number };
  sleeps: number[];
  speed: { cms: number | null; started: number; stopped: number };
  refused: { on: boolean };
  at(ms: number, fn: () => void): void;
  until(kind: SetupPhase['kind'], max?: number): Promise<SetupPhase>;
  setBusy(v: boolean): void;
  cam(last?: number): FakeDashcam;
  /** COMMAND ops the dashcam received, in order */
  ops(last?: number): number[];
  states(last?: number): Extract<RxFrame, { type: 'STATE' }>[];
}

function rig(o: { platform?: 'ios' | 'android'; access?: BluetoothAccess; previous?: PairedDashcam | null; cams?: CamSpec[] } = {}): Rig {
  const platform = o.platform ?? 'android';
  const ble = createFakeBle();
  const t = createBleTransport(ble, { platform, setTimer: () => 0, clearTimer: () => {} });
  const cams = new Map<number, FakeDashcam>();
  const specs = o.cams ?? [{ last: 0xd5 }];
  for (const c of specs) {
    const cam = createFakeDashcam({ ble, id: idOf(platform, c.last), mac: macOf(c.last), windowOpen: c.windowOpen ?? true, protoMax: c.protoMax, phones: c.phones });
    if (c.protoMin !== undefined) {
      const info = cam.info.bind(cam);
      cam.info = () => {
        const b = info();
        b[1] = c.protoMin!;
        return b;
      };
    }
    if (c.noAuthChar) ble.peripheral(idOf(platform, c.last))!.noAuthChar = true;
    cams.set(c.last, cam);
  }
  // Advertising: every DashPal answers each scan with the service its state names.
  const advOf = (cam: FakeDashcam): string => (cam.prov || cam.busy ? PAIRING_SETUP : !cam.windowOpen ? DASHPAL_SERVICE : cam.phones.size > 0 ? PAIRING_OPEN : PAIRING_NEW);
  const scan = ble.scan.bind(ble);
  ble.scan = async (opts) => {
    await scan(opts);
    queueMicrotask(() => {
      for (const c of specs) {
        const cam = cams.get(c.last)!;
        ble.advertise({ id: idOf(platform, c.last), rssi: c.rssi ?? -50, advertising: { serviceUUIDs: [advOf(cam)], localName: nameOfLast(c.last) } });
      }
    });
  };
  const store = new Map<string, string>();
  const secrets = createDashpalSecrets(() => ({
    getItemAsync: async (k) => store.get(k) ?? null,
    setItemAsync: async (k, v) => void store.set(k, v),
    deleteItemAsync: async (k) => void store.delete(k),
  }));
  const clock = { t: 1_000_000 };
  const sleeps: number[] = [];
  const due: { at: number; fn: () => void }[] = [];
  const phases: SetupPhase[] = [];
  const paired: PairedDashcam[] = [];
  const log: string[] = [];
  let busy = false;
  const driveFns = new Set<() => void>();
  const refused = { on: false };
  const speed = { cms: null as number | null, started: 0, stopped: 0 };
  const fakeSpeed = (): SetupSpeed => ({
    start: async () => void (speed.started += 1),
    speedCms: () => speed.cms,
    stop: () => void (speed.stopped += 1),
  });
  const flow = createSetupFlow({
    platform,
    transport: () => t,
    requestBluetooth: async () => o.access ?? 'granted',
    isBusy: () => busy,
    onDriveChange: (fn) => {
      driveFns.add(fn);
      return () => void driveFns.delete(fn);
    },
    optIn: async () => void log.push('optIn'),
    pair: async (r) => {
      paired.push(r);
      log.push(`pair:${r.dashcamId}`);
    },
    paired: () => o.previous ?? null,
    keyRefused: (d) => refused.on && o.previous?.dashcamId === d,
    stepAside: () => {
      log.push('stepAside');
      t.setTarget(null);
    },
    resumePaired: async () => void log.push('resumePaired'),
    secrets,
    notePhones: (d, n) => void log.push(`notePhones:${d}:${n}`),
    speed: fakeSpeed,
    localMinute: () => 600,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
      for (const d of due.splice(0).sort((a, b) => a.at - b.at)) {
        if (d.at <= clock.t) d.fn();
        else due.push(d);
      }
      // a macrotask, as a timer is: the driver's taps get their turn
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    onError: (e, ctx) => void log.push(`error:${ctx}:${e instanceof Error ? e.message : String(e)}`),
  });
  flow.subscribe((p) => phases.push(p));
  const cam = (last = 0xd5) => cams.get(last)!;
  const r: Rig = {
    flow,
    ble,
    t,
    cams,
    secrets,
    store,
    phases,
    paired,
    log,
    clock,
    sleeps,
    speed,
    refused,
    at: (ms, fn) => void due.push({ at: clock.t + ms, fn }),
    async until(kind, max = 2000) {
      for (let i = 0; i < max; i++) {
        if (flow.phase().kind === kind) return flow.phase();
        await flush();
      }
      throw new Error(`never reached ${kind}; phases: ${phases.map((p) => p.kind).join(' > ')}; log: ${log.join(' | ')}`);
    },
    setBusy: (v) => {
      busy = v;
      for (const fn of [...driveFns]) fn();
    },
    cam,
    ops: (last = 0xd5) => cam(last).received.filter((f): f is Extract<RxFrame, { type: 'COMMAND' }> => f.type === 'COMMAND').map((f) => f.op),
    states: (last = 0xd5) => cam(last).received.filter((f): f is Extract<RxFrame, { type: 'STATE' }> => f.type === 'STATE'),
  };
  return r;
}

const kinds = (r: Rig) => r.phases.map((p) => p.kind);
const END: SetupPhase['kind'][] = ['done', 'failed', 'cancelled', 'busy', 'denied', 'off', 'unavailable'];

async function untilEnd(r: Rig): Promise<SetupPhase> {
  for (let i = 0; i < 4000; i++) {
    if (END.includes(r.flow.phase().kind)) return r.flow.phase();
    await flush();
  }
  throw new Error(`no end; phases: ${kinds(r).join(' > ')}; log: ${r.log.join(' | ')}`);
}

/** Start, tap Pair on screen 1, then Next on screen 2: to the end (`next: false`: stop on screen 2). */
async function setUp(r: Rig, opts?: SetupStart, o: { next?: boolean } = {}): Promise<SetupPhase> {
  void r.flow.start(opts);
  await r.until('confirm');
  r.flow.pair();
  for (let i = 0; i < 4000; i++) {
    const k = r.flow.phase().kind;
    if (k === 'instructions') break;
    if (END.includes(k)) return r.flow.phase();
    await flush();
  }
  if (o.next === false) return r.flow.phase();
  r.flow.next();
  return untilEnd(r);
}

const previousOf = (last: number, platform: 'ios' | 'android' = 'android'): PairedDashcam => ({ dashcamId: camOf(last), peripheralId: idOf(platform, last), name: nameOfLast(last), pairedAt: 1, secure: true });

/** Let virtual time run on screen 2 for `ms` (the loops sleep in 50-ms steps). */
async function idle(r: Rig, ms: number): Promise<void> {
  const end = r.clock.t + ms;
  for (let i = 0; i < 10_000 && r.clock.t < end; i++) await flush();
}

describe('one tap, the hold, the commit', () => {
  test('search finds the one DashPal; nothing is sent before Pair; then the pairing, the hold, the session, PAIRED and the aiming query; Next commits and only then is the key kept', async () => {
    const r = rig();
    void r.flow.start();
    expect(await r.until('confirm')).toEqual({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'new', replaces: null });
    await flush();
    expect(r.ble.calls.some((c) => c.startsWith('connect'))).toBe(false);
    r.flow.pair();
    expect(await r.until('instructions')).toEqual({ kind: 'instructions', aimAllowed: true, holdLeftS: null, reconnecting: false });
    // held, not stored
    expect(r.cam().prov).not.toBeNull();
    expect(r.cam().phones.size).toBe(0);
    expect(await r.secrets.readAuth()).toBeNull();
    expect(await r.secrets.readPendingAuth()).not.toBeNull();
    expect(r.ops()).toEqual([7, 5, 10]);
    expect(r.cam().received.find((f) => f.type === 'COMMAND' && f.op === 10)).toMatchObject({ arg: 2 });
    r.flow.next();
    expect(await untilEnd(r)).toMatchObject({ kind: 'done', phones: 1, notAllYours: false, aimedElsewhere: false, paired: { dashcamId: camOf(0xd5), name: 'DashPal-C4D5', secure: true } });
    expect(kinds(r)).toEqual(['permission', 'search', 'confirm', 'connecting', 'connected', 'instructions', 'finishing', 'done']);
    expect(r.ops().at(-1)).toBe(8);
    const auth = (await r.secrets.readAuth())!;
    expect(toHex(r.cam().phones.get(auth.phoneId)!)).toBe(auth.kPair);
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect(r.log).toContain(`notePhones:${camOf(0xd5)}:1`);
    expect(r.paired.map((p) => p.dashcamId)).toEqual([camOf(0xd5)]);
    // the setup connection was released before the pairing went to the auto-connect
    expect(r.ble.calls).toContain(`disconnect:${idOf('android', 0xd5)}`);
    // PAIR_OPEN, PAIR_FIN, then the session on the same connection
    expect(r.cam().authWrites.map((w) => w[0])).toEqual([0x12, 0x11, 0x20, 0x21]);
    expect(r.speed).toMatchObject({ started: 1, stopped: 1 });
  });

  test('the check mark: the spinner shows at least 0.6 s and the check mark 0.9 s; no wait on the path longer than 300 ms', async () => {
    const r = rig();
    const at: Partial<Record<SetupPhase['kind'], number>> = {};
    r.flow.subscribe((p) => void (at[p.kind] ??= r.clock.t));
    void r.flow.start();
    await r.until('confirm');
    const tapAt = r.clock.t;
    r.flow.pair();
    await r.until('instructions');
    expect(at.connected! - tapAt).toBeGreaterThanOrEqual(600);
    expect(at.instructions! - at.connected!).toBeGreaterThanOrEqual(900);
    expect(at.instructions! - tapAt).toBeLessThan(10_000);
    expect(r.sleeps.every((ms) => ms <= 300)).toBe(true);
    await r.flow.cancel();
  });

  test('the setup STATE every 0.9 s: never can_play or buzzer_too; drive_active from the drive host; speed_valid only from a fresh sample', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    const before = r.states().length;
    expect(before).toBeGreaterThan(0);
    r.speed.cms = 120;
    await idle(r, 3000);
    const states = r.states();
    expect(states.length).toBeGreaterThanOrEqual(before + 3);
    for (const s of states) {
      expect(s.flags & (STATE_FLAG.CAN_PLAY | STATE_FLAG.BUZZER_TOO | STATE_FLAG.DRIVE_ACTIVE)).toBe(0);
      expect([s.ttlDs, s.bootId, s.ackSeq, s.localMin]).toEqual([30, 0, 0, 600]);
    }
    expect(states.slice(0, before).every((s) => (s.flags & STATE_FLAG.SPEED_VALID) === 0 && s.speedCms === 0)).toBe(true);
    expect(states.at(-1)).toMatchObject({ flags: STATE_FLAG.SPEED_VALID, speedCms: 120 });
    await r.flow.cancel();
  });

  test('two DashPals in pairing mode: “Which DashPal is yours?”, strongest first; one at −90 dBm is not offered; the pick pairs', async () => {
    const r = rig({ cams: [{ last: 0x01, rssi: -70 }, { last: 0x02, rssi: -40 }, { last: 0x03, rssi: -90 }] });
    void r.flow.start();
    const choose = await r.until('choose');
    expect(choose).toMatchObject({ kind: 'choose', candidates: [{ id: idOf('android', 0x02), adv: 'new' }, { id: idOf('android', 0x01), adv: 'new' }] });
    expect((choose as Extract<SetupPhase, { kind: 'choose' }>).candidates).toHaveLength(2);
    r.flow.pick(idOf('android', 0x01));
    expect(await r.until('confirm')).toMatchObject({ name: 'DashPal-C401' });
    r.flow.pair();
    await r.until('instructions');
    r.flow.next();
    expect(await untilEnd(r)).toMatchObject({ kind: 'done', paired: { dashcamId: camOf(0x01) } });
    expect(r.cam(0x02).authWrites).toEqual([]);
  });

  test('none in pairing mode: none_nearby; a DashPal with phones paired is offered as open', async () => {
    const r = rig({ cams: [{ last: 0xd5, windowOpen: false }] });
    await r.flow.start();
    expect(r.flow.phase()).toEqual({ kind: 'failed', reason: 'none_nearby', name: null, retry: 'restart' });
    const open = rig({ cams: [{ last: 0xd5, phones: [{ id: Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]), kPair: new Uint8Array(32).fill(9) }] }] });
    void open.flow.start();
    expect(await open.until('confirm')).toMatchObject({ mode: 'open' });
    await open.flow.cancel();
  });

  test('the Home card’s DashPal: no search; 2 phones: notAllYours', async () => {
    const r = rig({ cams: [{ last: 0xd5, phones: [{ id: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]), kPair: new Uint8Array(32).fill(1) }] }] });
    expect(await setUp(r, { target: { peripheralId: idOf('android', 0xd5), name: 'DashPal-C4D5', adv: 'open' } })).toMatchObject({ kind: 'done', phones: 2, notAllYours: true });
    expect(kinds(r)).not.toContain('search');
  });

  test('a window opened by Add another phone: the aiming query says not allowed; done says the other phone aimed it', async () => {
    const r = rig({ cams: [{ last: 0xd5, phones: [{ id: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]), kPair: new Uint8Array(32).fill(1) }] }] });
    r.cam().commandWindow = true;
    await setUp(r, {}, { next: false });
    await idle(r, 200);
    expect(r.flow.phase()).toMatchObject({ kind: 'instructions', aimAllowed: false });
    r.flow.next();
    expect(await untilEnd(r)).toMatchObject({ kind: 'done', aimedElsewhere: true });
  });

  test('Set up again proves the old key (prev_id): the old record stays through the hold and is replaced at the commit', async () => {
    const r = rig({ previous: previousOf(0xd5), cams: [{ last: 0xd5, phones: [{ id: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), kPair: new Uint8Array(32).fill(0xab) }] }] });
    await r.secrets.writePendingAuth({ dashcamId: camOf(0xd5), phoneId: '0102030405060708', kPair: 'ab'.repeat(32) });
    await r.secrets.finalizeAuth();
    void r.flow.start({ again: true });
    expect(await r.until('confirm')).toEqual({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'again', replaces: null });
    r.flow.pair();
    await r.until('instructions');
    expect(r.cam().phones.has('0102030405060708')).toBe(true);
    r.flow.next();
    expect((await untilEnd(r)).kind).toBe('done');
    expect(r.cam().phones.size).toBe(1);
    expect(r.cam().phones.has('0102030405060708')).toBe(false);
    expect(toHex(r.cam().authWrites.find((w) => w[0] === 0x12)!.slice(10, 18))).toBe('0102030405060708');
    expect(r.log.filter((l) => l === 'stepAside')).toHaveLength(1);
  });

  test('Set up again with the window closed: “Press the DashPal’s button 5 times”, watched up to 60 s; it opens and pairing goes on; never: window_closed', async () => {
    const r = rig({ previous: previousOf(0xd5), cams: [{ last: 0xd5, windowOpen: false }] });
    void r.flow.start({ again: true });
    await r.until('confirm');
    r.at(5000, () => {
      r.cam().windowOpen = true;
      r.ble.advertise({ id: idOf('android', 0xd5), rssi: -50, advertising: { serviceUUIDs: [PAIRING_NEW] } });
    });
    r.flow.pair();
    await r.until('instructions');
    expect(kinds(r)).toContain('press_button');
    r.flow.next();
    expect((await untilEnd(r)).kind).toBe('done');
    const never = rig({ previous: previousOf(0xd5), cams: [{ last: 0xd5, windowOpen: false }] });
    void never.flow.start({ again: true });
    await never.until('confirm');
    const t0 = never.clock.t;
    never.flow.pair();
    expect(await untilEnd(never)).toMatchObject({ kind: 'failed', reason: 'window_closed' });
    expect(never.clock.t - t0).toBeGreaterThanOrEqual(PRESS_WAIT_MS);
  });

  test('a different DashPal than the paired one: screen 1 says it replaces it; Cancel after the pairing keeps the previous pairing', async () => {
    const r = rig({ previous: previousOf(0x01) });
    await r.secrets.writePendingAuth({ dashcamId: camOf(0x01), phoneId: '0101010101010101', kPair: 'ee'.repeat(32) });
    await r.secrets.finalizeAuth();
    void r.flow.start({ target: { peripheralId: idOf('android', 0xd5), name: 'DashPal-C4D5', adv: 'new' } });
    expect(await r.until('confirm')).toMatchObject({ replaces: 'DashPal-C401' });
    r.flow.pair();
    await r.until('instructions');
    await r.flow.cancel();
    await r.until('cancelled');
    expect((await r.secrets.readAuth())?.dashcamId).toBe(camOf(0x01));
    expect(r.paired).toEqual([]);
    expect(r.log.filter((l) => l === 'stepAside' || l === 'resumePaired')).toEqual(['stepAside', 'resumePaired']);
  });
});

describe('Cancel, on both sides', () => {
  test('on screen 1: nothing was sent, nothing to undo, the paired DashPal never stepped aside', async () => {
    const r = rig({ previous: previousOf(0x01) });
    void r.flow.start();
    await r.until('confirm');
    await r.flow.cancel();
    expect(await r.until('cancelled')).toEqual({ kind: 'cancelled' });
    expect(r.ble.calls.some((c) => c.startsWith('connect'))).toBe(false);
    expect(r.log).not.toContain('stepAside');
  });

  test('after the pairing (the hold): stopping at once, COMMAND 9, the DashPal forgets the provisional phone and is ready to pair again; the key goes', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    expect(r.cam().prov).not.toBeNull();
    const stopped = r.flow.cancel();
    expect(r.flow.phase()).toEqual({ kind: 'stopping' });
    await stopped;
    expect(await r.until('cancelled')).toEqual({ kind: 'cancelled' });
    expect(r.ops().at(-1)).toBe(9);
    expect(r.cam().prov).toBeNull();
    expect(r.cam().windowOpen).toBe(true);
    expect(r.cam().phones.size).toBe(0);
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect(await r.secrets.readAuth()).toBeNull();
    expect(r.paired).toEqual([]);
    // a fresh setup pairs at once
    expect((await setUp(r)).kind).toBe('done');
  });

  test('while connecting, before PAIR_FIN: the connection released, no COMMAND 9, no key kept', async () => {
    const r = rig();
    const w0 = r.ble.onWrite!;
    r.ble.onWrite = (w) => {
      if (w.characteristic === AUTH_CHAR && w.bytes[0] === 0x12) void r.flow.cancel();
      return w0(w);
    };
    void r.flow.start();
    await r.until('confirm');
    r.flow.pair();
    expect(await untilEnd(r)).toEqual({ kind: 'cancelled' });
    expect(r.ops()).toEqual([]);
    expect(r.cam().prov).toBeNull();
    expect(await r.secrets.readPendingAuth()).toBeNull();
  });

  test('while the commit is answered, Cancel does nothing: the commit decides', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    const w0 = r.ble.onWrite!;
    r.ble.onWrite = (w) => {
      if (r.flow.phase().kind === 'finishing') void r.flow.cancel();
      return w0(w);
    };
    r.flow.next();
    expect(await untilEnd(r)).toMatchObject({ kind: 'done' });
  });

  test('leaving the screen while the commit is answered, and the commit fails: undone on both sides, the speed watch stopped, the paired DashPal resumed', async () => {
    const r = rig({ previous: previousOf(0x01) });
    await setUp(r, { target: { peripheralId: idOf('android', 0xd5), name: 'DashPal-C4D5', adv: 'new' } }, { next: false });
    r.cam().commit = R.STORE_FAILED;
    const w0 = r.ble.onWrite!;
    let left = false;
    r.ble.onWrite = (w) => {
      if (!left && r.flow.phase().kind === 'finishing') {
        left = true;
        void r.flow.cancel();
      }
      return w0(w);
    };
    r.flow.next();
    expect(await untilEnd(r)).toEqual({ kind: 'cancelled' });
    expect(left).toBe(true);
    expect(r.ops().at(-1)).toBe(9);
    expect(r.cam().prov).toBeNull();
    expect(r.cam().windowOpen).toBe(true);
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect(r.speed.stopped).toBeGreaterThan(0);
    expect(r.log).toContain('resumePaired');
    expect(r.ble.calls).toContain(`disconnect:${idOf('android', 0xd5)}`);
  });
});

describe('a drive opening', () => {
  test('on screen 1: busy at once, nothing sent; before the start: busy', async () => {
    const r = rig();
    const done = r.flow.start();
    await r.until('confirm');
    r.setBusy(true);
    await done;
    expect(r.flow.phase()).toEqual({ kind: 'busy' });
    expect(r.ble.calls.some((c) => c.startsWith('connect'))).toBe(false);
    const before = rig();
    before.setBusy(true);
    await before.flow.start();
    expect(before.flow.phase()).toEqual({ kind: 'busy' });
  });

  test('during the hold: undone with COMMAND 9, then busy; the key goes', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    r.setBusy(true);
    expect(await untilEnd(r)).toEqual({ kind: 'busy' });
    expect(r.ops().at(-1)).toBe(9);
    expect(r.cam().prov).toBeNull();
    expect(await r.secrets.readPendingAuth()).toBeNull();
  });
});

describe('the hold: a lost link, its end, the commit’s outcomes', () => {
  test('the link drops on screen 2: “Reconnecting…”, a session under the new key, screen 2 again; then Next commits', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    r.ble.connectMode.set(idOf('android', 0xd5), 'reject');
    r.ble.drop(idOf('android', 0xd5));
    await idle(r, 300);
    expect(r.flow.phase()).toMatchObject({ kind: 'instructions', reconnecting: true });
    r.ble.connectMode.delete(idOf('android', 0xd5));
    await idle(r, 2000);
    expect(r.flow.phase()).toMatchObject({ kind: 'instructions', reconnecting: false });
    r.flow.next();
    expect(await untilEnd(r)).toMatchObject({ kind: 'done' });
  });

  test('no session within 45 s: lost, the key deleted (the DashPal undoes it by itself)', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    r.ble.connectMode.set(idOf('android', 0xd5), 'reject');
    const t0 = r.clock.t;
    r.ble.drop(idOf('android', 0xd5));
    expect(await untilEnd(r)).toMatchObject({ kind: 'failed', reason: 'lost', retry: 'restart' });
    expect(r.clock.t - t0).toBeGreaterThanOrEqual(HOLD_RECONNECT_MS);
    expect(await r.secrets.readPendingAuth()).toBeNull();
  });

  test('the hold was undone meanwhile (R_UNKNOWN_PHONE on the reconnect): lost, the key deleted', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    r.cam().undo();
    r.ble.drop(idOf('android', 0xd5));
    expect(await untilEnd(r)).toMatchObject({ kind: 'failed', reason: 'lost', retry: 'restart' });
    expect(await r.secrets.readPendingAuth()).toBeNull();
  });

  test('the hold runs out (SETUP_RESULT 9 R_EXPIRED): “Setup took too long”, the key deleted', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    r.cam().expire();
    expect(await untilEnd(r)).toMatchObject({ kind: 'failed', reason: 'expired', retry: 'restart' });
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect(r.paired).toEqual([]);
  });

  test('the countdown: the hold’s last minute shows the seconds left', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    r.clock.t += HOLD_MAX_MS - 59_000 - 1000;
    await idle(r, 200);
    const p = r.flow.phase() as Extract<SetupPhase, { kind: 'instructions' }>;
    expect(p.holdLeftS).not.toBeNull();
    expect(p.holdLeftS!).toBeLessThanOrEqual(60);
    expect(p.holdLeftS!).toBeGreaterThan(50);
    await r.flow.cancel();
  });

  test('R_STORE_FAILED: save_failed with Try again, which sends the commit again on the hold that stands', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    r.cam().commit = R.STORE_FAILED;
    r.flow.next();
    expect(await untilEnd(r)).toMatchObject({ kind: 'failed', reason: 'save_failed', retry: 'commit' });
    expect(r.cam().prov).not.toBeNull();
    expect(await r.secrets.readPendingAuth()).not.toBeNull();
    await r.flow.retry();
    expect(await untilEnd(r)).toMatchObject({ kind: 'done' });
    expect(r.ops().filter((op) => op === 8)).toHaveLength(2);
  });

  test('the commit went through but its answer was lost with the link: a reconnect, COMMAND 8 again (R_OK), done', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    r.cam().commit = 'silent';
    const w0 = r.ble.onWrite!;
    let dropped = false;
    r.ble.onWrite = async (w) => {
      await w0(w);
      if (!dropped && r.cam().prov === null && r.cam().phones.size === 1) {
        dropped = true;
        r.ble.drop(idOf('android', 0xd5));
      }
    };
    r.flow.next();
    expect(await untilEnd(r)).toMatchObject({ kind: 'done', phones: 1 });
    expect(r.ops().filter((op) => op === 8)).toHaveLength(2);
  });

  test('a commit unanswered and no reconnect: lost with Try again, the key kept; Try again reconnects, commits, done', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    r.cam().commit = 'silent';
    const w0 = r.ble.onWrite!;
    let dropped = false;
    r.ble.onWrite = async (w) => {
      await w0(w);
      if (!dropped && r.cam().prov === null && r.cam().phones.size === 1) {
        dropped = true;
        r.ble.connectMode.set(idOf('android', 0xd5), 'reject');
        r.ble.drop(idOf('android', 0xd5));
      }
    };
    r.flow.next();
    expect(await untilEnd(r)).toMatchObject({ kind: 'failed', reason: 'lost', retry: 'resume' });
    expect(await r.secrets.readPendingAuth()).not.toBeNull();
    r.ble.connectMode.delete(idOf('android', 0xd5));
    await r.flow.retry();
    expect(await untilEnd(r)).toMatchObject({ kind: 'done' });
    expect(await r.secrets.readAuth()).not.toBeNull();
  });

  test('Cancel after an unanswered commit: the key is kept only as the orphan (the next setup proves it as prev_id)', async () => {
    const r = rig();
    await setUp(r, {}, { next: false });
    r.cam().commit = 'silent';
    const w0 = r.ble.onWrite!;
    let dropped = false;
    r.ble.onWrite = async (w) => {
      await w0(w);
      if (!dropped && r.cam().prov === null && r.cam().phones.size === 1) {
        dropped = true;
        r.ble.connectMode.set(idOf('android', 0xd5), 'reject');
        r.ble.drop(idOf('android', 0xd5));
      }
    };
    r.flow.next();
    await untilEnd(r);
    const key = (await r.secrets.readPendingAuth())!;
    await r.flow.cancel();
    expect(r.flow.phase()).toEqual({ kind: 'cancelled' });
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect(await r.secrets.readOrphan()).toEqual({ dashcamId: key.dashcamId, phoneId: key.phoneId, kPair: key.kPair });
  });

  /** Next with the commit stored but unanswered and the link lost, reconnects refused until `reachable()`. */
  async function unansweredCommit(r: Rig): Promise<{ reachable(): void }> {
    await setUp(r, {}, { next: false });
    r.cam().commit = 'silent';
    const w0 = r.ble.onWrite!;
    let dropped = false;
    r.ble.onWrite = async (w) => {
      await w0(w);
      if (!dropped && r.cam().prov === null && r.cam().phones.size === 1) {
        dropped = true;
        r.ble.connectMode.set(idOf('android', 0xd5), 'reject');
        r.ble.drop(idOf('android', 0xd5));
      }
    };
    r.flow.next();
    return { reachable: () => void r.ble.connectMode.delete(idOf('android', 0xd5)) };
  }

  test('Close after an unanswered commit, the DashPal in reach again: a session under the kept key and COMMAND 4, so the DashPal forgets the phone; nothing is kept on the phone', async () => {
    const r = rig();
    const u = await unansweredCommit(r);
    expect(await untilEnd(r)).toMatchObject({ kind: 'failed', reason: 'lost', retry: 'resume' });
    expect(r.cam().phones.size).toBe(1);
    u.reachable();
    await r.flow.cancel();
    expect(r.flow.phase()).toEqual({ kind: 'cancelled' });
    expect(r.ops().at(-1)).toBe(4);
    expect(r.cam().phones.size).toBe(0);
    expect(r.cam().prov).toBeNull();
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect(await r.secrets.readOrphan()).toBeNull();
    expect(await r.secrets.readAuth()).toBeNull();
  });

  test('Cancel while reconnecting after an unanswered commit: the DashPal forgets the phone (COMMAND 4); nothing is kept', async () => {
    const r = rig();
    const u = await unansweredCommit(r);
    let at: SetupPhase | null = null;
    r.at(3000, () => {
      at = r.flow.phase();
      u.reachable();
      void r.flow.cancel();
    });
    expect(await untilEnd(r)).toEqual({ kind: 'cancelled' });
    expect(at).toMatchObject({ kind: 'connecting', reconnecting: true });
    expect(r.ops()).toContain(4);
    expect(r.cam().phones.size).toBe(0);
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect(await r.secrets.readOrphan()).toBeNull();
  });

  test('Close after an unanswered commit, the DashPal not knowing the key: nothing to undo and nothing kept', async () => {
    const r = rig();
    const u = await unansweredCommit(r);
    await untilEnd(r);
    r.cam().phones.clear();
    u.reachable();
    await r.flow.cancel();
    expect(r.flow.phase()).toEqual({ kind: 'cancelled' });
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect(await r.secrets.readOrphan()).toBeNull();
  });
});

describe('screen 1’s outcomes', () => {
  test.each([
    ['firmware below link v3', { protoMax: 2 }, 'update_firmware'],
    ['firmware above link v3', { protoMin: 4, protoMax: 4 }, 'update_app'],
  ] as const)('%s', async (_n, spec, reason) => {
    const r = rig({ cams: [{ last: 0xd5, ...spec }] });
    expect(await setUp(r, { target: { peripheralId: idOf('android', 0xd5), name: null, adv: 'new' } })).toMatchObject({ kind: 'failed', reason, retry: 'none' });
    expect(r.cam().authWrites).toEqual([]);
  });

  test('the Home card’s DashPal no longer in pairing mode: window_closed', async () => {
    const r = rig({ cams: [{ last: 0xd5, windowOpen: false }] });
    expect(await setUp(r, { target: { peripheralId: idOf('android', 0xd5), name: 'DashPal-C4D5', adv: 'new' } })).toMatchObject({ kind: 'failed', reason: 'window_closed' });
  });

  test('another DashPal answers at that address (Android): not_found, nothing sent', async () => {
    const r = rig();
    const wrong = idOf('android', 0x99);
    r.ble.addPeripheral({ id: wrong, rssi: -50 });
    const r0 = r.ble.onRead!;
    r.ble.onRead = (id, ch) => (id === wrong ? r0(idOf('android', 0xd5), ch) : r0(id, ch));
    expect(await setUp(r, { target: { peripheralId: wrong, name: 'DashPal-C499', adv: 'new' } })).toMatchObject({ kind: 'failed', reason: 'not_found' });
    expect(r.cam().authWrites).toEqual([]);
  });

  test('another phone setting it up: INFO every second; cleared at 6 s pairs; busy throughout fails at 16 s', async () => {
    const r = rig();
    r.cam().busy = true;
    void r.flow.start({ target: { peripheralId: idOf('android', 0xd5), name: null, adv: 'new' } });
    await r.until('confirm');
    r.at(6000, () => (r.cam().busy = false));
    r.flow.pair();
    await r.until('instructions', 4000);
    expect(kinds(r)).toContain('waiting_busy');
    r.flow.next();
    expect((await untilEnd(r)).kind).toBe('done');
    const stuck = rig();
    stuck.cam().busy = true;
    void stuck.flow.start({ target: { peripheralId: idOf('android', 0xd5), name: null, adv: 'new' } });
    await stuck.until('confirm');
    const t0 = stuck.clock.t;
    stuck.flow.pair();
    expect(await untilEnd(stuck)).toMatchObject({ kind: 'failed', reason: 'setup_busy' });
    expect(stuck.clock.t - t0).toBeGreaterThanOrEqual(BUSY_WAIT_MS);
  });

  test('a device that cannot confirm the key: unverified, and nothing more is sent to it', async () => {
    const r = rig();
    r.cam().badProof.pair = true;
    expect(await setUp(r)).toMatchObject({ kind: 'failed', reason: 'unverified' });
    expect(r.cam().authWrites.map((w) => w[0])).toEqual([0x12]);
    expect(await r.secrets.readPendingAuth()).toBeNull();
  });

  test('R_ID_IN_USE: a new id at once; R_MTU once: asked again; R_MTU twice: mtu; R_BAD_KEY: error', async () => {
    const id = rig();
    id.cam().force.pair_open = R.ID_IN_USE;
    expect((await setUp(id)).kind).toBe('done');
    const opens = id.cam().authWrites.filter((w) => w[0] === 0x12);
    expect(opens).toHaveLength(2);
    expect(toHex(opens[0]!.slice(2, 10))).not.toBe(toHex(opens[1]!.slice(2, 10)));
    const mtu = rig();
    mtu.cam().force.pair_open = R.MTU;
    expect((await setUp(mtu)).kind).toBe('done');
    const low = rig();
    low.cam().mtu = 23;
    expect(await setUp(low)).toMatchObject({ kind: 'failed', reason: 'mtu' });
    const bad = rig();
    bad.cam().force.pair_open = R.BAD_KEY;
    expect(await setUp(bad)).toMatchObject({ kind: 'failed', reason: 'error' });
  });

  test('R_NOT_NOW (the dashcam failed to compute its answer): INFO again, 300 ms, a new PAIR_OPEN, at most twice; then error', async () => {
    const r = rig();
    r.cam().force.pair_open = R.NOT_NOW;
    expect((await setUp(r)).kind).toBe('done');
    expect(r.sleeps).toContain(300);
    const always = rig();
    const w0 = always.ble.onWrite!;
    always.ble.onWrite = (x) => {
      if (x.characteristic === AUTH_CHAR && x.bytes[0] === 0x12) always.cam().force.pair_open = R.NOT_NOW;
      return w0(x);
    };
    expect(await setUp(always)).toMatchObject({ kind: 'failed', reason: 'error' });
    expect(always.cam().authWrites.filter((x) => x[0] === 0x12)).toHaveLength(3);
  });

  test('PAIR_FIN refused (R_WRONG_PROOF): error, the pending key deleted, the previous pairing untouched', async () => {
    const r = rig();
    await r.secrets.writePendingAuth({ dashcamId: camOf(0x01), phoneId: '0101010101010101', kPair: 'ee'.repeat(32) });
    await r.secrets.finalizeAuth();
    r.cam().force.pair_fin = R.WRONG_PROOF;
    expect(await setUp(r)).toMatchObject({ kind: 'failed', reason: 'error' });
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect((await r.secrets.readAuth())?.dashcamId).toBe(camOf(0x01));
  });

  test('the key cannot be stored before PAIR_FIN: error, and PAIR_FIN is never sent', async () => {
    const r = rig();
    const set = r.store.set.bind(r.store);
    r.store.set = (k, v) => {
      if (k === 'dashpal.authPending') throw new Error('keychain full');
      return set(k, v);
    };
    expect(await setUp(r)).toMatchObject({ kind: 'failed', reason: 'error' });
    expect(r.cam().authWrites.map((w) => w[0])).toEqual([0x12]);
  });

  test('iOS with no AUTH characteristic: ios_forget_first', async () => {
    const r = rig({ platform: 'ios', cams: [{ last: 0xd5, noAuthChar: true }] });
    expect(await setUp(r)).toMatchObject({ kind: 'failed', reason: 'ios_forget_first' });
  });

  test.each([
    ['denied', 'denied'],
    ['off', 'off'],
    ['unavailable', 'unavailable'],
  ] as const)('Bluetooth %s', async (access, kind) => {
    const r = rig({ access });
    await r.flow.start();
    expect(r.flow.phase().kind).toBe(kind);
  });

  test('a lingering orphan for that DashPal proves prev_id; the record is replaced, not added to', async () => {
    const r = rig({ cams: [{ last: 0xd5, phones: [{ id: Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]), kPair: new Uint8Array(32).fill(0xcd) }] }] });
    await r.secrets.writeOrphan({ dashcamId: camOf(0xd5), phoneId: '0909090909090909', kPair: 'cd'.repeat(32) });
    expect((await setUp(r)).kind).toBe('done');
    expect(toHex(r.cam().authWrites.find((w) => w[0] === 0x12)!.slice(10, 18))).toBe('0909090909090909');
    expect(r.cam().phones.size).toBe(1);
    expect(await r.secrets.readOrphan()).toBeNull();
  });
});
