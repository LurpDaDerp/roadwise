/** @jest-environment node */
// The re-aim end to end (firmware 3.6, BLE_PROTOCOL §3.5): the firmware's link core and aiming stream
// (simulator) against the app's re-aim flow on the paired link — a paired phone opens the picture
// outside setup (the camera-view sound, VIEW over the paired session, acknowledged), Done stops it
// and the dashcam recalibrates; a drive refuses it and Done recalibrates with COMMAND 2; STATUS bit 7
// (the camera needs re-aiming) reaches the phone.
import { COMMAND } from '../protocol';
import { createReaimFlow, type ReaimFlow } from '../reaim';
import { describeSim } from './suite';
import { linkedA, scenario, type Phone, type World } from './world';

const BOOT = 'c0ffee5a';

function reaimOf(w: World, p: Phone): { flow: ReaimFlow; frames: number[][]; aims: (number | null)[] } {
  const flow = createReaimFlow({
    link: p.rt.link,
    transport: () => p.transport(),
    now: () => w.now(),
    setTimer: (fn, ms) => w.timer(ms, fn, p),
    clearTimer: (h) => w.clearTimer(h),
  });
  const frames: number[][] = [];
  const aims: (number | null)[] = [];
  flow.onViewFrame((j) => void frames.push(Array.from(j)));
  flow.onAim((a) => void aims.push(a ? a.score : null));
  return { flow, frames, aims };
}

describeSim('DashPal re-aim (firmware simulator ↔ the paired link)', () => {
  test('a paired phone opens the picture outside setup: the camera-view sound, images over the paired session, Done stops it and DashPal recalibrates', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const r = reaimOf(w, a);
      void r.flow.start();
      await w.until(() => w.lines('VIEW 1 on reaim').length === 1, 3000, 'the re-aim stream on');
      expect(w.lines('PLAY once 8')).toHaveLength(1);
      expect(w.lines('LED aim 1')).toHaveLength(1);
      await w.dashcam('VIEWF 1500');
      await w.until(() => r.frames.length === 1, 3000, 'the first image');
      await w.until(() => w.rxOf('COMMAND', 1).some((c) => c.f.op === COMMAND.VIEW_ACK && c.f.arg === 1), 2000, 'its acknowledgement');
      await w.until(() => r.flow.phase().status === 'live', 2000, 'live');
      await w.dashcam('AIMF 94 0 7 60 -2 3');
      await w.until(() => r.aims.includes(94), 2000, 'the AIM frame');
      const closing = r.flow.close();
      await w.until(() => w.lines('VIEW 1 off 0').length === 1, 3000, 'the stream stopped');
      await closing;
      expect(w.lines('CMD recalibrate 1')).toHaveLength(1);
      expect(w.rxOf('COMMAND', 1).filter((c) => c.f.op === COMMAND.RECALIBRATE)).toHaveLength(0);
      expect(r.aims.at(-1)).toBeNull();
    }));

  test('refused while the phone records a drive: no picture, and Done recalibrates with COMMAND 2', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w, { recording: true });
      const r = reaimOf(w, a);
      void r.flow.start();
      await w.until(() => r.flow.phase().status === 'refused', 3000, 'refused');
      expect(r.flow.phase().reason).toBe('drive');
      expect(w.lines('VIEW 1 on')).toHaveLength(0);
      const closing = r.flow.close();
      await w.until(() => w.lines('CMD recalibrate 1').length === 1, 3000, 'the recalibration');
      await closing;
      expect(w.rxOf('COMMAND', 1).filter((c) => c.f.op === COMMAND.RECALIBRATE)).toHaveLength(1);
    }));

  test('STATUS bit 7: the camera needs re-aiming reaches the phone, and its clearing too', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      expect(a.rt.state().reaim).toBe(false);
      await w.dashcam('STATE 3 200');
      await w.until(() => a.rt.state().reaim, 3000, 'the re-aim flag');
      await w.dashcam('STATE 3 72');
      await w.until(() => !a.rt.state().reaim, 3000, 'the flag cleared');
    }));
});
