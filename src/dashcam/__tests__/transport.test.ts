import { createPausableTimerBase } from '@/lib/__fixtures__/pausableTimers';
import { createPumpedTimers } from '@/lib/timers';

import { createFakeBle, type FakeBle } from '../fakeTransport';
import type { BluetoothState, RepairCause } from '../link';
import { decodeInfo, encodeInfo, IDENTIFY_CHAR, PAIRING_SERVICE, DASHPAL_SERVICE, RX_CHAR, TX_CHAR, type DashcamInfo } from '../protocol';
import { BACKOFF_MAX_MS, createBleTransport, isBondLoss, REFLASH_DOWN_MS, RESTORE_ID, type DashcamTransport, type TransportSink } from '../transport';

const PID = 'AA:BB:CC:DD:EE:FF';
const CAM = 'a4cf12b3c4d5';
const MAC = [0xa4, 0xcf, 0x12, 0xb3, 0xc4, 0xd5];
const infoBytes = (over: Partial<Omit<DashcamInfo, 'dashcamId' | 'name'>> = {}) =>
  encodeInfo({ ver: 1, protoMin: 1, protoMax: 1, fwMajor: 3, fwMinor: 3, mac: MAC, peerBonded: true, bondCount: 1, pairingOpen: false, ...over });

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
    pendingCount: () => pending.size,
  };
}

const flush = async () => {
  for (let i = 0; i < 80; i++) await new Promise<void>((resolve) => setImmediate(resolve));
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
    frame: (b: number[]) => frames.push(b),
  };
  return { s, log, frames, setVeto: (v: boolean) => (veto = v) };
}

function rig(platform: 'ios' | 'android' = 'android') {
  const ble: FakeBle = createFakeBle();
  ble.addPeripheral({ id: PID, info: infoBytes() });
  const clock = timers();
  const errors: string[] = [];
  const t: DashcamTransport = createBleTransport(ble, {
    platform,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (e, ctx) => errors.push(ctx),
  });
  const k = sink();
  return { ble, t, clock, k, errors };
}

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
  // Attaching and detaching links (runtime rebuilds) never adds native listeners.
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

test('Android connect sequence: autoconnect, MTU 247, services, INFO, the link decides, then TX notifications, then link up', async () => {
  const r = rig('android');
  r.t.attach(r.k.s);
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  await flush();
  expect(r.ble.calls.filter((c) => !c.startsWith('start:') && c !== 'checkState')).toEqual([
    `connect:${PID}:auto`,
    `requestMTU:${PID}:247`,
    `retrieveServices:${PID}`,
    `read:${PID}:0002`,
    `startNotification:${PID}:0004`,
  ]);
  expect(r.k.log).toEqual(['bt:unknown', 'bt:on', 'connecting', `info:${CAM}`, 'up:DashPal-C4D5']);
  expect(r.t.linked()).toBe(true);
});

test('iOS connect: a plain pending connect, no MTU request', async () => {
  const r = rig('ios');
  r.t.attach(r.k.s);
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  r.ble.setState('on');
  await flush();
  expect(r.ble.calls).toContain(`connect:${PID}`);
  expect(r.ble.calls.some((c) => c.startsWith('requestMTU'))).toBe(false);
  expect(r.k.log).toContain('up:DashPal-C4D5');
});

test('row 21: INFO peer_bonded = 0 → needs_repair; nothing encrypted is touched and nothing reconnects, even before the link is attached', async () => {
  const r = rig('android');
  r.ble.addPeripheral({ id: PID, info: infoBytes({ peerBonded: false }) });
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  await flush();
  expect(r.ble.calls.some((c) => c.startsWith('startNotification'))).toBe(false);
  expect(r.ble.calls).toContain(`disconnect:${PID}`);
  r.t.attach(r.k.s);
  expect(r.k.log).toContain('repair:peer_not_bonded');
  r.ble.drop(PID);
  await r.clock.advance(60_000);
  expect(r.ble.calls.filter((c) => c.startsWith('connect'))).toHaveLength(1);
  // Re-paired: a new target (even the same one) clears the halt.
  r.ble.addPeripheral({ id: PID, info: infoBytes() });
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await flush();
  expect(r.t.linked()).toBe(true);
});

