/** @jest-environment node */
// Pairing, refusal and forgetting end to end (plan §3.1, §7.9; §10 rows 18, 19, 21, 42): the app's
// setup flow and runtime against the firmware's pairing window, setup claim, authorization timers and
// bond handling (simulator; IDENTIFY goes to it as `ID`). INFO and the bond store come from the
// bench's ble_gatt.c model.
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
      // The candidate connected unbonded; IDENTIFY was accepted (window open): it beeped and this link
      // holds the setup claim; the dashcam sent it nothing.
      expect(w.log.filter((l) => l.dir === 'in' && l.line.startsWith('C 1'))).toEqual([expect.objectContaining({ line: 'C 1 0 0' })]);
      expect(w.gatt).toEqual([{ at: expect.any(Number), phone: 'P', what: 'identify' }]);
      expect(w.out().map((l) => l.line).filter((l) => /^(ID|CLAIM|PLAY) /.test(l))).toEqual(['PLAY once 7', 'ID 1 ok', 'CLAIM 1']);
      expect(w.tx(1)).toEqual([]);

      const yes = w.mark();
      const yesAt = w.W;
      flow.answer(true);
      const done = await setupTo(w, flow, ['done', 'failed']);
      expect(done).toMatchObject({ kind: 'done', paired: { dashcamId: 'a4cf12b3c4d5', peripheralId: p.peripheralId }, phones: 1, unexpected: false });
      // The dashcam: the paired chime exactly once (COMMAND 5 right after the bond plays no second one),
      // the window closed by the bond and the claim used up, HELLO + STATUS on COMMAND 7, PAIRED with
      // one bond; no termination.
      expect(w.buzzer(yes)).toEqual([{ at: expect.any(Number), line: 'PLAY once 6' }]);
      expect(w.out(yes).map((l) => l.line).filter((l) => /^(PLAY|WINDOW|CLAIM) /.test(l))).toEqual(['PLAY once 6', 'WINDOW 0', 'CLAIM -']);
      expect(w.windowOpen).toBe(false);
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

  test('row 19: a bond made after the window closed (which ends the setup claim) is deleted and the link ended; no chime, setup fails, nothing saved', () =>
    scenario({ bootId: BOOT, bonded: ['X'] }, async (w) => {
      await w.dashcam('PAIRWIN 1');
      expect(w.windowOpen).toBe(true);
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const flow = p.setup();
      void flow.start();
      await setupTo(w, flow, ['confirm']);
      expect(w.gatt.map((g) => g.what)).toEqual(['identify']);
      expect(w.claimConn).toBe(1);
      await w.dashcam('PAIRWIN 0');
      expect(w.windowOpen).toBe(false);
      expect(w.claimConn).toBeNull();
      flow.answer(true);
      const end = await setupTo(w, flow, ['done', 'failed']);
      expect(end).toEqual({ kind: 'failed', reason: 'error' });
      expect(w.lines('TERM 1').map((l) => l.line)).toEqual(['TERM 1 unpair']);
      expect(w.buzzer().filter((b) => b.line === 'PLAY once 6')).toEqual([]);
      expect(w.tx(1)).toEqual([]);
      expect(w.bonds.has('P')).toBe(false);
      expect(p.rt.state().link.paired).toBeNull();
    }));

  test('row 18: with both link slots taken (BLE_LINK_MAX_LINKS 2) a third phone is disconnected at once; an unbonded or encrypted-but-unbonded link with a free slot ends at the 2 s check; none gets a frame or the lease; inside the window an unbonded link gets 30 s to identify', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      const STATE = '8101051e00009c04' + 'b979379e' + '00000000';
      // A holds slot 1, unbonded conn 5 takes slot 2; conn 6 (encrypted, not bonded) finds no free slot.
      await w.dashcam('C 5 0 0', 'C 6 0 1', 'RX 5 86010700', 'RX 6 86010700', `RX 5 ${STATE}`, `RX 6 ${STATE}`, 'SND 1 2 0');
      // The legitimate phone A got the alert routed; the strangers got nothing at all.
      expect(w.txOf('ALERT', 1, t0).map((x) => x.f.route)).toEqual([1]);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      // The full link table ends conn 6 on connect (encryption plays no part); conn 5 waits for the 2 s check.
      expect(w.lines('TERM', t0).map((l) => [l.at - t0, l.line])).toEqual([[0, 'TERM 6 auth']]);
      await w.runTo(t0 + 1990);
      expect(w.lines('TERM 5', t0)).toEqual([]);
      await w.runTo(t0 + 2010);
      expect(w.lines('TERM 5', t0).map((l) => [l.at - t0, l.line])).toEqual([[2000, 'TERM 5 auth']]);
      expect(w.tx(5)).toEqual([]);
      expect(w.tx(6)).toEqual([]);
      expect(a.rt.state().link.lifecycle).toBe('connected');

      // Slot 2 is free again: an encrypted-but-unbonded phone keeps it until the same 2 s check.
      const t2 = w.W;
      await w.dashcam('C 8 0 1', 'RX 8 86010700', `RX 8 ${STATE}`);
      await w.runTo(t2 + 1990);
      expect(w.lines('TERM 8', t2)).toEqual([]);
      await w.runTo(t2 + 2010);
      expect(w.lines('TERM 8', t2).map((l) => [l.at - t2, l.line])).toEqual([[2000, 'TERM 8 auth']]);
      expect(w.tx(8)).toEqual([]);
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

  test('row 19: "Add another phone" (COMMAND 3) opens the window for one phone: a second phone pairs, the window closes at its bond, both stay linked and both see 2 phones paired; a third phone then finds none', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await a.rt.command(3);
      await w.settle();
      expect(w.lines('WINDOW', t0).map((l) => l.line)).toEqual(['WINDOW 1']);
      const b = await w.addPhone({ name: 'B', conn: 2, platform: 'android' });
      const { end } = await pair(w, b);
      expect(end).toMatchObject({ kind: 'done', phones: 2, unexpected: false });
      expect(w.buzzer(t0).filter((x) => x.line === 'PLAY once 6')).toEqual([{ at: expect.any(Number), line: 'PLAY once 6' }]);
      // The window closed right at B's bond (BOND 2 → PLAY once 6, WINDOW 0, CLAIM -).
      const afterBond = w.log.slice(w.log.findIndex((l) => l.dir === 'in' && l.line === 'BOND 2'));
      expect(afterBond.filter((l) => l.dir === 'out').slice(0, 3).map((l) => l.line)).toEqual(['PLAY once 6', 'WINDOW 0', 'CLAIM -']);
      expect(w.txOf('PAIRED', 2).map((x) => x.f.bondCount)).toEqual([2]);
      await w.connected(b);
      expect(a.rt.state().link.lifecycle).toBe('connected');
      expect(b.rt.state().link.lifecycle).toBe('connected');
      await w.advance(2500);
      // Settings › DashPal shows "Phones paired: 2" from STATUS on both phones.
      expect(b.rt.state().link.status?.bondCount).toBe(2);
      expect(a.rt.state().link.status?.bondCount).toBe(2);
      // One window, one phone: a third phone finds no DashPal in pairing mode.
      const c = await w.addPhone({ name: 'C', conn: 3 });
      const third = await pair(w, c);
      expect(third.end).toEqual({ kind: 'none_found' });
      expect(w.log.filter((l) => l.dir === 'in' && /^(C|ID|BOND) 3/.test(l.line))).toEqual([]);
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

  // ——— the setup claim: only the phone that made the dashcam beep can pair, one phone per window ———

  test('a stranger cannot make the dashcam beep or bond while the owner is on the question; the owner then pairs (one chime, the window closes)', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const flow = p.setup();
      void flow.start();
      await setupTo(w, flow, ['confirm']);
      expect(w.claimConn).toBe(1);
      const m = w.mark();
      const out = await w.dashcam('C 5 0 0', 'ID 5 1', 'ID 5 0', 'BOND 5');
      expect(out.filter((l) => /^(ID|TERM|PLAY|WINDOW|CLAIM) /.test(l))).toEqual(['ID 5 busy', 'ID 5 busy', 'TERM 5 unpair']);
      expect(w.claimConn).toBe(1);
      expect(w.windowOpen).toBe(true);
      flow.answer(true);
      const done = await setupTo(w, flow, ['done', 'failed']);
      expect(done).toMatchObject({ kind: 'done', phones: 1, unexpected: false });
      expect(w.buzzer(m)).toEqual([{ at: expect.any(Number), line: 'PLAY once 6' }]);
      expect(w.lines('WINDOW', m).map((l) => l.line)).toEqual(['WINDOW 0']);
      expect(w.lines('PLAY once 7')).toHaveLength(1); // only the owner's identify beeped
      expect(w.bonds.has('P')).toBe(true);
    }));

  test('a second phone that starts setup while the owner is on the question: "another phone is setting up", and it never makes the dashcam beep', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const flowP = p.setup();
      void flowP.start();
      await setupTo(w, flowP, ['confirm']);
      const q = await w.addPhone({ name: 'Q', conn: 2, platform: 'android' });
      const t0 = w.W;
      const { end } = await pair(w, q);
      expect(end).toEqual({ kind: 'failed', reason: 'setup_busy' });
      // Q connected, read INFO (flags bit 1) for 8 s without ever writing IDENTIFY, and let go.
      expect(w.log.filter((l) => l.at >= t0 && l.dir === 'in' && /^(C|D|ID|BOND|RX) 2/.test(l.line)).map((l) => l.line)).toEqual(['C 2 0 0', 'D 2']);
      expect(w.lines('PLAY once 7')).toHaveLength(1);
      expect(w.claimConn).toBe(1);
      expect(q.rt.state().link.paired).toBeNull();
      // The owner finishes.
      flowP.answer(true);
      expect(await setupTo(w, flowP, ['done', 'failed'])).toMatchObject({ kind: 'done', phones: 1, unexpected: false });
    }));

  test('a bond without identify is refused even inside the zero-bond window, and the window stays open', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const out = await w.dashcam('C 5 0 0', 'BOND 5');
      expect(out.filter((l) => /^(TERM|PLAY|WINDOW|CLAIM) /.test(l))).toEqual(['TERM 5 unpair']);
      expect(w.windowOpen).toBe(true);
    }));

  test('the first bond closes the zero-bond window: a second phone then finds no DashPal in pairing mode and touches nothing', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1 });
      expect((await pair(w, p)).end).toMatchObject({ kind: 'done' });
      expect(w.windowOpen).toBe(false);
      expect(w.lines('WINDOW').map((l) => l.line)).toEqual(['WINDOW 1', 'WINDOW 0']);
      const q = await w.addPhone({ name: 'Q', conn: 2 });
      expect((await pair(w, q)).end).toEqual({ kind: 'none_found' });
      expect(w.log.filter((l) => l.dir === 'in' && /^(C|ID|BOND) 2/.test(l.line))).toEqual([]);
    }));

  test('a slow "Yes", 100 s after the beep, still pairs: the claim holds the link for 180 s from the identify (no 30 s cut-off)', async () => {
    await scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const flow = p.setup();
      void flow.start();
      await setupTo(w, flow, ['confirm']);
      const identifiedAt = w.lines('ID 1 ok')[0]!.at;
      await w.runTo(identifiedAt + 100_000);
      expect(w.lines('TERM 1')).toEqual([]);
      expect(flow.phase().kind).toBe('confirm');
      flow.answer(true);
      expect(await setupTo(w, flow, ['done', 'failed'])).toMatchObject({ kind: 'done' });
      expect(w.bonds.has('P')).toBe(true);
    });
  }, 180_000);

  test('"Add another phone": the window times out while the other phone is on the question; its "Yes" still pairs (the claim outlives the window)', async () => {
    await scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await a.rt.command(3);
      await w.settle();
      await w.runTo(t0 + 105_000);
      const b = await w.addPhone({ name: 'B', conn: 2, platform: 'android' });
      const flow = b.setup();
      void flow.start();
      await setupTo(w, flow, ['confirm']);
      expect(w.lines('ID 2 ok')[0]!.at - t0).toBeLessThan(120_000);
      await w.runTo(t0 + 130_000);
      // The window timed out at 120 s for everyone else; B still holds the claim and its link.
      expect(w.lines('WINDOW', t0).map((l) => [l.at - t0, l.line])).toEqual([
        [0, 'WINDOW 1'],
        [120_000, 'WINDOW 0'],
      ]);
      expect(w.claimConn).toBe(2);
      expect(w.lines('TERM 2')).toEqual([]);
      flow.answer(true);
      expect(await setupTo(w, flow, ['done', 'failed'])).toMatchObject({ kind: 'done', phones: 2, unexpected: false });
      expect(w.bonds.has('B')).toBe(true);
      expect(a.rt.state().link.lifecycle).toBe('connected');
    });
  }, 180_000);

  test('the setup link drops while the owner is on the question: on "Yes" the phone reconnects, beeps again (a free claim) and pairs', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const flow = p.setup();
      void flow.start();
      await setupTo(w, flow, ['confirm']);
      await w.linkLost(p);
      expect(w.claimConn).toBeNull();
      flow.answer(true);
      expect(await setupTo(w, flow, ['done', 'failed'])).toMatchObject({ kind: 'done', phones: 1 });
      expect(w.log.filter((l) => l.dir === 'in' && /^(C|D|ID|BOND) 1/.test(l.line)).map((l) => l.line).slice(0, 6)).toEqual([
        'C 1 0 0',
        'ID 1 1',
        'D 1',
        'C 1 0 0',
        'ID 1 1',
        'BOND 1',
      ]);
      expect(w.lines('PLAY once 7')).toHaveLength(2);
      expect(w.lines('TERM')).toEqual([]);
    }));

  test('row 21 then setup again on Android with the old OS bond: it is removed before connecting, so identify and the new bond share one connection and the bond is accepted', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w, { platform: 'android' });
      const per = a.ble.peripheral(a.peripheralId)!;
      per.osBonded = true; // the OS kept the bond from the first pairing
      a.ble.addPeripheral(per);
      w.bonds.delete('A'); // the dashcam lost every bond (a merged-image flash, or 10 presses)
      await w.reboot({ bootId: '5eed0002', gapMs: 5000 });
      await w.until(() => a.rt.state().link.lifecycle === 'needs_repair', 5000, 'needs_repair');
      const calls = a.ble.calls.length;
      const since = w.W;
      const { end } = await pair(w, a);
      expect(end).toMatchObject({ kind: 'done', phones: 1, unexpected: false });
      const id = a.peripheralId;
      const steps = a.ble.calls.slice(calls).filter((c) => /Bond|^connect|0003/.test(c));
      expect(steps.slice(0, 5)).toEqual(['getBondedPeripherals', `removeBond:${id}`, `connect:${id}`, `write:${id}:0003`, `createBond:${id}`]);
      expect(w.lines('TERM', since)).toEqual([]);
      expect(w.lines('PLAY once 6', since)).toHaveLength(1);
      await w.connected(a);
      expect(a.rt.state().link).toMatchObject({ lifecycle: 'connected', synced: true });
    }));
});
