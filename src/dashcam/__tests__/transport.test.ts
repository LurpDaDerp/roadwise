// The link v3 transport on the fake BLE stack and the fake dashcam: the
// connect order, the session on every connection, sealed frames both ways, the soft repair and the
// failed verifications that never halt, transport faults that are never verdicts, iOS restore,
// Android's paused timers, and the setup operations (the aiming picture's VIEW records included).
import { createPausableTimerBase } from '@/lib/__fixtures__/pausableTimers';
import { createPumpedTimers } from '@/lib/timers';

import { createFakeDashcam, type FakeDashcam } from '../__fixtures__/fakeDashcam';
import { DIR_DP, DIR_PD, openRaw, R, sealRaw, sealView } from '../auth';
import { createFakeBle, type FakeBle } from '../fakeTransport';
import type { BluetoothState, RepairCause } from '../link';
import { AUTH_CHAR, DASHPAL_SERVICE, decodeRx, encodeRx, encodeTx, PAIRING_NEW, PAIRING_OPEN, PAIRING_SETUP, RX_CHAR, toHex, VIEW_CHAR, type DashcamInfo } from '../protocol';
import {
  BACKOFF_MAX_MS,
  createBleTransport,
  IOS_FAULT_RETRY_MAX_MS,
  IOS_MTU_WAIT_MS,
  RESTORE_ID,
  SEAL_FAIL_MAX,
  SOFT_REPAIR_EVERY_MS,
  SOFT_REPAIR_FIRST_MS,
  type DashcamTransport,
  type TransportSink,
  type TransportTarget,
} from '../transport';

const PID = 'A4:CF:12:B3:C4:D5';
const CAM = 'a4cf12b3c4d5';
const MAC = [0xa4, 0xcf, 0x12, 0xb3, 0xc4, 0xd5];
const PHONE_ID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const K = new Uint8Array(32).fill(0x42);
const TARGET: TransportTarget = { peripheralId: PID, dashcamId: CAM, auth: { phoneId: toHex(PHONE_ID), kPair: toHex(K) } };