test('another dashcam answering at the paired id → needs_repair (wrong_dashcam)', async () => {
  const r = rig('android');
  r.ble.addPeripheral({ id: PID, info: infoBytes({ mac: [1, 2, 3, 4, 5, 6] }) });
  r.t.attach(r.k.s);
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  await flush();
  expect(r.k.log).toContain('repair:wrong_dashcam');
  expect(r.ble.calls.some((c) => c.startsWith('startNotification'))).toBe(false);
});

test('a dropped link reconnects at once (Android re-issues autoconnect after every disconnect)', async () => {
  const r = rig('android');
  r.t.attach(r.k.s);
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  await flush();
  r.ble.drop(PID, { status: 8 });
  await flush();
  expect(r.k.log.filter((l) => l === 'down')).toHaveLength(1);
  expect(r.ble.calls.filter((c) => c === `connect:${PID}:auto`)).toHaveLength(2);
  expect(r.t.linked()).toBe(true);
});

test('a connect call that errors backs off 1 → 2 → 4 … → 30 s; a success resets it', async () => {
  const r = rig('android');
  r.ble.connectMode.set(PID, 'reject');
  r.t.attach(r.k.s);
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  await flush();
  const connects = () => r.ble.calls.filter((c) => c.startsWith('connect')).length;
  expect(connects()).toBe(1);
  const waits = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
  for (const w of waits) {
    await r.clock.advance(w - 1);
    const before = connects();
    await r.clock.advance(1);
    expect(connects()).toBe(before + 1);
  }
  expect(BACKOFF_MAX_MS).toBe(30_000);
  // Each failure closes the half-open GATT before the next try.
  expect(r.ble.calls.filter((c) => c === `disconnect:${PID}`).length).toBeGreaterThanOrEqual(waits.length);
  r.ble.connectMode.set(PID, 'resolve');
  await r.clock.advance(30_000);
  expect(r.t.linked()).toBe(true);
  r.ble.drop(PID);
  await flush();
  expect(r.t.linked()).toBe(true); // straight back, no backoff
});

test('with JS timers paused (Android, app in the background) the backoff fires from a pump: a drive row or any BLE event once it is due', async () => {
  const ble: FakeBle = createFakeBle();
  ble.addPeripheral({ id: PID, info: infoBytes() });
  ble.connectMode.set(PID, 'reject');
  const base = createPausableTimerBase();
  const pumped = createPumpedTimers(base);
  let pumps = 0;
  const t = createBleTransport(ble, {
    platform: 'android',
    now: base.now,
    setTimer: (fn, ms) => pumped.setTimeout(fn, ms),
    clearTimer: (h) => pumped.clearTimeout(h),
    pump: () => {
      pumps += 1;
      pumped.pump();
    },
  });
  const k = sink();
  t.attach(k.s);
  t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await t.start();
  await flush();
  const connects = () => ble.calls.filter((c) => c.startsWith('connect')).length;
  expect(connects()).toBe(1);
  base.pause(true);
  base.advance(5000); // the 1 s backoff is long due; paused JS timers never fire it
  await flush();
  expect(connects()).toBe(1);
  pumped.pump(); // a drive row
  await flush();
  expect(connects()).toBe(2);
  // The next backoff (2 s) fires from a BLE event's pump once due, not before.
  ble.connectMode.set(PID, 'resolve');
  base.advance(1000);
  ble.notify('OTHER', [9, 9]);
  await flush();
  expect(connects()).toBe(2);
  base.advance(1000);
  ble.notify('OTHER', [9, 9]);
  await flush();
  expect(connects()).toBe(3);
  expect(t.linked()).toBe(true);
  expect(pumps).toBe(2);
  ble.drop(PID);
  await flush();
  expect(pumps).toBe(3);
  expect(t.linked()).toBe(true); // a link that was up reconnects at once, no timer
});

test.each([
  ['iOS peer removed pairing information', 'ios', { domain: 'CBErrorDomain', code: 14 }],
  ['Android MIC failure 0x3D', 'android', { status: 0x3d }],
  ['Android key missing 0x06', 'android', { status: 0x06 }],
] as const)('bond loss on disconnect (%s) → needs_repair, no reconnect loop', async (_name, platform, e) => {
  const r = rig(platform);
  r.t.attach(r.k.s);
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  r.ble.setState('on');
  await flush();
  const n = r.ble.calls.filter((c) => c.startsWith('connect')).length;
  r.ble.drop(PID, e);
  await r.clock.advance(120_000);
  expect(r.k.log).toContain('repair:bond_lost');
  expect(r.ble.calls.filter((c) => c.startsWith('connect')).length).toBe(n);
});

