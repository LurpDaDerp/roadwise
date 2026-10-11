/** @jest-environment node */
// Pairing, refusal and forgetting end to end (plan §3.1, §7.9; §10 rows 18, 19, 21, 42): the app's
// setup flow and runtime against the firmware's pairing window, authorization timers and bond
// handling (simulator). INFO, IDENTIFY and the bond store come from the bench's ble_gatt.c model.
import type { SetupFlow, SetupPhase } from '../setup';
import { describeSim } from './suite';
import { linkedA, scenario, type Phone, type World } from './world';

const BOOT = '5eed0001';

async function setupTo(w: World, flow: SetupFlow, kinds: SetupPhase['kind'][], maxMs = 30_000): Promise<SetupPhase> {
  await w.until(() => kinds.includes(flow.phase().kind), maxMs, `setup ${kinds.join('/')}`);
  return flow.phase();
}

/** Run the app's setup flow up to "Is your DashPal beeping?", answer, and run it to its end. */
async function pair(w: World, p: Phone, yes = true): Promise<{ flow: SetupFlow; confirmAt: number; end: SetupPhase }> {
  const flow = p.setup();
  void flow.start();
  const ph = await setupTo(w, flow, ['confirm', 'none_found', 'failed']);
  if (ph.kind !== 'confirm') return { flow, confirmAt: -1, end: ph };
  const confirmAt = w.W;
  flow.answer(yes);
  const end = await setupTo(w, flow, ['done', 'failed', 'none_found', 'cancelled']);
  return { flow, confirmAt, end };
}

