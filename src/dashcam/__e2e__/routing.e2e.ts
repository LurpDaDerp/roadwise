/** @jest-environment node */
// Alert routing end to end (BLE_PROTOCOL §1, §5; plan §10 rows 1-8, 27): the firmware's ble_link
// (simulator) decides buzzer vs phone; the app's link and alert controller answer and play. The
// dashcam sends every alert, tier 1 to 3, to its connected primary phone; the buzzer is only the
// fallback (no answer in time, "cannot", the phone lost or gone quiet). Every test checks both
// sides: what the dashcam sent and its buzzer did, and what the phone acknowledged and played.
import { describeSim } from './suite';
import { linkedA, scenario, type Phone, type World } from './world';

const BOOT = '9e3779b9';
const GLANCE = 1;
const DROWSY = 2;
const WAKE = 3;
const CHIME = 5;
const NO_FACE = 6;

/** Wait for a STATE from the phone, then `ms` more: the STATE's age at the next step is known. */
async function afterState(w: World, a: Phone, ms: number): Promise<number> {
  const n = w.rxOf('STATE', a.conn).length;
  await w.until(() => w.rxOf('STATE', a.conn).length > n, 2000, 'a STATE');
  const at = w.rxOf('STATE', a.conn).at(-1)!.at;
  await w.runTo(at + ms);
  return at;
}

/** When the dashcam last heard anything from the phone, at or before `at`. */
function lastHeard(w: World, conn: number, at: number): number {
  return Math.max(...w.rx(conn).filter((x) => x.at <= at).map((x) => x.at));
}

/** Start-to-start gaps of a list of times. */
const gaps = (xs: number[]): number[] => xs.slice(1).map((x, i) => x - xs[i]!);

