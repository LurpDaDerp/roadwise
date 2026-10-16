/** @jest-environment node */
// Alert routing end to end (plan §3.4–3.5, §10 rows 1–8, 27): the firmware's ble_link (simulator)
// decides buzzer vs phone; the app's link and alert controller answer and play. Every test checks
// both sides: what the dashcam sent and its buzzer did, and what the phone acknowledged and played.
import { describeSim } from './suite';
import { linkedA, scenario, type Phone, type World } from './world';

const BOOT = '9e3779b9';
const GLANCE = 1;
const DROWSY = 2;
const WAKE = 3;
const CHIME = 5;
const NO_FACE = 6;

/** Wait for a STATE from the phone, then `ms` more: the lease age at the next step is known. */
async function afterState(w: World, a: Phone, ms: number): Promise<number> {
  const n = w.rxOf('STATE', a.conn).length;
  await w.until(() => w.rxOf('STATE', a.conn).length > n, 2000, 'a STATE');
  const at = w.rxOf('STATE', a.conn).at(-1)!.at;
  await w.runTo(at + ms);
  return at;
}

describeSim('DashPal alert routing (firmware simulator ↔ app link)', () => {
  test('a glance warning routed to the phone: ALERT_ACK within 750 ms, buzzer silent; the buzzer joins after 3 s (cause 4) and the phone keeps playing; ALERT_STOP ends both', () =>
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

      await w.runTo(t0 + 2990);
      expect(w.buzzer(t0)).toEqual([]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
      // The phone sounds it: the DashPal glance tone, the voice on the first play only, repeats 2.5 s start to start.
      const plays = a.player.sounded(t0);
      expect(plays.map((p) => [p.at - t0, p.decision.tone, p.decision.voice !== undefined])).toEqual([
        [0, 'dp_glance', true],
        [2500, 'dp_glance', false],
      ]);
      expect(a.rt.state().link.visual).toMatchObject({ alertId: alert.f.alertId, sound: GLANCE, onPhone: true });
      // The halo holds it for as long as it lasts.
      expect(a.rt.state().link.held).toMatchObject({ sound: GLANCE, tier: 2, level: 0 });

      await w.runTo(t0 + 3010);
      expect(w.buzzer(t0)).toEqual([{ at: t0 + 3000, line: 'PLAY cont 1 0' }]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0).map((x) => [x.at - t0, x.f.alertId, x.f.cause])).toEqual([[3000, alert.f.alertId, 4]]);
      await w.runTo(t0 + 6000);
      expect(a.player.sounded(t0 + 3001).length).toBeGreaterThan(0); // cause 4: the phone keeps playing
      expect(w.rxOf('ALERT_ACK', 1, t0)).toHaveLength(1); // never a second ACK

      const t1 = w.W;
      await w.dashcam('SNDOFF');
      expect(w.txOf('ALERT_STOP', 1, t1).map((x) => x.f)).toEqual([{ type: 'ALERT_STOP', alertId: alert.f.alertId, reason: 0 }]);
      expect(w.buzzer(t1)).toEqual([{ at: t1, line: 'STOP' }]);
      await w.advance(6000);
      expect(a.player.sounded(t1 + 1)).toEqual([]);
      expect(a.player.stops.some((s) => s >= t1)).toBe(true);
      expect(a.rt.state().link.held).toBeNull();
    }));

  test('row 3: the phone never answers (suspended with a fresh lease): buzzer at the 750 ms deadline with ALERT_FALLBACK 1; the app, woken late, answers ACK(0) and never sounds it', () =>
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

      // iOS wakes the app: the held frames arrive one after the other (ALERT, then FALLBACK 1). The
      // ALERT is past the deadline by the boot's offset: shown, ACK(0), never sounded on the phone.
      const t1 = w.W;
      await w.resume(a);
      await w.advance(4000);
      expect(w.rxOf('ALERT_ACK', 1, t1).map((x) => x.f.outcome)).toEqual([0]);
      expect(a.player.sounded(t0)).toEqual([]);
      expect(a.rt.state().link.counters.lateAlerts).toBe(1);
      expect(w.buzzer(t1)).toEqual([]); // still playing: no STOP, no re-gate
      expect(w.txOf('ALERT_FALLBACK', 1, t1).filter((x) => x.f.cause !== 4)).toEqual([]);
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

  test('row 3: ACK(0) after ACK(1) (the player fails mid-alert): FALLBACK 2, the buzzer takes over, the phone stops', () =>
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
    }));

  test('rows 1 and 8: the lease lapses mid-episode (iOS suspended the app): the buzzer takes over with FALLBACK 3 and keeps the episode after the phone is back, even across a supersede', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const stateAt = await afterState(w, a, 500);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const first = w.txOf('ALERT', 1, t0)[0]!;
      expect(first.f.route).toBe(1);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(20);
      w.suspend(a); // no STATE from here: the lease (3 s) lapses before the 3 s join would
      await w.runTo(stateAt + 3000);
      expect(w.buzzer(t0)).toEqual([]);
      await w.runTo(stateAt + 3100);
      const fb = w.txOf('ALERT_FALLBACK', 1, t0);
      expect(fb.map((x) => x.f.cause)).toEqual([3]);
      expect(fb[0]!.at - stateAt).toBeGreaterThan(3000);
      expect(fb[0]!.at - stateAt).toBeLessThanOrEqual(3010);
      expect(w.buzzer(t0)).toEqual([{ at: fb[0]!.at, line: 'PLAY cont 1 0' }]);

      // The phone comes back: the held FALLBACK stops it; STATE (the lease) flows again.
      await w.runTo(t0 + 4000);
      const back = w.W;
      await w.resume(a);
      await w.until(() => w.rxOf('STATE', 1, back).length > 0, 2000, 'STATE after resume');
      await w.advance(1000);
      expect(a.player.sounded(back)).toEqual([]);
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

  test('row 5: a critical sounds on the buzzer from the first moment and on the phone; a level step re-sends the same alert (no new ACK)', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 3 3 0');
      const alert = w.txOf('ALERT', 1, t0)[0]!;
      expect(alert.f).toMatchObject({ sound: WAKE, tier: 3, level: 0, mode: 1, route: 1 });
      expect(w.buzzer(t0)).toEqual([{ at: t0, line: 'PLAY cont 3 0' }]);
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(2000);
      const first = a.player.sounded(t0);
      expect(first[0]).toMatchObject({ at: t0, decision: { tone: 'dp_wake', voiceAlways: true } });
      expect(first[0]!.decision.voice).toBeDefined();
      const held = a.rt.state().link.held;
      expect(held).toMatchObject({ sound: WAKE, tier: 3, level: 0 });
      const t1 = w.W;
      await w.dashcam('SND 3 3 2');
      expect(w.txOf('ALERT', 1, t1).map((x) => [x.f.alertId, x.f.level, x.f.route])).toEqual([[alert.f.alertId, 2, 1]]);
      expect(w.buzzer(t1)).toEqual([{ at: t1, line: 'PLAY cont 3 2' }]);
      expect(a.rt.state().link.held).toEqual({ ...held, level: 2 });
      await w.advance(3000);
      expect(w.rxOf('ALERT_ACK', 1, t0)).toHaveLength(1);
      // The level step speaks again; then wake repeats every 1.0 s start to start.
      const after = a.player.sounded(t1);
      expect(after[0]!.decision.voice).toBeDefined();
      const gaps = after.slice(1).map((p, i) => p.at - after[i]!.at);
      expect(gaps.length).toBeGreaterThanOrEqual(2);
      for (const g of gaps) expect(g).toBe(1000);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
      const t2 = w.W;
      await w.dashcam('SNDOFF');
      expect(w.buzzer(t2)).toEqual([{ at: t2, line: 'STOP' }]);
      expect(w.txOf('ALERT_STOP', 1, t2).map((x) => x.f.reason)).toEqual([0]);
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
      // The app wakes after the deadline: the held ALERT is late by the boot's offset, so it is shown
      // and answered ACK(0) without a chime; the one-shot sounds once, on the buzzer only.
      const back = w.W;
      await w.resume(a);
      await w.advance(1000);
      expect(w.rxOf('ALERT_ACK', 1, back).map((x) => x.f.outcome)).toEqual([0]);
      expect(a.player.sounded(t1)).toEqual([]);
      expect(w.buzzer(back)).toEqual([]);
    }));

  test('row 4: vibration-only style → STATE can_play 0 → no lease: the buzzer at once, ALERT route 0, the phone vibrates and never ACKs', () =>
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

  test('"Also beep on DashPal": STATE buzzer_too, so a routed alert or one-shot sounds on both from the start', () =>
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

      // A one-shot too: the buzzer chimes at once, the phone chimes, and nothing plays again later.
      await w.dashcam('SNDOFF');
      await w.advance(500);
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

  test('row 2 (silent loss): nothing passes while both sides still think the link is up: the phone stops 3 s after its last frame (and owes ACK(0)); the buzzer takes over when the lease lapses', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const stateAt = await afterState(w, a, 600);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(100);
      w.blackhole(a);
      const lastFrame = w.txOf('ALERT', 1, t0)[0]!.at; // nothing reaches the phone after this step
      await w.runTo(stateAt + 3100);
      const fb = w.lines('PLAY cont 1 0', t0);
      expect(fb).toHaveLength(1);
      expect(fb[0]!.at - stateAt).toBeGreaterThan(3000);
      expect(fb[0]!.at - stateAt).toBeLessThanOrEqual(3010);
      await w.runTo(lastFrame + 4000);
      const plays = a.player.sounded(t0);
      expect(plays.length).toBeGreaterThan(0);
      expect(plays.at(-1)!.at).toBeLessThanOrEqual(lastFrame + 3000);
      // It tried to hand the alert back (lost on the dead link).
      const acks0 = a.ble.writes.filter((x) => x.bytes[0] === 0x83 && x.bytes[4] === 0);
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

  test('row 27: mute mid-alert → ALERT_STOP 2 and the phone stops; nothing while muted; unmute = a new alert, routed normally', () =>
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
      expect(w.buzzer(t2)).toEqual([{ at: t2, line: 'PLAY cont 3 0' }]);
      expect(w.rxOf('ALERT_ACK', 1, t2).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(500);
      expect(a.player.sounded(t2).map((p) => p.decision.tone)).toEqual(['dp_wake']);
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
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]); // never joined (no cause 4)
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

  test('a glance warning the buzzer had joined hands over to the no-face alert: the buzzer goes silent with the supersede and never joins the no-face alert', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const glance = w.txOf('ALERT', 1, t0)[0]!;
      await w.runTo(t0 + 3010);
      expect(w.buzzer(t0)).toEqual([{ at: t0 + 3000, line: 'PLAY cont 1 0' }]);

      const t1 = w.W;
      await w.dashcam('SND 6 2 0');
      expect(w.txOf('ALERT_STOP', 1, t1).map((x) => [x.f.alertId, x.f.reason])).toEqual([[glance.f.alertId, 1]]);
      const nf = w.txOf('ALERT', 1, t1);
      expect(nf.map((x) => [x.f.sound, x.f.route])).toEqual([[NO_FACE, 1]]);
      expect(w.buzzer(t1)).toEqual([{ at: t1, line: 'STOP' }]);
      expect(w.rxOf('ALERT_ACK', 1, t1).map((x) => [x.f.alertId, x.f.outcome])).toEqual([[nf[0]!.f.alertId, 1]]);
      await w.runTo(t1 + 8000);
      expect(w.buzzer(t1 + 1)).toEqual([]);
      expect(w.txOf('ALERT_FALLBACK', 1, t1)).toEqual([]);
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

  test('the phone stops sending STATE during the no-face alert (iOS suspended the app): ALERT_STOP(0) once its 3 s lease lapses, the buzzer silent, no fallback', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const stateAt = await afterState(w, a, 500);
      const t0 = w.W;
      await w.dashcam('SND 6 2 0');
      const alert = w.txOf('ALERT', 1, t0)[0]!;
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.advance(20);
      w.suspend(a);
      await w.runTo(stateAt + 3000);
      expect(w.txOf('ALERT_STOP', 1, t0)).toEqual([]);
      await w.runTo(stateAt + 3100);
      const stops = w.txOf('ALERT_STOP', 1, t0);
      expect(stops.map((x) => [x.f.alertId, x.f.reason])).toEqual([[alert.f.alertId, 0]]);
      expect(stops[0]!.at - stateAt).toBeGreaterThan(3000);
      expect(stops[0]!.at - stateAt).toBeLessThanOrEqual(3010);
      await w.runTo(t0 + 8000);
      expect(w.buzzer(t0)).toEqual([]);
      expect(w.txOf('ALERT_FALLBACK', 1, t0)).toEqual([]);
    }));
});