describeSim('DashPal pairing (firmware simulator ↔ app setup flow)', () => {
  test.each(['ios', 'android'] as const)('first pairing inside the zero-bond window (%s): identify beeps, the new bond chimes once on the dashcam, PAIRED, then the app connects and syncs', (platform) =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      expect(w.lines('WINDOW 1')).toHaveLength(1); // zero bonds: open from boot
      const p = await w.addPhone({ name: 'P', conn: 1, platform });
      const flow = p.setup();
      void flow.start();
      const confirm = await setupTo(w, flow, ['confirm']);
      expect(confirm).toMatchObject({ kind: 'confirm', info: { dashcamId: 'a4cf12b3c4d5', name: 'DashPal-C4D5', peerBonded: false, pairingOpen: true } });
      // The candidate connected unbonded; IDENTIFY was accepted (window open); the dashcam sent it nothing.
      expect(w.log.filter((l) => l.dir === 'in' && l.line.startsWith('C 1'))).toEqual([expect.objectContaining({ line: 'C 1 0 0' })]);
      expect(w.gatt).toEqual([{ at: expect.any(Number), phone: 'P', what: 'identify' }]);
      expect(w.tx(1)).toEqual([]);

      const yesAt = w.W;
      flow.answer(true);
      const done = await setupTo(w, flow, ['done', 'failed']);
      expect(done).toMatchObject({ kind: 'done', paired: { dashcamId: 'a4cf12b3c4d5', peripheralId: p.peripheralId } });
      // The dashcam: the paired chime exactly once (COMMAND 5 right after the bond plays no second one),
      // HELLO + STATUS on COMMAND 7, PAIRED with one bond; no termination.
      expect(w.buzzer(yesAt)).toEqual([{ at: expect.any(Number), line: 'PLAY once 6' }]);
      expect(w.txOf('PAIRED', 1).map((x) => x.f.bondCount)).toEqual([1]);
      expect(w.rxOf('COMMAND', 1, yesAt).map((x) => x.f.op).slice(0, 2)).toEqual([7, 5]);
      expect(w.lines('TERM')).toEqual([]);
      expect(w.bonds.has('P')).toBe(true);

      // The setup link is released; the auto-connect takes the bonded dashcam and syncs.
      await w.connected(p);
      const link = p.rt.state().link;
      expect(link).toMatchObject({ lifecycle: 'connected', synced: true, paired: { dashcamId: 'a4cf12b3c4d5' }, firmware: 'dms-core 3.3' });
      expect(w.log.filter((l) => l.dir === 'in' && l.line.startsWith('C 1')).map((l) => l.line)).toEqual(['C 1 0 0', 'C 1 1 1']);
      // "Play test sound" and identify from the paired phone reach the buzzer.
      const t = w.W;
      await p.rt.command(6, 3);
      await p.rt.command(1);
      await w.settle();
      expect(w.buzzer(t)).toEqual([
        { at: t, line: 'PLAY once 3' },
        { at: t, line: 'PLAY once 7' },
      ]);
      expect(p.errors).toEqual([]);
    })
  );

  test('row 19: with the window closed, setup finds no DashPal in pairing mode and touches nothing', () =>
    scenario({ bootId: BOOT, bonded: ['X'] }, async (w) => {
      expect(w.lines('WINDOW')).toEqual([]);
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const { end } = await pair(w, p);
      expect(end).toEqual({ kind: 'none_found' });
      expect(w.log.filter((l) => l.dir === 'in' && /^(C|RX|BOND) /.test(l.line))).toEqual([]);
      expect(w.buzzer()).toEqual([]);
    }));

  test('row 19: a bond made after the window closed is deleted and the link ended; no chime, setup fails, nothing saved', () =>
    scenario({ bootId: BOOT, bonded: ['X'] }, async (w) => {
      await w.dashcam('PAIRWIN 1');
      expect(w.windowOpen).toBe(true);
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const flow = p.setup();
      void flow.start();
      await setupTo(w, flow, ['confirm']);
      expect(w.gatt.map((g) => g.what)).toEqual(['identify']);
      await w.dashcam('PAIRWIN 0');
      expect(w.windowOpen).toBe(false);
      flow.answer(true);
      const end = await setupTo(w, flow, ['done', 'failed']);
      expect(end).toEqual({ kind: 'failed', reason: 'error' });
      expect(w.lines('TERM 1').map((l) => l.line)).toEqual(['TERM 1 unpair']);
      expect(w.buzzer().filter((b) => b.line === 'PLAY once 6')).toEqual([]);
      expect(w.tx(1)).toEqual([]);
      expect(w.bonds.has('P')).toBe(false);
      expect(p.rt.state().link.paired).toBeNull();
    }));

  test('row 18: an encrypted-but-unbonded phone is disconnected at once, an unbonded one after 2 s; neither gets a frame or the lease; inside the window an unbonded link gets 30 s to bond', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      const STATE = '8101051e00009c04' + 'b979379e' + '00000000';
      await w.dashcam('C 5 0 0', 'C 6 0 1', 'RX 5 86010700', 'RX 6 86010700', `RX 5 ${STATE}`, `RX 6 ${STATE}`, 'SND 1 2 0');
      // The legitimate phone A got the alert routed; the strangers got nothing at all.
      expect(w.txOf('ALERT', 1, t0).map((x) => x.f.route)).toEqual([1]);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      // Encrypted but not bonded: refused as soon as the security result says so. Unbonded: 2 s.
      expect(w.lines('TERM', t0).map((l) => [l.at - t0, l.line])).toEqual([[0, 'TERM 6 auth']]);
      await w.runTo(t0 + 1990);
      expect(w.lines('TERM 5', t0)).toEqual([]);
      await w.runTo(t0 + 2010);
      expect(w.lines('TERM 5', t0).map((l) => [l.at - t0, l.line])).toEqual([[2000, 'TERM 5 auth']]);
      expect(w.tx(5)).toEqual([]);
      expect(w.tx(6)).toEqual([]);
      expect(a.rt.state().link.lifecycle).toBe('connected');

      await w.dashcam('SNDOFF', 'PAIRWIN 1');
      const t1 = w.W;
      await w.dashcam('C 7 0 0');
      await w.runTo(t1 + 29_990);
      expect(w.lines('TERM 7', t1)).toEqual([]);
      await w.runTo(t1 + 30_010);
      expect(w.lines('TERM 7', t1).map((l) => [l.at - t1, l.line])).toEqual([[30_000, 'TERM 7 auth']]);
      expect(w.tx(7)).toEqual([]);
    }));

  test('row 19: "Add another phone" (COMMAND 3) opens the window; a second phone pairs and both stay linked', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await a.rt.command(3);
      await w.settle();
      expect(w.lines('WINDOW', t0).map((l) => l.line)).toEqual(['WINDOW 1']);
      const b = await w.addPhone({ name: 'B', conn: 2, platform: 'android' });
      const { end } = await pair(w, b);
      expect(end).toMatchObject({ kind: 'done' });
      expect(w.buzzer(t0)).toEqual([{ at: expect.any(Number), line: 'PLAY once 6' }]);
      expect(w.txOf('PAIRED', 2).map((x) => x.f.bondCount)).toEqual([2]);
      await w.connected(b);
      expect(a.rt.state().link.lifecycle).toBe('connected');
      expect(b.rt.state().link.lifecycle).toBe('connected');
      await w.advance(2500);
      expect(b.rt.state().link.status?.bondCount).toBe(2);
    }));

  test('row 42: Forget DashPal: COMMAND 4, the dashcam deletes the bond and ends the link; the app is unpaired and never reconnects', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      const mark = w.log.length;
      await a.rt.forget();
      await w.settle();
      expect(w.rxOf('COMMAND', 1, t0).map((x) => x.f.op)).toEqual([4]);
      expect(w.lines('TERM', t0).map((l) => l.line)).toEqual(['TERM 1 forget']);
      expect(w.bonds.has('A')).toBe(false);
      expect(a.rt.state().link).toMatchObject({ lifecycle: 'unpaired', paired: null });
      await w.advance(60_000);
      expect(w.log.slice(mark).filter((l) => l.dir === 'in' && /^(C|D|RX) 1/.test(l.line)).map((l) => l.line)).toEqual(['RX 1 86010400', 'D 1']);
      expect(w.tx(1, t0 + 1)).toEqual([]);
    }));

  test('row 21: the dashcam lost this phone\'s bond (unpaired, reflashed): INFO peer_bonded 0 → needs pairing again, the phone disconnects, never touches TX/RX and does not loop', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      w.bonds.delete('A'); // the bond store is gone (e.g. a merged-image flash erased NVS)
      const calls = a.ble.calls.length;
      await w.reboot({ bootId: '5eed0002', gapMs: 5000 });
      expect(w.lines('WINDOW', w.bootAt).map((l) => l.line)).toEqual(['WINDOW 1']); // zero bonds now: the window opens
      const t0 = w.W;
      await w.until(() => a.rt.state().link.lifecycle === 'needs_repair', 5000, 'needs_repair');
      expect(a.rt.state().link.repairCause).toBe('peer_not_bonded');
      await w.advance(60_000);
      const mine = w.log.filter((l) => l.at >= t0 && l.dir === 'in' && /^(C|D|RX|BOND) 1/.test(l.line)).map((l) => l.line);
      expect(mine).toEqual(['C 1 0 0', 'D 1']);
      // One connect, INFO read (open), then disconnect: no TX read, no subscription, no RX write
      // (any of which would raise the OS pairing dialog), and no reconnect loop.
      const id = a.peripheralId;
      expect(a.ble.calls.slice(calls)).toEqual([`connect:${id}`, `retrieveServices:${id}`, `read:${id}:0002`, `disconnect:${id}`]);
      expect(w.tx(1, t0)).toEqual([]);
    }));
});