describeSim('DashPal alert routing (firmware simulator ↔ app link)', () => {
  test('a glance warning routed to the phone: ALERT_ACK within 750 ms, the buzzer silent for all 10 s (never joined, no FALLBACK); STATUS every 500 ms to the phone; ALERT_STOP ends it', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const alerts = w.txOf('ALERT', 1, t0);
      expect(alerts).toHaveLength(1);
      const alert = alerts[0]!;
      expect(alert.f).toMatchObject({ sound: GLANCE, tier: 2, level: 0, mode: 1, route: 1 });
      const acks = w.rxOf('ALERT_ACK', 1, t0);
      expect(acks.map((x) => x.f)).toEqual([{ type: 'ALERT_ACK', alertId: alert.f.alertId, outcome: 1 }]);
      expect(acks[0]!.at - alert.at).toBeLessThanOrEqual(750);

      await w.runTo(t0 + 10_100);
      expect(w.buzzer(t0)).toEqual([]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
      // The phone sounds it: the DashPal glance tone, the voice on the first play only, repeats 2.5 s start to start.
      const plays = a.player.sounded(t0);
      expect(plays.map((p) => [p.at - t0, p.decision.tone, p.decision.voice !== undefined])).toEqual([
        [0, 'dp_glance', true],
        [2500, 'dp_glance', false],
        [5000, 'dp_glance', false],
        [7500, 'dp_glance', false],
        [10_000, 'dp_glance', false],
      ]);
      expect(a.rt.state().link.visual).toMatchObject({ alertId: alert.f.alertId, sound: GLANCE, onPhone: true });
      expect(a.rt.state().link.held).toMatchObject({ sound: GLANCE, tier: 2, level: 0 });
      // While the alert is routed to it, the phone gets STATUS every 500 ms (a suspended app is woken by it).
      const status = w.txOf('STATUS', 1, t0 + 1).map((x) => x.at);
      expect(status.length).toBeGreaterThanOrEqual(19);
      for (const g of gaps(status)) expect(g).toBeLessThanOrEqual(510);
      expect(w.rxOf('ALERT_ACK', 1, t0)).toHaveLength(1);

      const t1 = w.W;
      await w.dashcam('SNDOFF');
      expect(w.txOf('ALERT_STOP', 1, t1).map((x) => x.f)).toEqual([{ type: 'ALERT_STOP', alertId: alert.f.alertId, reason: 0 }]);
      expect(w.buzzer(t0)).toEqual([]);
      await w.advance(6000);
      expect(a.player.sounded(t1 + 1)).toEqual([]);
      expect(a.player.stops.some((s) => s >= t1)).toBe(true);
      expect(a.rt.state().link.held).toBeNull();
    }));

  test('row 3: the phone never answers (frozen): buzzer at the 750 ms deadline with ALERT_FALLBACK 1; the app, back later, answers ACK(0) and never sounds it', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await afterState(w, a, 200);
      w.suspend(a);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const alert = w.txOf('ALERT', 1, t0)[0]!;
      expect(alert.f.route).toBe(1);
      await w.runTo(t0 + 740);
      expect(w.buzzer(t0)).toEqual([]);
      await w.runTo(t0 + 800);
      expect(w.buzzer(t0)).toEqual([{ at: t0 + 750, line: 'PLAY cont 1 0' }]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0).map((x) => [x.at - t0, x.f.cause])).toEqual([[750, 1]]);

      // The app runs again: the held frames arrive one after the other (ALERT, then FALLBACK 1). The
      // ALERT is past the deadline by the live offset: shown, ACK(0), never sounded on the phone.
      const t1 = w.W;
      await w.resume(a);
      await w.advance(4000);
      expect(w.rxOf('ALERT_ACK', 1, t1).map((x) => x.f.outcome)).toEqual([0]);
      expect(a.player.sounded(t0)).toEqual([]);
      expect(a.rt.state().link.counters.lateAlerts).toBe(1);
      expect(w.buzzer(t1)).toEqual([]); // still playing: no STOP, no re-gate
      expect(w.txOf('ALERT_FALLBACK', 1, t1)).toEqual([]);
    }));

  test('(c) a frozen phone and a critical alert: the buzzer takes it 400 ms after the hand-off (FALLBACK 1); back, the phone shows it only', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await afterState(w, a, 200);
      w.suspend(a);
      const t0 = w.W;
      await w.dashcam('SND 3 3 0');
      expect(w.txOf('ALERT', 1, t0).map((x) => [x.f.tier, x.f.route])).toEqual([[3, 1]]);
      await w.runTo(t0 + 390);
      expect(w.buzzer(t0)).toEqual([]);
      await w.runTo(t0 + 450);
      expect(w.buzzer(t0)).toEqual([{ at: t0 + 400, line: 'PLAY cont 3 0' }]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0).map((x) => [x.at - t0, x.f.cause])).toEqual([[400, 1]]);
      const t1 = w.W;
      await w.resume(a);
      await w.advance(3000);
      expect(w.rxOf('ALERT_ACK', 1, t1).map((x) => x.f.outcome)).toEqual([0]);
      expect(a.player.sounded(t0)).toEqual([]);
      expect(a.player.silent(t0).length).toBeGreaterThanOrEqual(1);
    }));

  test('row 3: an ACK that arrives late (a slow link, 900 ms up): the buzzer at 750 ms with FALLBACK 1; the phone stops when the FALLBACK reaches it; the late ACK is ignored', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await afterState(w, a, 100);
      a.latency.up = 900;
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.txOf('ALERT', 1, t0).map((x) => x.f.route)).toEqual([1]);
      await w.runTo(t0 + 1000);
      expect(w.buzzer(t0)).toEqual([{ at: t0 + 750, line: 'PLAY cont 1 0' }]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0).map((x) => [x.at - t0, x.f.cause])).toEqual([[750, 1]]);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => [x.at - t0, x.f.outcome])).toEqual([[900, 1]]);
      // The phone played from the ALERT until the FALLBACK arrived (750 ms), then stopped.
      expect(a.player.sounded(t0).map((p) => p.at - t0)).toEqual([0]);
      expect(a.player.stops).toContain(t0 + 750);
      await w.advance(4000);
      expect(a.player.sounded(t0 + 1)).toEqual([]);
      expect(w.buzzer(t0 + 751)).toEqual([]); // the late ACK did not silence the buzzer
    }));

  test('row 3/4: ACK(0) when the phone cannot play (an iOS call): FALLBACK 2 and the buzzer at once; the next STATE drops can_play, so the next alert is never routed', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await afterState(w, a, 100);
      a.host.callActive = true;
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const alert = w.txOf('ALERT', 1, t0)[0]!;
      expect(alert.f.route).toBe(1);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([0]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0).map((x) => [x.at - t0, x.f.cause])).toEqual([[0, 2]]);
      expect(w.buzzer(t0)).toEqual([{ at: t0, line: 'PLAY cont 1 0' }]);
      await w.advance(1500);
      expect(a.player.sounded(t0)).toEqual([]);
      expect(a.player.silent(t0).length).toBeGreaterThanOrEqual(1);
      expect(w.rxOf('STATE', 1, t0).at(-1)!.f.flags & 0x01).toBe(0);
      await w.dashcam('SNDOFF');
      const t1 = w.W;
      await w.dashcam('SND 2 2 0');
      expect(w.txOf('ALERT', 1, t1).map((x) => x.f.route)).toEqual([0]);
      expect(w.buzzer(t1)).toContainEqual({ at: t1, line: 'PLAY cont 2 0' });
      expect(w.rxOf('ALERT_ACK', 1, t1)).toEqual([]);
    }));

  test('(d) a media volume under a quarter, or headphones as the output: STATE can_play 0, so the buzzer plays at once and the ALERT goes out route 0', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      for (const set of [() => (a.audio.volume = 0.2), () => ((a.audio.volume = 0.8), (a.audio.headphones = true))]) {
        set();
        const s0 = w.W + 1;
        await w.until(() => w.rxOf('STATE', 1, s0).some((x) => (x.f.flags & 0x01) === 0), 3000, 'a STATE without can_play');
        const t0 = w.W;
        await w.dashcam('SND 1 2 0');
        expect(w.txOf('ALERT', 1, t0).map((x) => x.f.route)).toEqual([0]);
        expect(w.buzzer(t0)).toEqual([{ at: t0, line: 'PLAY cont 1 0' }]);
        await w.advance(2000);
        expect(w.rxOf('ALERT_ACK', 1, t0)).toEqual([]);
        expect(a.player.sounded(t0)).toEqual([]);
        await w.dashcam('SNDOFF');
        await w.advance(500);
      }
    }));

  test('(e) a call (the audio probe) during a confirmed alert: ALERT_ACK(0) on the next tick, FALLBACK 2, and the buzzer carries on in phase', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(1200);
      const t1 = w.W;
      a.audio.callActive = true;
      await w.advance(1600);
      const acks = w.rxOf('ALERT_ACK', 1, t1);
      expect(acks.map((x) => x.f.outcome)).toEqual([0]);
      expect(acks[0]!.at - t1).toBeLessThanOrEqual(1100);
      const fb = w.txOf('ALERT_FALLBACK', 1, t1);
      expect(fb.map((x) => x.f.cause)).toEqual([2]);
      expect(w.buzzer(t1)).toEqual([{ at: fb[0]!.at, line: 'PLAY cont 1 0' }]);
      await w.advance(3000);
      expect(a.player.sounded(fb[0]!.at + 1)).toEqual([]);
    }));

  test('row 3: ACK(0) after ACK(1) (the player fails mid-alert): FALLBACK 2, the buzzer takes over, the phone stops; for 30 s the next alert is answered "cannot" at once', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 2 2 0');
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(100);
      expect(a.player.sounded(t0).map((p) => p.decision.tone)).toEqual(['dp_drowsy']);
      a.rt.playerUnavailable(); // the tone would not play
      await w.settle();
      const t1 = w.W;
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1, 0]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0).map((x) => [x.at - t1, x.f.cause])).toEqual([[0, 2]]);
      expect(w.buzzer(t0)).toEqual([{ at: t1, line: 'PLAY cont 2 0' }]);
      await w.advance(9000);
      expect(a.player.sounded(t1 + 1)).toEqual([]);
      // A new episode 10 s later: the phone's STATE says it cannot play yet, so the buzzer plays it.
      await w.dashcam('SNDOFF');
      await w.advance(1000);
      const t2 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.txOf('ALERT', 1, t2).map((x) => x.f.route)).toEqual([0]);
      expect(w.buzzer(t2)).toEqual([{ at: t2, line: 'PLAY cont 1 0' }]);
      await w.dashcam('SNDOFF');
      // After 30 s the phone can play again.
      await w.runTo(t1 + 31_000);
      const t3 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.txOf('ALERT', 1, t3).map((x) => x.f.route)).toEqual([1]);
      expect(w.rxOf('ALERT_ACK', 1, t3).map((x) => x.f.outcome)).toEqual([1]);
      expect(w.buzzer(t3)).toEqual([]);
    }));

  test('rows 1 and 8: the phone goes quiet mid-episode (frozen): FALLBACK 3 just over 3 s after its last frame (the quiet guard); the episode stays on the buzzer after the phone is back, even across a supersede', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const first = w.txOf('ALERT', 1, t0)[0]!;
      expect(first.f.route).toBe(1);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(700);
      w.suspend(a); // nothing from the phone from here
      const last = lastHeard(w, 1, w.W);
      await w.runTo(last + 3000);
      expect(w.buzzer(t0)).toEqual([]);
      await w.runTo(last + 3100);
      const fb = w.txOf('ALERT_FALLBACK', 1, t0);
      expect(fb.map((x) => x.f.cause)).toEqual([3]);
      expect(fb[0]!.at - last).toBeGreaterThan(3000);
      expect(fb[0]!.at - last).toBeLessThanOrEqual(3010);
      expect(w.buzzer(t0)).toEqual([{ at: fb[0]!.at, line: 'PLAY cont 1 0' }]);

      // The phone comes back: the held FALLBACK stops it; its STATEs flow again.
      await w.runTo(t0 + 6000);
      const back = w.W;
      await w.resume(a);
      await w.until(() => w.rxOf('STATE', 1, back).length > 0, 2000, 'STATE after resume');
      await w.advance(1000);
      // The frames held meanwhile arrive in one burst: a repeat that came due while it was frozen may be
      // handed to the player by the first of them, and is cut by the FALLBACK right behind it.
      expect(a.player.sounded(back + 1)).toEqual([]);
      if (a.player.sounded(back).length > 0) expect(a.player.stops).toContain(back);
      // A supersede in the same episode (drowsy replaces glance): a new alert id, never routed again.
      const t1 = w.W;
      await w.dashcam('SND 2 2 0');
      expect(w.txOf('ALERT_STOP', 1, t1).map((x) => [x.f.alertId, x.f.reason])).toEqual([[first.f.alertId, 1]]);
      const second = w.txOf('ALERT', 1, t1);
      expect(second.map((x) => [x.f.sound, x.f.route])).toEqual([[DROWSY, 0]]);
      expect(second[0]!.f.alertId).not.toBe(first.f.alertId);
      expect(w.buzzer(t1)).toEqual([{ at: t1, line: 'PLAY cont 2 0' }]);
      expect(w.rxOf('ALERT_ACK', 1, t1)).toEqual([]);
      await w.advance(5000);
      expect(a.player.sounded(t1)).toEqual([]);
      expect(a.player.silent(t1).length).toBeGreaterThanOrEqual(1);
      expect(w.buzzer(t1 + 1)).toEqual([]); // still on the buzzer, no STOP
    }));

  test('the phone goes quiet during a critical: FALLBACK 3 just over 1.5 s after its last frame; while it played, its STATEs came at least every 450 ms', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 3 3 0');
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(4000);
      expect(w.buzzer(t0)).toEqual([]);
      const states = w.rxOf('STATE', 1, t0 + 1).map((x) => x.at);
      expect(states.length).toBeGreaterThanOrEqual(7);
      for (const g of gaps(states)) {
        expect(g).toBeGreaterThanOrEqual(450);
        expect(g).toBeLessThanOrEqual(510);
      }
      w.suspend(a);
      const last = lastHeard(w, 1, w.W);
      await w.runTo(last + 1500);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
      await w.runTo(last + 1600);
      const fb = w.txOf('ALERT_FALLBACK', 1, t0);
      expect(fb.map((x) => x.f.cause)).toEqual([3]);
      expect(fb[0]!.at - last).toBeGreaterThan(1500);
      expect(fb[0]!.at - last).toBeLessThanOrEqual(1510);
      expect(w.buzzer(t0)).toEqual([{ at: fb[0]!.at, line: 'PLAY cont 3 0' }]);
    }));

  test('row 5: a critical is routed like any alert: the buzzer silent while the phone plays it; a level step re-sends the same alert (no new ACK); the phone failing hands it to the buzzer at once', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 3 3 0');
      const alert = w.txOf('ALERT', 1, t0)[0]!;
      expect(alert.f).toMatchObject({ sound: WAKE, tier: 3, level: 0, mode: 1, route: 1 });
      const acks = w.rxOf('ALERT_ACK', 1, t0);
      expect(acks.map((x) => x.f.outcome)).toEqual([1]);
      expect(acks[0]!.at - alert.at).toBeLessThanOrEqual(400);
      await w.advance(2000);
      expect(w.buzzer(t0)).toEqual([]);
      const first = a.player.sounded(t0);
      expect(first[0]).toMatchObject({ at: t0, decision: { tone: 'dp_wake', voiceAlways: true, startWithinMs: 500 } });
      expect(first[0]!.decision.voice).toBeDefined();
      const held = a.rt.state().link.held;
      expect(held).toMatchObject({ sound: WAKE, tier: 3, level: 0 });
      const t1 = w.W;
      await w.dashcam('SND 3 3 2');
      expect(w.txOf('ALERT', 1, t1).map((x) => [x.f.alertId, x.f.level, x.f.route])).toEqual([[alert.f.alertId, 2, 1]]);
      expect(w.buzzer(t1)).toEqual([]);
      expect(a.rt.state().link.held).toEqual({ ...held, level: 2 });
      await w.advance(3000);
      expect(w.rxOf('ALERT_ACK', 1, t0)).toHaveLength(1);
      // The level step speaks again; then wake repeats every 1.0 s start to start.
      const after = a.player.sounded(t1);
      expect(after[0]!.decision.voice).toBeDefined();
      const g = gaps(after.map((p) => p.at));
      expect(g.length).toBeGreaterThanOrEqual(2);
      for (const x of g) expect(x).toBe(1000);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
      expect(w.buzzer(t0)).toEqual([]);
      // The phone's sound fails (a tone that never starts reports the same way): ALERT_ACK(0), and the
      // buzzer plays the critical at once, in phase.
      const t2 = w.W;
      a.rt.playerUnavailable();
      await w.settle();
      expect(w.rxOf('ALERT_ACK', 1, t2).map((x) => x.f.outcome)).toEqual([0]);
      expect(w.txOf('ALERT_FALLBACK', 1, t2).map((x) => [x.at - t2, x.f.cause])).toEqual([[0, 2]]);
      expect(w.buzzer(t2)).toEqual([{ at: t2, line: 'PLAY cont 3 2' }]);
      await w.advance(100);
      const t3 = w.W;
      await w.dashcam('SNDOFF');
      expect(w.buzzer(t3)).toEqual([{ at: t3, line: 'STOP' }]);
      expect(w.txOf('ALERT_STOP', 1, t3).map((x) => x.f.reason)).toEqual([0]);
      await w.advance(3000);
      expect(a.player.sounded(t2 + 1)).toEqual([]);
    }));

  test('row 7: an advisory one-shot is held for the phone: ACKed, the phone chimes and the buzzer never does; unanswered, the buzzer plays it at the deadline', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('ONCE 5');
      const once = w.txOf('ALERT', 1, t0);
      expect(once.map((x) => x.f)).toEqual([expect.objectContaining({ sound: CHIME, tier: 1, mode: 0, route: 1 })]);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(4000);
      expect(w.buzzer(t0)).toEqual([]);
      expect(a.player.sounded(t0).map((p) => [p.decision.level, p.decision.tone])).toEqual([[1, undefined]]);

      await afterState(w, a, 100);
      w.suspend(a);
      const t1 = w.W;
      await w.dashcam('ONCE 5');
      expect(w.txOf('ALERT', 1, t1).map((x) => x.f.route)).toEqual([1]);
      await w.runTo(t1 + 740);
      expect(w.buzzer(t1)).toEqual([]);
      await w.runTo(t1 + 800);
      expect(w.buzzer(t1)).toEqual([{ at: t1 + 750, line: 'PLAY once 5' }]);
      expect(w.txOf('ALERT_FALLBACK', 1, t1).map((x) => x.f.cause)).toEqual([1]);
      // The app runs again after the deadline: the held ALERT is late by the live offset, so it is
      // shown and answered ACK(0) without a chime; the one-shot sounds once, on the buzzer only.
      const back = w.W;
      await w.resume(a);
      await w.advance(1000);
      expect(w.rxOf('ALERT_ACK', 1, back).map((x) => x.f.outcome)).toEqual([0]);
      expect(a.player.sounded(t1)).toEqual([]);
      expect(w.buzzer(back)).toEqual([]);
    }));

  test('row 4: vibration-only style → STATE can_play 0 → no routing: the buzzer at once, ALERT route 0, the phone vibrates and never ACKs', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      a.style.sound = false;
      const s0 = w.W + 1;
      await w.until(() => w.rxOf('STATE', 1, s0).length > 0, 2000);
      expect(w.rxOf('STATE', 1, s0).at(-1)!.f.flags & 0x01).toBe(0);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.buzzer(t0)).toEqual([{ at: t0, line: 'PLAY cont 1 0' }]);
      expect(w.txOf('ALERT', 1, t0).map((x) => x.f.route)).toEqual([0]);
      await w.advance(3000);
      expect(w.rxOf('ALERT_ACK', 1, t0)).toEqual([]);
      expect(a.player.sounded(t0)).toEqual([]);
      expect(a.player.silent(t0).length).toBeGreaterThanOrEqual(1);
      expect(a.rt.state().link.visual).toMatchObject({ sound: GLANCE, onPhone: false });
    }));

  test('"Also beep on DashPal": STATE buzzer_too, so a routed alert, a critical or a one-shot sounds on both from the start', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w, { buzzerToo: true });
      expect(w.rxOf('STATE', 1).at(-1)!.f.flags & 0x02).toBe(0x02);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.txOf('ALERT', 1, t0).map((x) => x.f.route)).toEqual([1]);
      expect(w.buzzer(t0)).toEqual([{ at: t0, line: 'PLAY cont 1 0' }]);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(500);
      expect(a.player.sounded(t0).map((p) => p.decision.tone)).toEqual(['dp_glance']);
      await w.dashcam('SNDOFF');
      await w.advance(500);

      const tc = w.W;
      await w.dashcam('SND 3 3 0');
      expect(w.txOf('ALERT', 1, tc).map((x) => x.f.route)).toEqual([1]);
      expect(w.buzzer(tc)).toEqual([{ at: tc, line: 'PLAY cont 3 0' }]);
      await w.advance(500);
      expect(a.player.sounded(tc).map((p) => p.decision.tone)).toEqual(['dp_wake']);
      await w.dashcam('SNDOFF');
      await w.advance(500);

      // A one-shot too: the buzzer chimes at once, the phone chimes, and nothing plays again later.
      const t1 = w.W;
      await w.dashcam('ONCE 5');
      expect(w.txOf('ALERT', 1, t1).map((x) => x.f.route)).toEqual([1]);
      expect(w.buzzer(t1)).toEqual([{ at: t1, line: 'PLAY once 5' }]);
      await w.advance(2000);
      expect(w.rxOf('ALERT_ACK', 1, t1).map((x) => x.f.outcome)).toEqual([1]);
      expect(a.player.sounded(t1)).toHaveLength(1);
      expect(w.buzzer(t1)).toEqual([{ at: t1, line: 'PLAY once 5' }]);
    }));

  test('row 2 (disconnect) and row 14: the link drops mid-alert → buzzer at once, the phone stops; back in range COMMAND 7 re-syncs and the active alert comes as route 0 (visual only)', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const alert = w.txOf('ALERT', 1, t0)[0]!;
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(1000);
      const held = a.rt.state().link.held;
      expect(held).toMatchObject({ sound: GLANCE, tier: 2, level: 0 });
      const t1 = w.W;
      await w.outOfRange(a);
      expect(w.buzzer(t1)).toEqual([{ at: t1, line: 'PLAY cont 1 0' }]);
      expect(a.rt.state().link.lifecycle).toBe('connecting');
      expect(a.rt.state().link.held).toBeNull();
      await w.advance(2000);
      expect(a.player.sounded(t1)).toEqual([]);
      expect(a.player.stops).toContain(t1);

      const t2 = w.W;
      await w.backInRange(a);
      await w.until(() => a.rt.state().link.synced, 3000, 'resync');
      expect(w.rxOf('COMMAND', 1, t2).map((x) => x.f.op)[0]).toBe(7);
      const names = w.tx(1, t2).map((x) => x.f.type);
      expect(names.slice(0, 3)).toEqual(['HELLO', 'STATUS', 'ALERT']);
      const again = w.txOf('ALERT', 1, t2);
      expect(again.map((x) => [x.f.alertId, x.f.route])).toEqual([[alert.f.alertId, 0]]);
      // Back within 10 s on the same boot: the halo's ramp goes on (same since) and the re-send is no news.
      expect(w.W - t1).toBeLessThan(10_000);
      expect(a.rt.state().link.held).toEqual(held);
      expect(a.rt.state().link.visual).toMatchObject({ alertId: alert.f.alertId, resend: true });
      await w.advance(3000);
      expect(w.rxOf('ALERT_ACK', 1, t2)).toEqual([]);
      expect(a.player.sounded(t2)).toEqual([]);
      expect(a.player.silent(t2).length).toBeGreaterThanOrEqual(1);
      expect(w.buzzer(t2)).toEqual([]); // the buzzer kept playing throughout
    }));

  test('row 2 (silent loss): nothing passes while both sides still think the link is up: the buzzer takes over by the quiet guard (3 s after the phone was last heard); the phone stops 3 s after its last frame and owes ACK(0)', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(600);
      w.blackhole(a);
      const lastFrame = Math.max(...w.tx(1, t0).map((x) => x.at)); // nothing reaches the phone after this
      const heard = lastHeard(w, 1, w.W);
      await w.runTo(heard + 3100);
      const fb = w.lines('PLAY cont 1 0', t0);
      expect(fb).toHaveLength(1);
      expect(fb[0]!.at - heard).toBeGreaterThan(3000);
      expect(fb[0]!.at - heard).toBeLessThanOrEqual(3010);
      await w.runTo(lastFrame + 4000);
      const plays = a.player.sounded(t0);
      expect(plays.length).toBeGreaterThan(0);
      expect(plays.at(-1)!.at).toBeLessThanOrEqual(lastFrame + 3000);
      // It tried to hand the alert back (lost on the dead link).
      const acks0 = a.sent.filter((x) => x.bytes[0] === 0x83 && x.bytes[4] === 0);
      expect(acks0).toHaveLength(1);
      await w.advance(2000);
      expect(a.player.sounded(lastFrame + 3001)).toEqual([]);
      // The supervision timeout ends it on both sides; still in range, the phone reconnects at once
      // and sees the alert the buzzer is playing as route 0 (visual only).
      const t1 = w.W;
      await w.linkLost(a);
      await w.until(() => a.rt.state().link.synced, 3000, 'resync');
      expect(w.txOf('ALERT', 1, t1).map((x) => x.f.route)).toEqual([0]);
      await w.advance(2000);
      expect(a.player.sounded(t1)).toEqual([]);
      expect(w.rxOf('ALERT_ACK', 1, t1)).toEqual([]);
    }));

  test('row 27: mute mid-alert → ALERT_STOP 2 and the phone stops; nothing while muted; unmute = a new alert, routed normally (a critical too: on the phone, the buzzer silent)', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const first = w.txOf('ALERT', 1, t0)[0]!;
      await w.advance(1000);
      const t1 = w.W;
      await w.dashcam('MUTE 1');
      expect(w.txOf('ALERT_STOP', 1, t1).map((x) => [x.f.alertId, x.f.reason])).toEqual([[first.f.alertId, 2]]);
      await w.dashcam('SND 3 3 0');
      await w.advance(3000);
      expect(w.txOf('ALERT', 1, t1)).toEqual([]);
      expect(w.buzzer(t1)).toEqual([]);
      expect(a.player.sounded(t1 + 1)).toEqual([]);
      expect((a.rt.state().link.status?.flags ?? 0) & 0x01).toBe(1); // STATUS: muted
      const t2 = w.W;
      await w.dashcam('MUTE 0');
      const next = w.txOf('ALERT', 1, t2);
      expect(next.map((x) => [x.f.sound, x.f.tier, x.f.route])).toEqual([[WAKE, 3, 1]]);
      expect(next[0]!.f.alertId).not.toBe(first.f.alertId);
      expect(w.rxOf('ALERT_ACK', 1, t2).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(500);
      expect(w.buzzer(t2)).toEqual([]);
      expect(a.player.sounded(t2).map((p) => p.decision.tone)).toEqual(['dp_wake']);
    }));

  test('(a) an iPhone asleep in the background with no drive: the ALERT wakes it, ACK(1) well inside 750 ms, plays every 2.5 s on the STATUS wakes (at most 500 ms late), the buzzer silent; ALERT_STOP ends it', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await w.sleep(a, { wakeMs: 150 });
      await w.advance(15_000); // asleep: no STATE, and the dashcam's periodic STATUS stops after 10 s
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const alert = w.txOf('ALERT', 1, t0)[0]!;
      expect(alert.f.route).toBe(1);
      await w.runTo(t0 + 8_000);
      const acks = w.rxOf('ALERT_ACK', 1, t0);
      expect(acks.map((x) => x.f.outcome)).toEqual([1]);
      expect(acks[0]!.at - alert.at).toBe(150);
      expect(w.buzzer(t0)).toEqual([]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
      const plays = a.player.sounded(t0).map((p) => p.at - t0);
      expect(plays[0]).toBe(150);
      expect(plays.length).toBeGreaterThanOrEqual(3);
      for (const g of gaps(plays)) {
        expect(g).toBeGreaterThanOrEqual(2500);
        expect(g).toBeLessThanOrEqual(3000);
      }
      const status = w.txOf('STATUS', 1, t0 + 1).map((x) => x.at);
      for (const g of gaps(status)) expect(g).toBeLessThanOrEqual(510);
      // Sounding, it sends STATE on its wakes, inside the dashcam's 3 s quiet guard.
      const states = w.rxOf('STATE', 1, t0).map((x) => x.at);
      expect(states.length).toBeGreaterThanOrEqual(4);
      for (const g of gaps(states)) expect(g).toBeLessThan(3000);
      const t1 = w.W;
      await w.dashcam('SNDOFF');
      await w.advance(4000);
      expect(a.player.sounded(t1 + 200)).toEqual([]);
      expect(w.buzzer(t0)).toEqual([]);
    }));

  test('(a2) negative: the same, but no STATUS reaches the sleeping phone after its first play: its repeats and STATEs stop, and the dashcam hands the alert to the buzzer by the quiet guard', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await w.sleep(a, { wakeMs: 150 });
      await w.advance(12_000);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      await w.runTo(t0 + 400);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      w.dropStatus(a, true);
      await w.runTo(t0 + 6000);
      const fb = w.txOf('ALERT_FALLBACK', 1, t0);
      expect(fb.map((x) => x.f.cause)).toEqual([3]);
      const heard = lastHeard(w, 1, fb[0]!.at - 1);
      expect(fb[0]!.at - heard).toBeGreaterThan(3000);
      expect(fb[0]!.at - heard).toBeLessThanOrEqual(3010);
      expect(w.buzzer(t0)).toEqual([{ at: fb[0]!.at, line: 'PLAY cont 1 0' }]);
      // Only the first play: nothing woke it for a repeat.
      expect(a.player.sounded(t0).map((p) => p.at - t0)).toEqual([150]);
    }));

  test('(b) Android in the background with no drive (JS timers paused, the link service keeping it alive): ACK(1) as the frame arrives, the wake lock held, repeats on the STATUS frames; frames stopping leave it to the quiet guard', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w, { platform: 'android' });
      await w.background(a);
      await w.advance(12_000);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const acks = w.rxOf('ALERT_ACK', 1, t0);
      expect(acks.map((x) => [x.at - t0, x.f.outcome])).toEqual([[0, 1]]);
      expect(a.holds[0]).toBe(t0);
      await w.runTo(t0 + 7_600);
      const plays = a.player.sounded(t0).map((p) => p.at - t0);
      expect(plays[0]).toBe(0);
      expect(plays.length).toBeGreaterThanOrEqual(3);
      for (const g of gaps(plays)) {
        expect(g).toBeGreaterThanOrEqual(2500);
        expect(g).toBeLessThanOrEqual(3000);
      }
      for (const g of gaps(a.holds.filter((h) => h >= t0))) expect(g).toBeGreaterThanOrEqual(1000);
      expect(w.buzzer(t0)).toEqual([]);
      // The dashcam's frames stop reaching it: no tick, no STATE; the quiet guard hands it over.
      w.dropStatus(a, true);
      const t1 = w.W;
      await w.runTo(t1 + 5000);
      const fb = w.txOf('ALERT_FALLBACK', 1, t1);
      expect(fb.map((x) => x.f.cause)).toEqual([3]);
      const heard = lastHeard(w, 1, fb[0]!.at - 1);
      expect(fb[0]!.at - heard).toBeGreaterThan(3000);
      expect(fb[0]!.at - heard).toBeLessThanOrEqual(3010);
      expect(w.buzzer(t1)).toEqual([{ at: fb[0]!.at, line: 'PLAY cont 1 0' }]);
      // The FALLBACK frame reached it: it stopped.
      expect(a.player.sounded(fb[0]!.at + 1)).toEqual([]);
    }));

  test('(f) the quiet cadence: RoadWise in the background with no drive sends no STATE for 30 s, and the dashcam sends no periodic STATUS once its STATE is 10 s old', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await w.advance(2000);
      a.appState.emit('background');
      await w.settle();
      const t0 = w.W;
      await w.advance(30_000);
      expect(w.rxOf('STATE', 1, t0)).toEqual([]);
      expect(w.txOf('STATUS', 1, t0 + 11_000)).toEqual([]);
      // A flags change still goes out with the next tick (here: "Also beep on DashPal" turned on).
      const t1 = w.W;
      await a.rt.setBuzzerToo(true);
      await w.advance(3000);
      expect(w.rxOf('STATE', 1, t1).map((x) => x.f.flags & 0x02)).toEqual([0x02]);
    }));

  test('(g) two phones: A in a drive is primary and plays, B in the background gets route 0; A ends its drive and leaves, so B takes the next alert', () =>
    scenario({ bootId: BOOT, bonded: ['A', 'B'] }, async (w) => {
      const a = await w.addPhone({ name: 'A', conn: 1, paired: true, recording: true });
      await w.connected(a);
      const b = await w.addPhone({ name: 'B', conn: 2, paired: true });
      await w.connected(b);
      b.appState.emit('background');
      await w.drive(a, 3000, 15);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.txOf('ALERT', 1, t0).map((x) => x.f.route)).toEqual([1]);
      expect(w.txOf('ALERT', 2, t0).map((x) => x.f.route)).toEqual([0]);
      await w.drive(a, 1000, 15);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      expect(w.rxOf('ALERT_ACK', 2, t0)).toEqual([]);
      expect(b.player.sounded(t0)).toEqual([]);
      expect(b.player.silent(t0).length).toBeGreaterThanOrEqual(1);
      await w.dashcam('SNDOFF');
      a.host.recording = false;
      await w.advance(1000);
      await w.outOfRange(a);
      await w.advance(500);
      const t1 = w.W;
      await w.dashcam('SND 2 2 0');
      expect(w.txOf('ALERT', 2, t1).map((x) => x.f.route)).toEqual([1]);
      expect(w.rxOf('ALERT_ACK', 2, t1).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(500);
      expect(b.player.sounded(t1).map((p) => p.decision.tone)).toEqual(['dp_drowsy']);
      expect(w.buzzer(t1)).toEqual([]);
    }));

  test('(g2) two phones, no drive: A connected first and gone quiet in the background; B opened in front takes the primary with its first STATE, and the next alert', () =>
    scenario({ bootId: BOOT, bonded: ['A', 'B'] }, async (w) => {
      const a = await w.addPhone({ name: 'A', conn: 1, paired: true });
      await w.connected(a);
      a.appState.emit('background');
      await w.advance(12_000); // A's last STATE is now over 10 s old
      const b = await w.addPhone({ name: 'B', conn: 2, paired: true });
      await w.connected(b);
      await w.advance(1000);
      expect((b.rt.state().link.status?.flags ?? 0) & 0x10).toBe(0x10); // STATUS bit 4: primary
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.txOf('ALERT', 2, t0).map((x) => x.f.route)).toEqual([1]);
      expect(w.txOf('ALERT', 1, t0).map((x) => x.f.route)).toEqual([0]);
      expect(w.rxOf('ALERT_ACK', 2, t0).map((x) => x.f.outcome)).toEqual([1]);
      expect(w.rxOf('ALERT_ACK', 1, t0)).toEqual([]);
      await w.advance(500);
      expect(b.player.sounded(t0)).toHaveLength(1);
      expect(a.player.sounded(t0)).toEqual([]);
    }));

  test('(g3) two phones, no drive: A primary and quiet in the background; B connecting while on a call (can_play 0) never takes the primary, so A plays the next alert', () =>
    scenario({ bootId: BOOT, bonded: ['A', 'B'] }, async (w) => {
      const a = await w.addPhone({ name: 'A', conn: 1, paired: true });
      await w.connected(a);
      a.appState.emit('background');
      await w.advance(12_000);
      const b = await w.addPhone({ name: 'B', conn: 2, paired: true });
      b.audio.callActive = true;
      b.appState.emit('background');
      await w.connected(b);
      expect(w.rxOf('STATE', 2).at(-1)!.f.flags & 0x01).toBe(0);
      await w.advance(1000);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.txOf('ALERT', 1, t0).map((x) => x.f.route)).toEqual([1]);
      expect(w.txOf('ALERT', 2, t0).map((x) => x.f.route)).toEqual([0]);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      expect(w.buzzer(t0)).toEqual([]);
    }));

  test('(h) a one-shot to a sleeping iPhone: held from the buzzer, ACK(1) on the wake, the phone chimes, the buzzer never does', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await w.sleep(a, { wakeMs: 150 });
      await w.advance(12_000);
      const t0 = w.W;
      await w.dashcam('ONCE 5');
      await w.runTo(t0 + 5000);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => [x.at - t0, x.f.outcome])).toEqual([[150, 1]]);
      expect(a.player.sounded(t0).map((p) => [p.at - t0, p.decision.level])).toEqual([[150, 1]]);
      expect(w.buzzer(t0)).toEqual([]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
    }));

  test('(i) a critical to a sleeping iPhone: ACK(1) inside 400 ms with a 150 ms wake, STATEs at most 700 ms apart while it plays, no buzzer; a 500 ms wake misses it: the buzzer at 400 ms and the phone shows it only', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await w.sleep(a, { wakeMs: 150 });
      await w.advance(12_000);
      const t0 = w.W;
      await w.dashcam('SND 3 3 0');
      await w.runTo(t0 + 5000);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => [x.at - t0, x.f.outcome])).toEqual([[150, 1]]);
      expect(w.buzzer(t0)).toEqual([]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
      // Woken by the 500 ms STATUS (150 ms later) or awake while it sounds: a STATE on each wake 450 ms
      // or more after the last, well inside the dashcam's 1.5 s quiet guard for a critical.
      const states = w.rxOf('STATE', 1, t0).map((x) => x.at);
      expect(states.length).toBeGreaterThanOrEqual(6);
      for (const g of gaps(states)) {
        expect(g).toBeGreaterThanOrEqual(450);
        expect(g).toBeLessThanOrEqual(700);
      }
      await w.dashcam('SNDOFF');
      await w.advance(12_000);

      a.asleep = { wakeMs: 500 };
      const t1 = w.W;
      await w.dashcam('SND 3 3 0');
      await w.runTo(t1 + 2000);
      expect(w.buzzer(t1)).toEqual([{ at: t1 + 400, line: 'PLAY cont 3 0' }]);
      expect(w.txOf('ALERT_FALLBACK', 1, t1).map((x) => [x.at - t1, x.f.cause])).toEqual([[400, 1]]);
      expect(w.rxOf('ALERT_ACK', 1, t1).map((x) => [x.at - t1, x.f.outcome])).toEqual([[500, 0]]);
      expect(a.player.sounded(t1)).toEqual([]);
      expect(a.player.silent(t1).length).toBeGreaterThanOrEqual(1);
    }));

  test('the no-face alert (sound 6) routed to the phone: ALERT_ACK within 750 ms, the buzzer silent and never joined; the phone plays the glance tone every 5 s, says "Driver not visible" once, releases the audio session between plays and keeps its own tones on; ALERT_STOP ends it', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 6 2 0');
      const alerts = w.txOf('ALERT', 1, t0);
      expect(alerts.map((x) => x.f)).toEqual([expect.objectContaining({ sound: NO_FACE, tier: 2, level: 0, mode: 1, route: 1 })]);
      const acks = w.rxOf('ALERT_ACK', 1, t0);
      expect(acks.map((x) => x.f.outcome)).toEqual([1]);
      expect(acks[0]!.at - alerts[0]!.at).toBeLessThanOrEqual(750);

      await w.runTo(t0 + 10_100);
      expect(w.buzzer(t0)).toEqual([]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
      const plays = a.player.sounded(t0);
      expect(plays.map((p) => [p.at - t0, p.decision.tone, p.decision.voice ?? null, p.decision.holdSession ?? false])).toEqual([
        [0, 'dp_glance', 'Driver not visible', false],
        [5000, 'dp_glance', null, false],
        [10_000, 'dp_glance', null, false],
      ]);
      expect(a.rt.state().link.visual).toMatchObject({ alertId: alerts[0]!.f.alertId, sound: NO_FACE, onPhone: true });
      expect(a.rt.state().link.held).toMatchObject({ sound: NO_FACE, tier: 2 });
      expect(a.rt.continuousAlertActive()).toBe(false);

      const t1 = w.W;
      await w.dashcam('SNDOFF');
      expect(w.txOf('ALERT_STOP', 1, t1).map((x) => [x.f.alertId, x.f.reason])).toEqual([[alerts[0]!.f.alertId, 0]]);
      expect(w.buzzer(t1)).toEqual([]);
      await w.advance(6000);
      expect(a.player.sounded(t1 + 1)).toEqual([]);
    }));

  test('a confirmed glance warning hands over to the no-face alert: the buzzer silent throughout (nothing is ever joined), no FALLBACK, the phone plays both', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const glance = w.txOf('ALERT', 1, t0)[0]!;
      await w.runTo(t0 + 4000);
      expect(w.buzzer(t0)).toEqual([]);

      const t1 = w.W;
      await w.dashcam('SND 6 2 0');
      expect(w.txOf('ALERT_STOP', 1, t1).map((x) => [x.f.alertId, x.f.reason])).toEqual([[glance.f.alertId, 1]]);
      const nf = w.txOf('ALERT', 1, t1);
      expect(nf.map((x) => [x.f.sound, x.f.route])).toEqual([[NO_FACE, 1]]);
      expect(w.rxOf('ALERT_ACK', 1, t1).map((x) => [x.f.alertId, x.f.outcome])).toEqual([[nf[0]!.f.alertId, 1]]);
      await w.runTo(t1 + 8000);
      expect(w.buzzer(t0)).toEqual([]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
      expect(a.player.sounded(t1).map((p) => [p.at - t1, p.decision.tone])).toEqual([
        [0, 'dp_glance'],
        [5000, 'dp_glance'],
      ]);
    }));

  test('the phone can no longer play the no-face alert (a call begins): it hands it to the buzzer (PLAY cont 6 0) and stops', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 6 2 0');
      const alert = w.txOf('ALERT', 1, t0)[0]!;
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(1000);
      const t1 = w.W;
      a.host.callActive = true;
      await w.advance(1500);
      const fb = w.txOf('ALERT_FALLBACK', 1, t1);
      expect(fb).toHaveLength(1);
      expect(fb[0]!.f.alertId).toBe(alert.f.alertId);
      expect([2, 3]).toContain(fb[0]!.f.cause);
      expect(w.buzzer(t1)).toEqual([{ at: fb[0]!.at, line: 'PLAY cont 6 0' }]);
      await w.advance(6000);
      expect(a.player.sounded(t1)).toEqual([]);
    }));

  test('the phone goes while the no-face alert sounds: a disconnect leaves both outputs silent (no buzzer, no fallback); back in range the dashcam starts it again as a new routed alert, shown without its words', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 6 2 0');
      const first = w.txOf('ALERT', 1, t0)[0]!;
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(1000);
      const t1 = w.W;
      await w.outOfRange(a);
      await w.advance(5000);
      expect(w.buzzer(t0)).toEqual([]);
      expect(a.player.sounded(t1)).toEqual([]);
      expect(a.player.stops).toContain(t1);

      const t2 = w.W;
      await w.backInRange(a);
      await w.until(() => w.txOf('ALERT', 1, t2).some((x) => x.f.route === 1), 5000, 'the no-face alert again, routed');
      const again = w.txOf('ALERT', 1, t2).filter((x) => x.f.route === 1);
      expect(again.map((x) => x.f.sound)).toEqual([NO_FACE]);
      expect(again[0]!.f.alertId).not.toBe(first.f.alertId);
      await w.advance(2000);
      expect(w.rxOf('ALERT_ACK', 1, t2).map((x) => [x.f.alertId, x.f.outcome])).toEqual([[again[0]!.f.alertId, 1]]);
      const plays = a.player.sounded(t2);
      expect(plays.map((p) => [p.decision.tone, p.decision.voice ?? null])).toEqual([['dp_glance', null]]); // within 60 s of the last one
      expect(w.buzzer(t2)).toEqual([]);
    }));

  test('the phone stops sending STATE during the no-face alert (frozen): ALERT_STOP(0) once its 3 s TTL lapses, the buzzer silent throughout (no blip at the quiet guard), no fallback', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const stateAt = await afterState(w, a, 500);
      const t0 = w.W;
      await w.dashcam('SND 6 2 0');
      const alert = w.txOf('ALERT', 1, t0)[0]!;
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(20);
      w.suspend(a);
      await w.runTo(stateAt + 2900);
      expect(w.buzzer(t0)).toEqual([]);
      await w.runTo(stateAt + 3000);
      expect(w.txOf('ALERT_STOP', 1, t0)).toEqual([]);
      await w.runTo(stateAt + 3200);
      const stops = w.txOf('ALERT_STOP', 1, t0);
      expect(stops.map((x) => [x.f.alertId, x.f.reason])).toEqual([[alert.f.alertId, 0]]);
      expect(stops[0]!.at - stateAt).toBeGreaterThan(3000);
      expect(stops[0]!.at - stateAt).toBeLessThanOrEqual(3010);
      expect(w.buzzer(t0)).toEqual([]); // no PLAY cont 6 between 2.9 and 3.2 s, nor after
      await w.runTo(t0 + 8000);
      expect(w.buzzer(t0)).toEqual([]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
    }));
});