function timers() {
  let t = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      seq += 1;
      pending.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimer: (h: unknown) => void pending.delete(h as number),
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 120; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function sink() {
  const log: string[] = [];
  const frames: number[][] = [];
  let veto = false;
  const s: TransportSink = {
    setBluetooth: (st: BluetoothState) => log.push(`bt:${st}`),
    connecting: () => log.push('connecting'),
    infoRead: (i: DashcamInfo) => {
      log.push(`info:${i.dashcamId}`);
      return !veto;
    },
    linkUp: (i: DashcamInfo) => log.push(`up:${i.name}`),
    linkDown: () => log.push('down'),
    needsRepair: (c: RepairCause) => log.push(`repair:${c}`),
    unverified: () => log.push('unverified'),
    frame: (b: number[]) => frames.push(b),
  };
  return { s, log, frames, setVeto: (v: boolean) => (veto = v) };
}

interface Rig {
  ble: FakeBle;
  cam: FakeDashcam;
  t: DashcamTransport;
  clock: ReturnType<typeof timers>;
  k: ReturnType<typeof sink>;
  errors: string[];
}

function rig(platform: 'ios' | 'android' = 'android', o: { known?: boolean } = {}): Rig {
  const ble: FakeBle = createFakeBle();
  const cam = createFakeDashcam({ ble, id: PID, mac: MAC, phones: o.known === false ? [] : [{ id: PHONE_ID, kPair: K }] });
  const clock = timers();
  const errors: string[] = [];
  const t: DashcamTransport = createBleTransport(ble, {
    platform,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (_e, ctx) => errors.push(ctx),
  });
  return { ble, cam, t, clock, k: sink(), errors };
}

async function up(r: Rig, platform: 'ios' | 'android' = 'android'): Promise<void> {
  r.t.attach(r.k.s);
  r.t.setTarget(TARGET);
  await r.t.start();
  if (platform === 'ios') r.ble.setState('on');
  await flush();
}

const connects = (r: Rig) => r.ble.calls.filter((c) => c.startsWith('connect')).length;
const authOps = (r: Rig) => r.ble.calls.filter((c) => c.endsWith(':0006') || c.includes(`read:${PID}:0002`));

test('start: listeners first, then one start with the restore id and no power alert; Android reads the state once', async () => {
  const r = rig('android');
  let listenersAtStart = -1;
  const start = r.ble.start.bind(r.ble);
  r.ble.start = async (o) => {
    listenersAtStart = r.ble.listenerCount();
    return start(o);
  };
  await Promise.all([r.t.start(), r.t.start()]);
  await r.t.start();
  expect(listenersAtStart).toBe(5);
  expect(r.ble.calls.filter((c) => c.startsWith('start'))).toEqual([`start:${RESTORE_ID}:false`]);
  expect(r.ble.calls).toContain('checkState');
  expect(r.t.bluetoothState()).toBe('on');
  for (let i = 0; i < 3; i++) r.t.attach(sink().s)();
  expect(r.ble.listenerCount()).toBe(5);
});

test('iOS: never calls checkState; the state arrives as an event; settledBluetoothState waits for it', async () => {
  const r = rig('ios');
  await r.t.start();
  expect(r.ble.calls).not.toContain('checkState');
  const settled = r.t.settledBluetoothState();
  r.ble.setState('resetting');
  r.ble.setState('unauthorized');
  expect(await settled).toBe('unauthorized');
});

test('Android connect order: autoconnect, MTU 247, services, INFO, SESSION_REQ (bid over INFO’s Nc), its answer, SESSION_FIN, the RESULT, TX notifications, link up', async () => {
  const r = rig('android');
  await up(r);
  expect(r.ble.calls.filter((c) => !c.startsWith('start:') && c !== 'checkState')).toEqual([
    `connect:${PID}:auto`,
    `requestMTU:${PID}:247`,
    `retrieveServices:${PID}`,
    `read:${PID}:0002`,
    `write:${PID}:0006`,
    `read:${PID}:0006`,
    `write:${PID}:0006`,
    `read:${PID}:0006`,
    `startNotification:${PID}:0004`,
  ]);
  expect(r.k.log).toEqual(['bt:unknown', 'bt:on', 'connecting', `info:${CAM}`, 'up:DashPal-C4D5']);
  expect(r.t.linked()).toBe(true);
  // the AUTH writes are never split: maxByteSize 128
  expect(r.ble.writes.filter((w) => w.characteristic === AUTH_CHAR).map((w) => [w.bytes.length, w.maxByteSize])).toEqual([
    [26, 128],
    [18, 128],
  ]);
  expect(r.cam.conn()?.state).toBe('up');
});

test('iOS connect: a plain pending connect, no MTU request, the same session', async () => {
  const r = rig('ios');
  await up(r, 'ios');
  expect(r.ble.calls).toContain(`connect:${PID}`);
  expect(r.ble.calls.some((c) => c.startsWith('requestMTU'))).toBe(false);
  expect(r.k.log).toContain('up:DashPal-C4D5');
});

test('frames travel sealed both ways: RX written whole (maxByteSize 64) and opened at the dashcam; TX opened for the link', async () => {
  const r = rig('android');
  await up(r);
  await r.t.write(encodeRx({ type: 'COMMAND', op: 7, arg: 0 }), { withResponse: true });
  await r.t.write(encodeRx({ type: 'ALERT_ACK', alertId: 3, outcome: 1 }), { withResponse: false });
  await flush();
  const rx = r.ble.writes.filter((w) => w.characteristic === RX_CHAR);
  expect(rx.map((w) => [w.bytes.length, w.maxByteSize, w.withResponse])).toEqual([
    [24, 64, true],
    [25, 64, false],
  ]);
  // nothing in clear on the air
  expect(rx.some((w) => decodeRx(w.bytes).ok)).toBe(false);
  expect(r.cam.received).toEqual([
    { type: 'COMMAND', op: 7, arg: 0 },
    { type: 'ALERT_ACK', alertId: 3, outcome: 1 },
  ]);
  // the fake dashcam answered COMMAND 7 with HELLO + STATUS, sealed; the link got them in clear
  expect(r.k.frames.map((f) => f[0])).toEqual([0x01, 0x02]);
});

test('an urgent write (ALERT_ACK) jumps the queue and takes the next counter when it runs', async () => {
  const r = rig('android');
  await up(r);
  let release!: () => void;
  const write = r.ble.writeWithoutResponse.bind(r.ble);
  let first = true;
  r.ble.writeWithoutResponse = async (...a) => {
    if (first) {
      first = false;
      await new Promise<void>((resolve) => (release = resolve));
    }
    return write(...a);
  };
  const p1 = r.t.write(encodeRx({ type: 'STATE', flags: 0, ttlDs: 30, speedCms: 0, localMin: 0, bootId: 0, ackSeq: 0 }), { withResponse: false });
  const p2 = r.t.write(encodeRx({ type: 'ACK', bootId: 1, ackSeq: 2 }), { withResponse: false });
  const p3 = r.t.write(encodeRx({ type: 'ALERT_ACK', alertId: 9, outcome: 1 }), { withResponse: true, urgent: true });
  await flush();
  release();
  await Promise.all([p1, p2, p3]);
  const ctrs = r.ble.writes.filter((w) => w.characteristic === RX_CHAR).map((w) => (w.bytes[0]! | (w.bytes[1]! << 8)) >>> 0);
  expect(ctrs).toEqual([0, 1, 2]);
  expect(r.cam.received.map((f) => f.type)).toEqual(['STATE', 'ALERT_ACK', 'ACK']);
});

test('R_UNKNOWN_PHONE: a soft repair, never a halt: retried at 30 s, then every 60 s; RoadWise in front retries at once; a verified session clears it', async () => {
  const r = rig('android', { known: false });
  await up(r);
  expect(r.k.log).toContain('repair:unknown_phone');
  expect(r.t.linked()).toBe(false);
  expect(connects(r)).toBe(1);
  await r.clock.advance(SOFT_REPAIR_FIRST_MS - 1);
  expect(connects(r)).toBe(1);
  await r.clock.advance(1);
  expect(connects(r)).toBe(2);
  await r.clock.advance(SOFT_REPAIR_EVERY_MS - 1);
  expect(connects(r)).toBe(2);
  await r.clock.advance(1);
  expect(connects(r)).toBe(3);
  // the app comes to the front: at once, not after the rest of the 60 s
  r.t.retryNow();
  await flush();
  expect(connects(r)).toBe(4);
  // the dashcam knows the phone again (set up again elsewhere): the next try links and clears it
  r.cam.phones.set(toHex(PHONE_ID), K);
  r.t.retryNow();
  await flush();
  expect(r.t.linked()).toBe(true);
  expect(r.k.log.at(-1)).toBe('up:DashPal-C4D5');
});

test('INFO above link v3 (newer firmware): a soft repair asking for an app update, not a firmware one; retried', async () => {
  const r = rig('android');
  const info = r.cam.info.bind(r.cam);
  let newer = true;
  r.cam.info = () => {
    const b = info();
    if (newer) {
      b[1] = 4;
      b[2] = 4;
    }
    return b;
  };
  await up(r);
  expect(r.k.log).toContain('repair:update_app');
  expect(r.k.log).not.toContain('repair:downgrade');
  expect(r.ble.writes.filter((w) => w.characteristic === AUTH_CHAR)).toEqual([]);
  newer = false;
  await r.clock.advance(SOFT_REPAIR_FIRST_MS);
  expect(r.t.linked()).toBe(true);
});

test('INFO below link v3: a soft repair (downgrade), retried', async () => {
  const r = rig('android');
  r.cam.protoMax = 2;
  await up(r);
  expect(r.k.log).toContain('repair:downgrade');
  expect(r.ble.writes.filter((w) => w.characteristic === AUTH_CHAR)).toEqual([]);
  r.cam.protoMax = 3;
  await r.clock.advance(SOFT_REPAIR_FIRST_MS);
  expect(r.t.linked()).toBe(true);
});

test('a wrong dashcam proof three times in a row: unverified, still retrying with the backoff, never a frame sent; cleared by a verified session', async () => {
  const r = rig('android');
  r.cam.badProof.session = true;
  await up(r);
  expect(r.k.log).not.toContain('unverified');
  r.cam.badProof.session = true;
  await r.clock.advance(1000);
  r.cam.badProof.session = true;
  await r.clock.advance(2000);
  expect(r.k.log.filter((l) => l === 'unverified')).toHaveLength(1);
  // nothing sealed went out: no SESSION_FIN and no RX write after a bad proof
  expect(r.ble.writes.filter((w) => w.characteristic === AUTH_CHAR).map((w) => w.bytes[0])).toEqual([0x20, 0x20, 0x20]);
  expect(r.ble.writes.filter((w) => w.characteristic === RX_CHAR)).toEqual([]);
  await r.clock.advance(4000);
  expect(r.t.linked()).toBe(true);
});

test('another mac at the paired address three times: unverified; the session is never attempted', async () => {
  const ble = createFakeBle();
  const other = [0xa4, 0xcf, 0x12, 0xb3, 0xc4, 0xd6];
  createFakeDashcam({ ble, id: PID, mac: other, phones: [{ id: PHONE_ID, kPair: K }] });
  const clock = timers();
  const t = createBleTransport(ble, { platform: 'android', now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const k = sink();
  t.attach(k.s);
  t.setTarget(TARGET);
  await t.start();
  await flush();
  await clock.advance(1000);
  await clock.advance(2000);
  expect(k.log.filter((l) => l === 'unverified')).toHaveLength(1);
  expect(ble.writes.filter((w) => w.characteristic === AUTH_CHAR)).toEqual([]);
});

test('iOS: no AUTH characteristic counts as a failed verification (no cache refresh exists); Android refreshes its cache once and links', async () => {
  const i = rig('ios');
  i.ble.peripheral(PID)!.noAuthChar = true;
  await up(i, 'ios');
  await i.clock.advance(1000);
  await i.clock.advance(2000);
  expect(i.k.log.filter((l) => l === 'unverified')).toHaveLength(1);
  expect(i.ble.calls.some((c) => c.startsWith('refreshCache'))).toBe(false);

  const a = rig('android');
  a.ble.peripheral(PID)!.staleCache = true;
  await up(a);
  expect(a.ble.calls.filter((c) => /retrieveServices|refreshCache/.test(c))).toEqual([`retrieveServices:${PID}`, `refreshCache:${PID}`, `retrieveServices:${PID}`]);
  expect(a.t.linked()).toBe(true);
});

test('the backoff resets only when a session is up, not when the connect succeeds', async () => {
  const r = rig('android');
  r.cam.force.session_req = R.NOT_NOW;
  await up(r);
  expect(connects(r)).toBe(1);
  r.cam.force.session_req = R.NOT_NOW;
  await r.clock.advance(1000);
  expect(connects(r)).toBe(2);
  r.cam.force.session_req = R.NOT_NOW;
  await r.clock.advance(1999);
  expect(connects(r)).toBe(2); // 2 s now, not 1 s: the connect success did not reset it
  await r.clock.advance(1);
  expect(connects(r)).toBe(3);
  await r.clock.advance(4000);
  expect(r.t.linked()).toBe(true);
  // up: reset; a drop reconnects at once
  r.ble.drop(PID);
  await flush();
  expect(r.t.linked()).toBe(true);
});

test('R_MTU: Android asks for MTU 247 again and resends; iOS waits 300 ms and resends; a second R_MTU is a fault', async () => {
  const a = rig('android');
  a.cam.force.session_req = R.MTU;
  await up(a);
  expect(a.ble.calls.filter((c) => c.startsWith('requestMTU'))).toHaveLength(2);
  expect(a.t.linked()).toBe(true);

  const i = rig('ios');
  i.cam.force.session_req = R.MTU;
  await up(i, 'ios');
  expect(i.t.linked()).toBe(false);
  await i.clock.advance(IOS_MTU_WAIT_MS);
  expect(i.t.linked()).toBe(true);

  const twice = rig('android');
  twice.cam.mtu = 23;
  await up(twice);
  expect(twice.t.linked()).toBe(false);
  expect(twice.k.log).not.toContain('repair:unknown_phone');
  expect(twice.k.log).not.toContain('unverified');
  expect(twice.errors).toContain('session mtu');
});

test('R_WRONG_PROOF on a fresh connection: disconnect and back off; neither a verification failure nor a soft repair', async () => {
  const r = rig('android');
  r.cam.force.session_fin = R.WRONG_PROOF;
  await up(r);
  expect(r.t.linked()).toBe(false);
  expect(r.k.log.some((l) => l.startsWith('repair') || l === 'unverified')).toBe(false);
  await r.clock.advance(1000);
  expect(r.t.linked()).toBe(true);
});

test('R_WRONG_PROOF on a restored connection (the dashcam may hold its session): one SESSION_REQ again on the same link; twice: disconnect and back off', async () => {
  const r = rig('ios');
  r.t.attach(r.k.s);
  r.t.setTarget(TARGET);
  await r.t.start();
  r.cam.force.session_fin = R.WRONG_PROOF;
  r.ble.onConnect?.(PID); // the OS kept the connection: the dashcam sees it up
  r.ble.restore([PID]);
  await flush();
  expect(r.t.linked()).toBe(true);
  expect(r.ble.writes.filter((w) => w.characteristic === AUTH_CHAR).map((w) => w.bytes[0])).toEqual([0x20, 0x21, 0x20, 0x21]);
  expect(connects(r)).toBe(0);

  const twice = rig('ios');
  twice.t.attach(twice.k.s);
  twice.t.setTarget(TARGET);
  await twice.t.start();
  twice.ble.onConnect?.(PID);
  // every SESSION_FIN answered R_WRONG_PROOF until the test lets go
  let failFins = true;
  const write = twice.ble.onWrite!;
  twice.ble.onWrite = (w) => {
    if (failFins && w.characteristic === AUTH_CHAR && w.bytes[0] === 0x21) twice.cam.force.session_fin = R.WRONG_PROOF;
    return write(w);
  };
  twice.ble.restore([PID]);
  await flush();
  expect(twice.ble.writes.filter((w) => w.characteristic === AUTH_CHAR).map((w) => w.bytes[0])).toEqual([0x20, 0x21, 0x20, 0x21]);
  expect(twice.t.linked()).toBe(false);
  expect(twice.ble.calls).toContain(`disconnect:${PID}`);
  expect(twice.k.log.some((l) => l.startsWith('repair') || l === 'unverified')).toBe(false);
  // the backoff (1 s) then a fresh connection (the central powered on), which proves itself
  failFins = false;
  twice.ble.setState('on');
  await twice.clock.advance(1000);
  expect(twice.t.linked()).toBe(true);
});

test.each(['status=129', 'status=132', 'Write failed'])('an AUTH write rejected with %s is a transport fault: disconnect and back off, never a verdict', async (msg) => {
  const r = rig('android');
  r.ble.failNext(`write:${AUTH_CHAR}`, msg);
  await up(r);
  expect(r.t.linked()).toBe(false);
  expect(r.k.log.some((l) => l.startsWith('repair') || l === 'unverified')).toBe(false);
  await r.clock.advance(1000);
  expect(r.t.linked()).toBe(true);
});

test('an AUTH write that never settles (ble-manager swallows 137 and 5) times out as a transport fault', async () => {
  const r = rig('android');
  r.ble.hangNext(`write:${AUTH_CHAR}`);
  await up(r);
  expect(r.t.linked()).toBe(false);
  await r.clock.advance(5000);
  expect(r.k.log.some((l) => l.startsWith('repair') || l === 'unverified')).toBe(false);
  await r.clock.advance(10_000);
  expect(r.t.linked()).toBe(true);
});

test('TX: a frame that does not open is dropped and counted (32 in a session end the link), a replay is dropped and the link kept, pre-session frames are dropped uncounted', async () => {
  const r = rig('android');
  r.ble.connectMode.set(PID, 'hang');
  r.t.attach(r.k.s);
  r.t.setTarget(TARGET);
  await r.t.start();
  await flush();
  // before the session (an iOS restore with the subscription kept): dropped, not counted
  for (let i = 0; i < 40; i++) r.ble.notify(PID, new Array(30).fill(0xaa));
  expect(r.k.frames).toEqual([]);
  r.ble.completeConnect(PID);
  await flush();
  expect(r.t.linked()).toBe(true);
  r.cam.notify(encodeTx({ type: 'STATUS', uptimeMs: 1, state: 3, flags: 0, fpsX10: 0, tempC: 0, bondCount: 1 }));
  const wire = r.cam.lastWire()!;
  r.ble.notify(PID, wire); // a replay
  expect(r.k.frames).toHaveLength(1);
  for (let i = 0; i < SEAL_FAIL_MAX - 1; i++) r.ble.notify(PID, [...new Array(30).fill(i)]);
  await flush();
  expect(r.t.linked()).toBe(true);
  r.ble.notify(PID, new Array(30).fill(0xee));
  await flush();
  expect(r.t.linked()).toBe(false);
  expect(r.errors).toContain('too many frames that did not open');
});

test('iOS restore: the paired DashPal kept connected gets a session on the kept connection (no new connect); every other peripheral is cancelled', async () => {
  const r = rig('ios');
  r.t.attach(r.k.s);
  await r.t.start();
  r.ble.onConnect?.(PID);
  r.ble.restore([PID, 'OTHER-1']);
  await flush();
  expect(r.ble.calls.some((c) => c.startsWith('disconnect'))).toBe(false);
  r.t.setTarget(TARGET);
  await flush();
  expect(r.ble.calls).toContain('disconnect:OTHER-1');
  expect(r.ble.calls).not.toContain(`disconnect:${PID}`);
  expect(connects(r)).toBe(0);
  expect(r.k.log).toContain('up:DashPal-C4D5');
});

test('Android in the background: the handshake completes with JS timers paused (it waits on native callbacks only)', async () => {
  const ble: FakeBle = createFakeBle();
  createFakeDashcam({ ble, id: PID, mac: MAC, phones: [{ id: PHONE_ID, kPair: K }] });
  const base = createPausableTimerBase();
  const pumped = createPumpedTimers(base);
  const t = createBleTransport(ble, { platform: 'android', now: base.now, setTimer: (fn, ms) => pumped.setTimeout(fn, ms), clearTimer: (h) => pumped.clearTimeout(h) });
  const k = sink();
  t.attach(k.s);
  base.pause(true);
  t.setTarget(TARGET);
  await t.start();
  await flush();
  expect(t.linked()).toBe(true);
});

test('with JS timers paused a soft-repair retry fires from a pump (the link service tick, a row, a BLE event) once due', async () => {
  const ble: FakeBle = createFakeBle();
  const cam = createFakeDashcam({ ble, id: PID, mac: MAC, phones: [] });
  const base = createPausableTimerBase();
  const pumped = createPumpedTimers(base);
  const t = createBleTransport(ble, { platform: 'android', now: base.now, setTimer: (fn, ms) => pumped.setTimeout(fn, ms), clearTimer: (h) => pumped.clearTimeout(h), pump: () => pumped.pump() });
  const k = sink();
  t.attach(k.s);
  t.setTarget(TARGET);
  await t.start();
  await flush();
  expect(k.log).toContain('repair:unknown_phone');
  base.pause(true);
  cam.phones.set(toHex(PHONE_ID), K);
  base.advance(SOFT_REPAIR_FIRST_MS + 5000);
  await flush();
  expect(t.linked()).toBe(false);
  pumped.pump();
  await flush();
  expect(t.linked()).toBe(true);
});

test('a connect call that errors backs off 1 → 2 → 4 … → 30 s', async () => {
  const r = rig('android');
  r.ble.connectMode.set(PID, 'reject');
  await up(r);
  expect(connects(r)).toBe(1);
  for (const w of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    await r.clock.advance(w - 1);
    const before = connects(r);
    await r.clock.advance(1);
    expect(connects(r)).toBe(before + 1);
  }
  expect(BACKOFF_MAX_MS).toBe(30_000);
  r.ble.connectMode.set(PID, 'resolve');
  await r.clock.advance(30_000);
  expect(r.t.linked()).toBe(true);
});

test('iOS: a transport fault backs off 1 → 2 → 4 → 8 s and stays at 8 s (inside the time iOS gives after a Bluetooth event)', async () => {
  const r = rig('ios');
  r.ble.connectMode.set(PID, 'reject');
  await up(r, 'ios');
  expect(connects(r)).toBe(1);
  for (const w of [1000, 2000, 4000, 8000, 8000, 8000]) {
    await r.clock.advance(w - 1);
    const before = connects(r);
    await r.clock.advance(1);
    expect(connects(r)).toBe(before + 1);
  }
  expect(IOS_FAULT_RETRY_MAX_MS).toBe(8000);
  // a session that fails as a fault (R_NOT_NOW) is capped too
  const s = rig('ios');
  for (let i = 0; i < 6; i++) s.cam.force.session_req = R.NOT_NOW;
  await up(s, 'ios');
  for (const w of [1000, 2000, 4000, 8000, 8000]) {
    s.cam.force.session_req = R.NOT_NOW;
    const before = connects(s);
    await s.clock.advance(w);
    expect(connects(s)).toBe(before + 1);
  }
  r.ble.connectMode.set(PID, 'resolve');
  await r.clock.advance(8000);
  expect(r.t.linked()).toBe(true);
});

test('a disconnect during the handshake: iOS asks for the pending connect again at once (no timer); Android reconnects with the backoff', async () => {
  for (const platform of ['ios', 'android'] as const) {
    const r = rig(platform);
    let drops = 3;
    const write = r.ble.onWrite!;
    r.ble.onWrite = (w) => {
      if (drops > 0 && w.characteristic === AUTH_CHAR && w.bytes[0] === 0x20) {
        drops -= 1;
        r.ble.drop(PID);
        throw { message: 'Device is not connected' };
      }
      return write(w);
    };
    await up(r, platform);
    if (platform === 'ios') {
      // three drops in a row, each followed by a pending connect at once; no time passed
      expect(connects(r)).toBe(4);
      expect(r.t.linked()).toBe(true);
    } else {
      expect(connects(r)).toBe(1);
      await r.clock.advance(1000);
      expect(connects(r)).toBe(2);
      await r.clock.advance(2000);
      expect(connects(r)).toBe(3);
      await r.clock.advance(4000);
      expect(r.t.linked()).toBe(true);
    }
  }
});

test('Bluetooth off drops the link and stops connecting; on again reconnects', async () => {
  const r = rig('android');
  await up(r);
  r.ble.setState('off');
  await r.clock.advance(60_000);
  expect(r.k.log).toContain('bt:off');
  expect(r.k.log).toContain('down');
  const n = connects(r);
  r.ble.setState('on');
  await flush();
  expect(connects(r)).toBe(n + 1);
  expect(r.t.linked()).toBe(true);
});

test('forget: a null target cancels the connect (pending or live); nothing reconnects', async () => {
  const r = rig('ios');
  r.ble.connectMode.set(PID, 'hang');
  await up(r, 'ios');
  r.t.setTarget(null);
  await flush();
  expect(r.ble.calls).toContain(`disconnect:${PID}`);
  r.ble.completeConnect(PID);
  await r.clock.advance(60_000);
  expect(connects(r)).toBe(1);
});

test('a new key for the same peripheral (set up again) drops the connection and proves the new key', async () => {
  const r = rig('android');
  await up(r);
  const k2 = new Uint8Array(32).fill(0x55);
  const id2 = Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]);
  r.cam.phones.set(toHex(id2), k2);
  r.t.setTarget({ ...TARGET, auth: { phoneId: toHex(id2), kPair: toHex(k2) } });
  await flush();
  expect(r.ble.calls.filter((c) => c === `disconnect:${PID}`)).toHaveLength(1);
  expect(r.t.linked()).toBe(true);
  expect(r.cam.conn()?.phone).toBe(toHex(id2));
});

test('frames that opened before a link was attached are buffered and delivered at attach; a drop clears them', async () => {
  const r = rig('android');
  r.t.setTarget(TARGET);
  await r.t.start();
  await flush();
  r.cam.notify(encodeTx({ type: 'PAIRED', bondCount: 1 }));
  r.cam.notify(encodeTx({ type: 'PAIRED', bondCount: 2 }));
  r.t.attach(r.k.s);
  expect(r.k.log.at(-1)).toBe('up:DashPal-C4D5');
  expect(r.k.frames).toEqual([
    [8, 1, 1],
    [8, 1, 2],
  ]);
});

test('setup: the scans pass low latency and aggressive matching (fast); the nearby prompt keeps the default', async () => {
  const r = rig('android');
  const hits: string[] = [];
  const a = await r.t.scan({ services: [PAIRING_NEW, PAIRING_SETUP, PAIRING_OPEN, DASHPAL_SERVICE], seconds: 15, fast: true, onHit: (h) => hits.push(`${h.id}:${h.adv}`) });
  r.ble.advertise({ id: 'X', rssi: -60, advertising: { serviceUUIDs: ['d5a10099-7b3e-4c8a-9f21-0c6e5a7d2b10'] } });
  r.ble.advertise({ id: PID, rssi: -55, advertising: { serviceUUIDs: [DASHPAL_SERVICE.toUpperCase()], localName: 'DashPal-C4D5' } });
  r.ble.advertise({ id: 'N', rssi: -55, advertising: { serviceUUIDs: [PAIRING_NEW] } });
  r.ble.advertise({ id: 'H', rssi: -55, advertising: { serviceUUIDs: [PAIRING_SETUP] } });
  r.ble.advertise({ id: 'O', rssi: -55, advertising: { serviceUUIDs: [PAIRING_OPEN.toUpperCase()] } });
  await a.stop();
  const b = await r.t.scan({ services: [PAIRING_NEW], seconds: 15, onHit: () => {} });
  await b.stop();
  expect(hits).toEqual([`${PID}:closed`, 'N:new', 'H:setup', 'O:open']);
  expect(r.ble.scans).toEqual([
    { serviceUUIDs: [PAIRING_NEW, PAIRING_SETUP, PAIRING_OPEN, DASHPAL_SERVICE], seconds: 15, scanMode: 2, matchMode: 1 },
    { serviceUUIDs: [PAIRING_NEW], seconds: 15 },
  ]);
});

test('setup connect with no OS bond never calls removeBond (it would never settle); with a bond listed, it is removed once first', async () => {
  const r = rig('android');
  const before = r.clock.now();
  expect(await r.t.setupConnect(PID)).toEqual({ auth: true, view: true });
  expect(r.clock.now()).toBe(before);
  expect(r.ble.calls.filter((c) => /Bond/.test(c))).toEqual(['getBondedPeripherals']);
  await r.t.disconnect(PID);

  const b = rig('android');
  b.ble.peripheral(PID)!.osBonded = true;
  b.ble.addPeripheral(b.ble.peripheral(PID)!);
  await b.t.setupConnect(PID);
  expect(b.ble.calls.filter((c) => /Bond|^connect/.test(c))).toEqual(['getBondedPeripherals', `removeBond:${PID}`, `connect:${PID}`]);
});

test('setup: a session on the setup connection, then sealed writes and frames there', async () => {
  const r = rig('android');
  await r.t.setupConnect(PID);
  const info = (await r.t.readInfo(PID))!;
  expect(info.nonce).toHaveLength(16);
  expect(await r.t.startSession(PID, info, TARGET.auth)).toMatchObject({ kind: 'up' });
  const got: number[][] = [];
  const off = await r.t.subscribeSealed(PID, (b) => got.push(b));
  await r.t.writeSealed(PID, encodeRx({ type: 'COMMAND', op: 5, arg: 0 }));
  await flush();
  expect(r.cam.received).toEqual([{ type: 'COMMAND', op: 5, arg: 0 }]);
  expect(got).toEqual([[8, 1, 1]]);
  expect(r.ble.calls.filter((c) => c.startsWith('write')).at(-1)).toBe(`write:${PID}:0005`);
  // The aiming picture's acknowledgements go without response, sealed in turn.
  await r.t.writeSealed(PID, encodeRx({ type: 'COMMAND', op: 11, arg: 4 }), { withResponse: false });
  await flush();
  expect(r.ble.calls.at(-1)).toBe(`writeWithoutResponse:${PID}:0005`);
  expect(r.cam.received.at(-1)).toEqual({ type: 'COMMAND', op: 11, arg: 4 });
  off();
  // an unknown phone, and no session at all
  r.cam.phones.clear();
  const again = (await r.t.readInfo(PID))!;
  expect(await r.t.startSession(PID, again, TARGET.auth)).toEqual({ kind: 'unknown_phone' });
  await r.t.disconnect(PID);
  await expect(r.t.writeSealed(PID, [0x86, 1, 7, 0])).rejects.toThrow('no session');
});

test('setup: AUTH write and read as the setup sees them (ok / fault; the read value parsed)', async () => {
  const r = rig('android');
  await r.t.setupConnect(PID);
  r.ble.failNext(`write:${AUTH_CHAR}`, 'status=133');
  expect(await r.t.authWrite(PID, new Uint8Array(26))).toBe('fault');
  expect(await r.t.authRead(PID)).toEqual({ kind: 'pending' });
  r.ble.failNext(`read:${AUTH_CHAR}`, 'status=133');
  expect(await r.t.authRead(PID)).toBe('fault');
});

test('the setup link is up from the setup connect until a disconnect event or our own disconnect', async () => {
  const r = rig('android');
  expect(r.t.setupLinkUp(PID)).toBe(false);
  await r.t.setupConnect(PID);
  expect(r.t.setupLinkUp(PID.toLowerCase())).toBe(true);
  r.ble.drop(PID);
  expect(r.t.setupLinkUp(PID)).toBe(false);
  await r.t.setupConnect(PID);
  expect(r.t.setupLinkUp(PID)).toBe(true);
  await r.t.disconnect(PID);
  expect(r.t.setupLinkUp(PID)).toBe(false);
});

test('a setup connect that never completes is cancelled at its timeout', async () => {
  const r = rig('ios');
  r.ble.connectMode.set(PID, 'hang');
  const p = r.t.setupConnect(PID, { timeoutMs: 15_000 });
  const caught = p.catch((e: unknown) => e);
  await flush();
  await r.clock.advance(15_000);
  expect(String(await caught)).toMatch(/timed out/);
  expect(r.ble.calls).toContain(`disconnect:${PID}`);
});

test('the sealed frames are those of the shared format (the dashcam opens what the phone seals and back)', () => {
  const k = new Uint8Array(16).fill(3);
  const w = sealRaw(k, DIR_PD, 7, [0x86, 1, 7, 0]);
  expect(openRaw(k, DIR_PD, w)?.ctr).toBe(7);
  expect(openRaw(k, DIR_DP, w)).toBeNull();
  void authOps;
});

describe('the aiming picture on a setup connection (VIEW)', () => {
  /** A setup connection with a session up; the dashcam's VIEW key from the wiretap of its handshake. */
  async function viewRig() {
    const r = rig('android');
    await r.t.setupConnect(PID);
    const info = (await r.t.readInfo(PID))!;
    expect(await r.t.startSession(PID, info, TARGET.auth)).toMatchObject({ kind: 'up' });
    // the dashcam's side of the session: its k_dp seals the records
    return { r, kdp: r.cam.conn()!.kdp! };
  }

  test('subscribeView starts VIEW notifications and hands each opened record to its listener; replays and TX frames on VIEW are dropped', async () => {
    const { r, kdp } = await viewRig();
    const got: number[][] = [];
    await r.t.subscribeView(PID, (rec) => got.push(rec));
    expect(r.ble.calls).toContain(`startNotification:${PID}:0007`);
    const rec = [1, 1, 1, 0, 3, 0, 0, 0, 0xff, 0xd8, 0xd9];
    const w0 = Array.from(sealView(kdp, 0, rec));
    r.ble.notifyView(PID, w0);
    r.ble.notifyView(PID, w0);
    r.ble.notifyView(PID, Array.from(sealRaw(kdp, DIR_DP, 1, [8, 1, 1])));
    r.ble.notifyView(PID, Array.from(sealView(kdp, 1, rec)));
    expect(got).toEqual([rec, rec]);
    // a VIEW record on TX never reaches the frame handler
    const frames: number[][] = [];
    await r.t.subscribeSealed(PID, (b) => frames.push(b));
    r.ble.notify(PID, Array.from(sealView(kdp, 2, rec)));
    expect(frames).toEqual([]);
  });

  test('with no listener nothing is kept; unsubscribeView stops the notifications', async () => {
    const { r, kdp } = await viewRig();
    const got: number[][] = [];
    r.ble.notifyView(PID, Array.from(sealView(kdp, 0, [1, 1, 1, 0, 1, 0, 0, 0, 7])));
    await r.t.subscribeView(PID, (rec) => got.push(rec));
    expect(got).toEqual([]);
    await r.t.unsubscribeView(PID);
    expect(r.ble.calls).toContain(`stopNotification:${PID}:0007`);
    r.ble.notifyView(PID, Array.from(sealView(kdp, 1, [1, 1, 1, 0, 1, 0, 0, 0, 7])));
    expect(got).toEqual([]);
  });

  test('32 VIEW records that do not open end the setup connection', async () => {
    const { r } = await viewRig();
    await r.t.subscribeView(PID, () => {});
    const junk = new Uint8Array(16).fill(9);
    for (let i = 0; i < SEAL_FAIL_MAX - 1; i++) r.ble.notifyView(PID, Array.from(sealView(junk, i, [1, 2, 3])));
    expect(r.t.setupLinkUp(PID)).toBe(true);
    r.ble.notifyView(PID, Array.from(sealView(junk, 99, [1, 2, 3])));
    await flush();
    expect(r.ble.calls).toContain(`disconnect:${PID}`);
  });

  test('a cache without VIEW: Android refreshes it once; the answer says what was found', async () => {
    const r = rig('android');
    r.ble.peripheral(PID)!.staleCache = true;
    expect(await r.t.setupConnect(PID)).toEqual({ auth: true, view: true });
    expect(r.ble.calls.filter((c) => c.startsWith('refreshCache'))).toHaveLength(1);
    await r.t.disconnect(PID);
    const old = rig('android');
    old.ble.peripheral(PID)!.noViewChar = true;
    expect(await old.t.setupConnect(PID)).toEqual({ auth: true, view: false });
    expect(old.ble.calls.filter((c) => c.startsWith('refreshCache'))).toHaveLength(1);
    expect(VIEW_CHAR.slice(4, 8)).toBe('0007');
  });
});