test('bond loss on a GATT op (Android status=5 on subscribe; iOS ATT 15 on a write) → needs_repair', async () => {
  const a = rig('android');
  a.ble.failNext('startNotification', 'Error writing descriptor status=5');
  a.t.attach(a.k.s);
  a.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await a.t.start();
  await flush();
  expect(a.k.log).toContain('repair:bond_lost');

  const i = rig('ios');
  i.t.attach(i.k.s);
  i.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await i.t.start();
  i.ble.setState('on');
  await flush();
  i.ble.failNext('write', { code: 15, domain: 'CBATTErrorDomain', message: 'Encryption is insufficient.' });
  await expect(i.t.write([0x86, 1, 7, 0], { withResponse: true })).rejects.toBeDefined();
  expect(i.k.log).toContain('repair:bond_lost');
  expect(isBondLoss('Error reading x status=133', 'android')).toBe(false);
  expect(isBondLoss({ code: 7, domain: 'CBErrorDomain' }, 'ios')).toBe(false);
});

test('row 42 / restore: iOS restores the paired dashcam (set up without a new connect) and cancels every other peripheral; before the target is known, it waits for it', async () => {
  const r = rig('ios');
  r.t.attach(r.k.s);
  await r.t.start();
  r.ble.restore([PID, 'OTHER-1']);
  await flush();
  expect(r.ble.calls.some((c) => c.startsWith('disconnect'))).toBe(false);
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await flush();
  expect(r.ble.calls).toContain('disconnect:OTHER-1');
  expect(r.ble.calls).not.toContain(`disconnect:${PID}`);
  expect(r.k.log).toContain('up:DashPal-C4D5');

  // Forgotten (no target): a restored DashPal is cancelled too.
  const f = rig('ios');
  f.t.setTarget({ peripheralId: 'NEW', dashcamId: '0000000000ff' });
  await f.t.start();
  f.ble.restore([PID]);
  await flush();
  expect(f.ble.calls).toContain(`disconnect:${PID}`);
});

test('forget: a null target cancels the connect (pending or live) and reports the link down', async () => {
  const r = rig('ios');
  r.ble.connectMode.set(PID, 'hang');
  r.t.attach(r.k.s);
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  r.ble.setState('on');
  await flush();
  r.t.setTarget(null);
  await flush();
  expect(r.ble.calls).toContain(`disconnect:${PID}`);
  r.ble.completeConnect(PID);
  await r.clock.advance(60_000);
  expect(r.ble.calls.filter((c) => c.startsWith('connect'))).toHaveLength(1);
});

test('frames: buffered until the link is attached and up, then delivered in order; other peripherals and other characteristics ignored; cleared on disconnect', async () => {
  const r = rig('android');
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  await flush();
  r.ble.notify(PID, [1, 1]);
  r.ble.notify(PID, [2, 1]);
  r.ble.notify('OTHER', [9, 9]);
  r.t.attach(r.k.s);
  expect(r.k.log.at(-1)).toBe('up:DashPal-C4D5');
  expect(r.k.frames).toEqual([
    [1, 1],
    [2, 1],
  ]);
  r.ble.notify(PID, [3, 1]);
  expect(r.k.frames).toHaveLength(3);

  // Frames buffered for a connection that then dropped are not replayed into the next one.
  const q = rig('android');
  q.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await q.t.start();
  await flush();
  q.ble.notify(PID, [7, 1]);
  q.ble.drop(PID);
  await flush();
  q.t.attach(q.k.s);
  expect(q.k.frames).toEqual([]);
});

test('writes: one GATT op at a time; an urgent write (ALERT_ACK) goes before anything queued; RX with or without response', async () => {
  const r = rig('android');
  r.t.attach(r.k.s);
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  await flush();
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
  const p1 = r.t.write([0x81, 1], { withResponse: false });
  const p2 = r.t.write([0x82, 1], { withResponse: false });
  const p3 = r.t.write([0x83, 1], { withResponse: true, urgent: true });
  await flush();
  expect(r.ble.writes).toEqual([]);
  release();
  await Promise.all([p1, p2, p3]);
  expect(r.ble.writes.map((w) => [w.bytes[0], w.withResponse, w.characteristic])).toEqual([
    [0x81, false, RX_CHAR],
    [0x83, true, RX_CHAR],
    [0x82, false, RX_CHAR],
  ]);
  r.ble.connectMode.set(PID, 'hang');
  r.ble.drop(PID);
  await flush();
  await expect(r.t.write([0x81, 1], { withResponse: false })).rejects.toThrow('not connected');
});

