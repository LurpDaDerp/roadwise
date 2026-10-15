import type { BluetoothAccess } from '@/core/permissions/adapters';

import { createFakeBle, type FakeBle } from '../fakeTransport';
import type { PairedDashcam } from '../keys';
import { decodeRx, encodeInfo, encodeTx, IDENTIFY_CHAR, PAIRING_SERVICE, RX_CHAR, type DashcamInfo } from '../protocol';
import { BUSY_POLL_MS, BUSY_RETRY_MS, CONFIRM_TIMEOUT_MS, createSetupFlow, type SetupFlow, type SetupPhase } from '../setup';
import { createBleTransport, type DashcamTransport } from '../transport';

const flush = async () => {
  for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const MAC = (last: number) => [0xa4, 0xcf, 0x12, 0xb3, 0xc4, last];
const info = (last: number, over: Partial<Omit<DashcamInfo, 'dashcamId' | 'name'>> = {}) =>
  encodeInfo({ ver: 1, protoMin: 1, protoMax: 1, fwMajor: 3, fwMinor: 3, mac: MAC(last), peerBonded: false, bondCount: 0, pairingOpen: true, ...over });

interface Rig {
  flow: SetupFlow;
  ble: FakeBle;
  t: DashcamTransport;
  phases: string[];
  paired: PairedDashcam[];
  clock: { t: number };
  setBusy(v: boolean): void;
  until(kind: SetupPhase['kind']): Promise<void>;
  /** the sleeps the flow made (ms) */
  sleeps: number[];
  /** End the confirm question's 110 s wait (it otherwise never ends on its own here). */
  expireConfirm(): void;
}

function rig(
  o: { platform?: 'ios' | 'android'; access?: BluetoothAccess; previous?: PairedDashcam | null; preferId?: string; pairedCount?: number | null } = {}
): Rig {
  const platform = o.platform ?? 'android';
  const ble = createFakeBle();
  const t = createBleTransport(ble, { platform, setTimer: () => 0, clearTimer: () => {} });
  const clock = { t: 0 };
  const phases: string[] = [];
  const paired: PairedDashcam[] = [];
  let busy = false;
  // The dashcam answers COMMAND 5 with PAIRED.
  ble.onWrite = (w) => {
    if (w.characteristic !== RX_CHAR) return;
    const d = decodeRx(w.bytes);
    const count = o.pairedCount === undefined ? 1 : o.pairedCount;
    if (d.ok && d.frame.type === 'COMMAND' && d.frame.op === 5 && count !== null) queueMicrotask(() => ble.notify(w.id, encodeTx({ type: 'PAIRED', bondCount: count })));
  };
  const sleeps: number[] = [];
  const long: (() => void)[] = [];
  const flow = createSetupFlow({
    platform,
    transport: () => t,
    requestBluetooth: async () => o.access ?? 'granted',
    isBusy: () => busy,
    optIn: async () => void phases.push('optIn'),
    pair: async (r) => void paired.push(r),
    paired: () => o.previous ?? null,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (ms >= CONFIRM_TIMEOUT_MS) {
        await new Promise<void>((resolve) => long.push(resolve));
        return;
      }
      clock.t += ms;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    preferId: o.preferId,
  });
  flow.subscribe((p) => phases.push(p.kind));
  return {
    flow,
    ble,
    t,
    phases,
    paired,
    clock,
    setBusy: (v) => (busy = v),
    sleeps,
    expireConfirm: () => {
      clock.t += CONFIRM_TIMEOUT_MS;
      for (const fn of long.splice(0)) fn();
    },
    async until(kind) {
      for (let i = 0; i < 400 && flow.phase().kind !== kind; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      expect(flow.phase().kind).toBe(kind);
    },
  };
}

test('row 43: refused while a drive is open, before any permission or Bluetooth', async () => {
  const r = rig();
  r.setBusy(true);
  await r.flow.start();
  expect(r.phases).toEqual(['busy']);
  expect(r.ble.calls).toEqual([]);
});

test.each([
  ['denied', 'denied'],
  ['undetermined', 'denied'],
  ['off', 'off'],
  ['unavailable', 'unavailable'],
] as const)('Bluetooth %s → %s, no scan', async (access, kind) => {
  const r = rig({ access });
  await r.flow.start();
  expect(r.flow.phase().kind).toBe(kind);
  expect(r.ble.calls.some((c) => c.startsWith('scan'))).toBe(false);
  expect(r.phases).toContain('optIn');
});

test('the closest candidate first (RSSI ≥ −80); identify; "No" moves to the next; "Yes" bonds (Android: a stale OS bond dropped before the connect), hellos, confirms and saves', async () => {
  const r = rig({ platform: 'android' });
  r.ble.addPeripheral({ id: 'FAR', info: info(0xd1) });
  r.ble.addPeripheral({ id: 'NEAR', info: info(0xd2), osBonded: true });
  r.ble.addPeripheral({ id: 'MID', info: info(0xd3) });
  const run = r.flow.start();
  await r.until('scanning');
  r.ble.advertise({ id: 'FAR', rssi: -85, advertising: { serviceUUIDs: [PAIRING_SERVICE] } });
  r.ble.advertise({ id: 'MID', rssi: -70, advertising: { serviceUUIDs: [PAIRING_SERVICE] } });
  r.ble.advertise({ id: 'NEAR', rssi: -60, advertising: { serviceUUIDs: [PAIRING_SERVICE] } });
  await r.until('confirm');
  expect(r.flow.phase()).toMatchObject({ candidate: { id: 'NEAR' } });
  expect(r.ble.writes.at(-1)).toMatchObject({ id: 'NEAR', characteristic: IDENTIFY_CHAR, bytes: [1] });
  r.flow.answer(false);
  for (let i = 0; i < 400; i++) {
    const p = r.flow.phase();
    if (p.kind === 'confirm' && p.candidate.id === 'MID') break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(r.flow.phase()).toMatchObject({ kind: 'confirm', candidate: { id: 'MID' } });
  expect(r.ble.calls).toContain('disconnect:NEAR');
  r.flow.answer(true);
  await run;
  expect(r.flow.phase().kind).toBe('done');
  expect(r.paired).toEqual([{ dashcamId: 'a4cf12b3c4d3', peripheralId: 'MID', name: 'DashPal-C4D3', pairedAt: expect.any(Number) }]);
  // FAR was never tried (too weak).
  expect(r.ble.calls.some((c) => c.includes('FAR'))).toBe(false);
  const from = r.ble.calls.indexOf('connect:MID') - 1;
  const mid = r.ble.calls.slice(from).filter((c) => c.includes('MID') || c === 'getBondedPeripherals');
  expect(mid).toEqual([
    'getBondedPeripherals',
    'connect:MID',
    'requestMTU:MID:247',
    'retrieveServices:MID',
    'read:MID:0002',
    'write:MID:0003',
    'createBond:MID',
    'startNotification:MID:0004',
    'write:MID:0005',
    'write:MID:0005',
    'disconnect:MID',
  ]);
  const commands = r.ble.writes.filter((w) => w.id === 'MID' && w.characteristic === RX_CHAR).map((w) => decodeRx(w.bytes));
  expect(commands).toEqual([
    { ok: true, frame: { type: 'COMMAND', op: 7, arg: 0 } },
    { ok: true, frame: { type: 'COMMAND', op: 5, arg: 0 } },
  ]);
});

test('Android re-pair of a dashcam the OS still holds a bond for: removeBond before the setup connect, then identify and createBond on that connection', async () => {
  const r = rig({ platform: 'android' });
  r.ble.addPeripheral({ id: 'P', info: info(0xd5), osBonded: true });
  const run = r.flow.start();
  await r.until('scanning');
  r.ble.advertise({ id: 'P', rssi: -50, advertising: { serviceUUIDs: [PAIRING_SERVICE] } });
  await r.until('confirm');
  r.flow.answer(true);
  await run;
  expect(r.ble.calls.filter((c) => /Bond|connect|0003/.test(c))).toEqual(['getBondedPeripherals', 'removeBond:P', 'connect:P', 'write:P:0003', 'createBond:P', 'disconnect:P']);
});

test('iOS: the encrypted TX read is the pairing; a stale iOS bond says to forget it in Settings first', async () => {
  const ok = rig({ platform: 'ios' });
  ok.ble.setState('on');
  ok.ble.addPeripheral({ id: 'U1', info: info(0xd6) });
  const run = ok.flow.start();
  await ok.until('scanning');
  ok.ble.advertise({ id: 'U1', rssi: -40, advertising: { serviceUUIDs: [PAIRING_SERVICE] } });
  await ok.until('confirm');
  ok.flow.answer(true);
  await run;
  expect(ok.flow.phase().kind).toBe('done');
  expect(ok.ble.calls).toContain('read:U1:0004');

  const stale = rig({ platform: 'ios' });
  stale.ble.setState('on');
  stale.ble.addPeripheral({ id: 'U2', info: info(0xd7), pairable: false });
  const run2 = stale.flow.start();
  await stale.until('scanning');
  stale.ble.advertise({ id: 'U2', rssi: -40, advertising: { serviceUUIDs: [PAIRING_SERVICE] } });
  await stale.until('confirm');
  stale.flow.answer(true);
  await run2;
  expect(stale.flow.phase()).toEqual({ kind: 'failed', reason: 'ios_forget_first' });
  expect(stale.paired).toEqual([]);
});

test('nothing in pairing mode within 15 s: "press its button 5 times"; the old pairing gets its auto-connect back', async () => {
  const previous: PairedDashcam = { dashcamId: 'a4cf12b3c4d5', peripheralId: 'OLD', name: 'DashPal-C4D5', pairedAt: 1 };
  const r = rig({ previous });
  r.t.setTarget({ peripheralId: 'OLD', dashcamId: 'a4cf12b3c4d5' });
  await r.flow.start();
  expect(r.flow.phase().kind).toBe('none_found');
  expect(r.clock.t).toBeGreaterThanOrEqual(15_000);
  expect(r.t.target()).toEqual({ peripheralId: 'OLD', dashcamId: 'a4cf12b3c4d5' });
});

test('a candidate that is not a v1 DashPal is skipped; the auto prompt’s dashcam is tried first', async () => {
  const r = rig({ preferId: 'WEAK' });
  r.ble.addPeripheral({ id: 'BAD', info: info(0xd8, { protoMin: 2, protoMax: 2 }) });
  r.ble.addPeripheral({ id: 'WEAK', info: info(0xd9) });
  const run = r.flow.start();
  await r.until('scanning');
  r.ble.advertise({ id: 'BAD', rssi: -40, advertising: { serviceUUIDs: [PAIRING_SERVICE] } });
  r.ble.advertise({ id: 'WEAK', rssi: -75, advertising: { serviceUUIDs: [PAIRING_SERVICE] } });
  await r.until('confirm');
  expect(r.flow.phase()).toMatchObject({ candidate: { id: 'WEAK' } });
  r.flow.answer(false);
  await run;
  // BAD was connected, refused (protocol), and released.
  expect(r.ble.calls).toContain('disconnect:BAD');
  expect(r.flow.phase().kind).toBe('none_found');
});

test('cancel mid-confirm releases the candidate and ends as cancelled', async () => {
  const r = rig();
  r.ble.addPeripheral({ id: 'C', info: info(0xda) });
  const run = r.flow.start();
  await r.until('scanning');
  r.ble.advertise({ id: 'C', rssi: -50, advertising: { serviceUUIDs: [PAIRING_SERVICE] } });
  await r.until('confirm');
  await r.flow.cancel();
  await run;
  await flush();
  expect(r.flow.phase().kind).toBe('cancelled');
  expect(r.ble.calls).toContain('disconnect:C');
  expect(r.paired).toEqual([]);
});

// ——— the setup claim (only the phone that made the dashcam beep can pair) ———

const ATT_REFUSED = { domain: 'CBATTErrorDomain', code: 0x80, message: 'refused' };
const identifies = (r: Rig, id: string) => r.ble.calls.filter((c) => c === `write:${id}:0003`).length;
const infoReads = (r: Rig, id: string) => r.ble.calls.filter((c) => c === `read:${id}:0002`).length;

/** Start the flow and advertise these dashcams (strongest first); `run` is the flow's end. */
async function startWith(r: Rig, ids: string[]): Promise<{ run: Promise<void> }> {
  const run = r.flow.start();
  await r.until('scanning');
  ids.forEach((id, i) => r.ble.advertise({ id, rssi: -40 - i * 5, advertising: { serviceUUIDs: [PAIRING_SERVICE] } }));
  return { run };
}

test('INFO says another phone is setting the dashcam up: no IDENTIFY (it would not beep); INFO re-read every 2 s for 8 s; then "another phone is setting up", released', async () => {
  const previous: PairedDashcam = { dashcamId: 'a4cf12b3c4d5', peripheralId: 'OLD', name: 'DashPal-C4D5', pairedAt: 1 };
  const r = rig({ previous });
  r.t.setTarget({ peripheralId: 'OLD', dashcamId: 'a4cf12b3c4d5' });
  r.ble.addPeripheral({ id: 'B', info: info(0xe1, { setupBusy: true }) });
  await (await startWith(r, ['B'])).run;
  expect(r.flow.phase()).toEqual({ kind: 'failed', reason: 'setup_busy' });
  expect(identifies(r, 'B')).toBe(0);
  expect(r.sleeps.filter((ms) => ms === BUSY_POLL_MS)).toHaveLength(BUSY_RETRY_MS / BUSY_POLL_MS);
  expect(infoReads(r, 'B')).toBe(1 + BUSY_RETRY_MS / BUSY_POLL_MS);
  expect(r.ble.calls.lastIndexOf('disconnect:B')).toBeGreaterThan(r.ble.calls.lastIndexOf('read:B:0002'));
  expect(r.phases).not.toContain('confirm');
  // The old pairing gets its auto-connect back.
  expect(r.t.target()).toEqual({ peripheralId: 'OLD', dashcamId: 'a4cf12b3c4d5' });
});

test("the claim clears within the 8 s (this phone's own earlier setup link went): identify, then the question", async () => {
  const r = rig();
  let reads = 0;
  r.ble.addPeripheral({
    id: 'B',
    get info() {
      reads += 1;
      return info(0xe2, { setupBusy: reads < 3 });
    },
  } as never);
  const { run } = await startWith(r, ['B']);
  await r.until('confirm');
  expect(identifies(r, 'B')).toBe(1);
  expect(r.sleeps.filter((ms) => ms === BUSY_POLL_MS)).toHaveLength(2);
  r.flow.answer(true);
  await run;
  expect(r.flow.phase()).toMatchObject({ kind: 'done' });
});

test('IDENTIFY refused (ATT 0x80) and INFO then says busy: watched every 2 s for 8 s, then "another phone is setting up"', async () => {
  const r = rig();
  let reads = 0;
  r.ble.addPeripheral({
    id: 'B',
    get info() {
      reads += 1;
      return info(0xe3, { setupBusy: reads > 1 });
    },
  } as never);
  r.ble.failNext('write', ATT_REFUSED);
  await (await startWith(r, ['B'])).run;
  expect(r.flow.phase()).toEqual({ kind: 'failed', reason: 'setup_busy' });
  expect(identifies(r, 'B')).toBe(1);
  expect(r.sleeps.filter((ms) => ms === BUSY_POLL_MS)).toHaveLength(BUSY_RETRY_MS / BUSY_POLL_MS);
});

test('IDENTIFY refused and INFO not busy (the window closed): the next candidate, as before; none left → none found', async () => {
  const r = rig();
  r.ble.addPeripheral({ id: 'B', info: info(0xe4) });
  r.ble.failNext('write', ATT_REFUSED);
  await (await startWith(r, ['B'])).run;
  expect(r.flow.phase()).toEqual({ kind: 'none_found' });
  expect(r.sleeps.filter((ms) => ms === BUSY_POLL_MS)).toEqual([]);
  expect(r.ble.calls).toContain('disconnect:B');
});

test('a busy dashcam and a free one: the free one is set up; "No" to it leaves only the busy one → "another phone is setting up"', async () => {
  const r = rig();
  r.ble.addPeripheral({ id: 'BUSY', info: info(0xe5, { setupBusy: true }) });
  r.ble.addPeripheral({ id: 'FREE', info: info(0xe6) });
  const { run } = await startWith(r, ['BUSY', 'FREE']);
  await r.until('confirm');
  expect(r.flow.phase()).toMatchObject({ candidate: { id: 'FREE' } });
  expect(identifies(r, 'BUSY')).toBe(0);
  r.flow.answer(false);
  await run;
  expect(r.flow.phase()).toEqual({ kind: 'failed', reason: 'setup_busy' });
});

test('no answer within 110 s: the dashcam is released (its claim ends with the link) and setup fails', async () => {
  const r = rig();
  r.ble.addPeripheral({ id: 'Q', info: info(0xe7) });
  const { run } = await startWith(r, ['Q']);
  await r.until('confirm');
  expect(r.sleeps).toContain(CONFIRM_TIMEOUT_MS);
  r.expireConfirm();
  await run;
  expect(r.flow.phase()).toEqual({ kind: 'failed', reason: 'error' });
  expect(r.ble.calls.at(-1)).toBe('disconnect:Q');
  expect(r.ble.calls.some((c) => c.startsWith('createBond') || c === 'read:Q:0004')).toBe(false);
  // A late answer changes nothing.
  r.flow.answer(true);
  await flush();
  expect(r.flow.phase()).toEqual({ kind: 'failed', reason: 'error' });
});

test('an answer before the 110 s: the timeout firing later changes nothing', async () => {
  const r = rig();
  r.ble.addPeripheral({ id: 'Q', info: info(0xe8) });
  const { run } = await startWith(r, ['Q']);
  await r.until('confirm');
  r.flow.answer(true);
  await run;
  expect(r.flow.phase()).toMatchObject({ kind: 'done' });
  r.expireConfirm();
  await flush();
  expect(r.flow.phase()).toMatchObject({ kind: 'done' });
});

test.each([
  ['a new phone, 1 phone paired before, PAIRED 2', { bondCount: 1 }, 2, false],
  ['a new phone, 1 phone paired before, PAIRED 3 (someone else paired too)', { bondCount: 1 }, 3, true],
  ['the first phone, PAIRED 1', { bondCount: 0 }, 1, false],
  ['a re-pair (the dashcam held this phone), 2 before, PAIRED 2', { bondCount: 2, peerBonded: true }, 2, false],
  ['a re-pair, 2 before, PAIRED 3', { bondCount: 2, peerBonded: true }, 3, true],
  ['the store full: the oldest replaced, PAIRED 4', { bondCount: 4 }, 4, false],
  ['PAIRED did not come', { bondCount: 1 }, null, false],
] as const)('the bond count after pairing: %s', async (_d, over, pairedCount, unexpected) => {
  const r = rig({ pairedCount });
  r.ble.addPeripheral({ id: 'N', info: info(0xe9, over) });
  const { run } = await startWith(r, ['N']);
  await r.until('confirm');
  r.flow.answer(true);
  await run;
  expect(r.flow.phase()).toMatchObject({ kind: 'done', phones: pairedCount, unexpected });
});

test.each(['ios', 'android'] as const)('the setup link dropped before "Yes" (%s): reconnect, identify again, then bond on that connection', async (platform) => {
  const r = rig({ platform });
  if (platform === 'ios') r.ble.setState('on');
  r.ble.addPeripheral({ id: 'D', info: info(0xea) });
  const { run } = await startWith(r, ['D']);
  await r.until('confirm');
  r.ble.drop('D');
  const mark = r.ble.calls.length;
  r.flow.answer(true);
  await run;
  expect(r.flow.phase()).toMatchObject({ kind: 'done' });
  expect(identifies(r, 'D')).toBe(2);
  const after = r.ble.calls.slice(mark).filter((c) => c === 'connect:D' || /^(read|write):D:000[234]$/.test(c) || c === 'createBond:D');
  expect(after.slice(0, 4)).toEqual(['connect:D', 'read:D:0002', 'write:D:0003', platform === 'ios' ? 'read:D:0004' : 'createBond:D']);
});

test('the setup link dropped before "Yes" and another phone took the claim meanwhile: "another phone is setting up", no bond', async () => {
  const r = rig();
  let busy = false;
  r.ble.addPeripheral({
    id: 'D',
    get info() {
      return info(0xeb, { setupBusy: busy });
    },
  } as never);
  const { run } = await startWith(r, ['D']);
  await r.until('confirm');
  r.ble.drop('D');
  busy = true;
  r.flow.answer(true);
  await run;
  expect(r.flow.phase()).toEqual({ kind: 'failed', reason: 'setup_busy' });
  expect(r.ble.calls.some((c) => c.startsWith('createBond'))).toBe(false);
  expect(r.ble.calls.at(-1)).toBe('disconnect:D');
});

test('cancel while waiting for a busy dashcam: cancelled, released, no IDENTIFY', async () => {
  const r = rig();
  r.ble.addPeripheral({ id: 'B', info: info(0xec, { setupBusy: true }) });
  const { run } = await startWith(r, ['B']);
  for (let i = 0; i < 400 && !r.sleeps.includes(BUSY_POLL_MS); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  await r.flow.cancel();
  await run;
  await flush();
  expect(r.flow.phase().kind).toBe('cancelled');
  expect(identifies(r, 'B')).toBe(0);
  expect(r.ble.calls).toContain('disconnect:B');
});