test('row 22: Bluetooth off drops the link and stops connecting; on again reconnects', async () => {
  const r = rig('android');
  r.t.attach(r.k.s);
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  await flush();
  r.ble.setState('off');
  await r.clock.advance(60_000);
  expect(r.k.log).toContain('bt:off');
  expect(r.k.log).toContain('down');
  const n = r.ble.calls.filter((c) => c.startsWith('connect')).length;
  r.ble.setState('on');
  await flush();
  expect(r.ble.calls.filter((c) => c.startsWith('connect')).length).toBe(n + 1);
});

test('Android: the paired MAC advertising the pairing service 20 s after the link went down → needs_repair (reflashed); sooner, nothing', async () => {
  const r = rig('android');
  r.t.attach(r.k.s);
  r.t.setTarget({ peripheralId: PID, dashcamId: CAM });
  await r.t.start();
  await flush();
  r.ble.connectMode.set(PID, 'hang');
  r.ble.drop(PID);
  await flush();
  // the hanging autoconnect is 'connecting', not down: simulate it failing
  r.ble.connectMode.set(PID, 'reject');
  await r.t.disconnect(PID);
  await flush();
  r.ble.advertise({ id: PID, rssi: -50, advertising: { serviceUUIDs: [PAIRING_SERVICE] } });
  expect(r.k.log).not.toContain('repair:reflashed');
  await r.clock.advance(REFLASH_DOWN_MS);
  r.ble.advertise({ id: PID, rssi: -50, advertising: { serviceUUIDs: [PAIRING_SERVICE.toUpperCase()] } });
  expect(r.k.log).toContain('repair:reflashed');
});

test('setup ops: scan filters on the service; identify writes 0x01; Android bond drops a stale bond first; iOS bonds through an encrypted read', async () => {
  const r = rig('android');
  r.ble.addPeripheral({ id: PID, info: infoBytes(), osBonded: true });
  const hits: string[] = [];
  const scan = await r.t.scan({ service: PAIRING_SERVICE, seconds: 15, onHit: (h) => hits.push(`${h.id}:${h.rssi}:${h.pairing}`) });
  r.ble.advertise({ id: 'X', rssi: -60, advertising: { serviceUUIDs: [DASHPAL_SERVICE] } });
  r.ble.advertise({ id: PID, rssi: -55, advertising: { serviceUUIDs: [PAIRING_SERVICE], localName: 'DashPal-C4D5' } });
  await scan.stop();
  expect(hits).toEqual([`${PID}:-55:true`]);
  expect(r.ble.calls).toContain(`scan:${PAIRING_SERVICE}:15`);
  await r.t.setupConnect(PID);
  expect(decodeInfo(await r.t.readInfo(PID).then((i) => encodeInfo(i!)))?.dashcamId).toBe(CAM);
  await r.t.identify(PID);
  expect(r.ble.writes.at(-1)).toEqual({ id: PID, characteristic: IDENTIFY_CHAR, bytes: [1], withResponse: true });
  await r.t.bond(PID);
  const order = r.ble.calls.filter((c) => /Bond/.test(c));
  expect(order).toEqual(['getBondedPeripherals', `removeBond:${PID}`, `createBond:${PID}`]);

  const i = rig('ios');
  await i.t.setupConnect(PID);
  await i.t.bond(PID);
  expect(i.ble.calls).toContain(`read:${PID}:0004`);
  expect(i.ble.calls.some((c) => c.includes('Bond'))).toBe(false);
  void TX_CHAR;
});

test('a setup connect that never completes is cancelled at its timeout', async () => {
  const r = rig('ios');
  r.ble.connectMode.set(PID, 'hang');
  const p = r.t.setupConnect(PID, 15_000);
  const caught = p.catch((e: unknown) => e);
  await flush();
  await r.clock.advance(15_000);
  expect(String(await caught)).toMatch(/timed out/);
  expect(r.ble.calls).toContain(`disconnect:${PID}`);
});
