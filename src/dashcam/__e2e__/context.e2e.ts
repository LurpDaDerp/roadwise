/** @jest-environment node */
// Time, context and two phones end to end (plan §3.3–3.4, §3.7; §10 rows 15, 16, 24): the clock
// offset over a link with latency, the speed and local time the engine gets (CTXQ), and the primary
// link with two phones.
import { CAM, EPOCH0, linkedA, scenario, type Phone, type World } from './world';
import { describeSim } from './suite';

const BOOT = 'ab5e0001';

async function ctx(w: World): Promise<[string, string]> {
  const out = await w.dashcam('CTXQ');
  const line = out.find((l) => l.startsWith('CTX '))!;
  const [, speed, min] = line.split(' ');
  return [speed!, min!];
}

const localMinute = (epoch: number) => {
  const d = new Date(epoch);
  return d.getHours() * 60 + d.getMinutes();
};

async function bestOffset(p: Phone): Promise<{ offset_ms: number; rtt_ms: number }> {
  const { rows } = await p.rawDb.execute('SELECT offset_ms, rtt_ms FROM dashcam_boots WHERE dashcam_id = ?', [CAM]);
  return rows[0] as never;
}

async function coverage(p: Phone): Promise<{ moving_s: number; covered_s: number } | undefined> {
  const { rows } = await p.rawDb.execute('SELECT moving_s, covered_s FROM dashcam_coverage WHERE client_trip_id = ?', [p.tripId]);
  return rows[0] as never;
}

describeSim('DashPal time, context and two phones (firmware simulator ↔ app link)', () => {
  test('row 15: over a link with 30 ms down / 10 ms up the offset is within RTT/2 (TIME_PING beats the HELLO sample); RESUME after the three echoes; event wall times use it', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      await w.runTo(5000); // the dashcam has been up 5 s
      const a = await w.addPhone({ name: 'A', conn: 1, paired: true, latency: { up: 10, down: 30 } });
      await w.connected(a);
      const pings = w.rxOf('TIME_PING', 1);
      expect(pings).toHaveLength(3);
      expect(pings.map((p) => p.at - pings[0]!.at)).toEqual([0, 100, 200]);
      expect(w.txOf('TIME_ECHO', 1)).toHaveLength(3);
      // RESUME follows the third echo (not the 500 ms timer).
      const resume = w.rxOf('RESUME', 1)[0]!;
      expect(resume.at - (pings[0]!.at - 10)).toBeLessThan(500);
      const truth = EPOCH0 + w.bootAt; // epoch at dashcam uptime 0
      const best = await bestOffset(a);
      expect(best.rtt_ms).toBe(40);
      expect(Math.abs(best.offset_ms - truth)).toBeLessThanOrEqual(best.rtt_ms / 2);
      expect(best.offset_ms - truth).toBe(10); // (down − up) / 2
      // The dashcam's STATUS says it is time-synced.
      await w.advance(2500);
      expect((a.rt.state().link.status?.flags ?? 0) & 0x04).toBe(0x04);
      await w.dashcam(`EV 3 2 1 0 ${w.uptime()} 35 35`);
      await w.advance(500);
      const { rows } = await a.rawDb.execute('SELECT t_ms, at_ms FROM dashcam_events WHERE dashcam_id = ?', [CAM]);
      const r = rows[0] as { t_ms: number; at_ms: number };
      expect(Math.abs(r.at_ms - (truth + r.t_ms))).toBeLessThanOrEqual(20);
    }));

  test('row 16: speed and local time reach the engine from STATE while the drive row is fresh; stale rows or a poor fix make speed unknown at once; without STATE it holds 10 s; local time keeps advancing', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      expect(await ctx(w)).toEqual(['nan', 'nan']); // nothing yet
      const a = await linkedA(w, { recording: true });
      await w.drive(a, 3000, 25); // 25 m/s = 90 km/h
      const st = w.rxOf('STATE', 1).at(-1)!;
      expect(st.f.flags & 0x0c).toBe(0x0c); // drive_active + speed_valid
      expect(st.f.speedCms).toBe(2500);
      expect(st.f.localMin).toBe(localMinute(EPOCH0 + st.at));
      let [speed, min] = await ctx(w);
      expect(speed).toBe('90.000');
      expect(Number(min)).toBeCloseTo(st.f.localMin + (w.W - st.at) / 60_000, 3);

      // A poor speed accuracy (> 2 m/s): speed_valid 0 on the next STATE → unknown at once.
      w.row(a, { speed: 25, speedAcc: 3 });
      const t0 = w.W;
      await w.until(() => w.rxOf('STATE', 1, t0 + 1).length > 0, 2000);
      expect(w.rxOf('STATE', 1, t0 + 1)[0]!.f.flags & 0x08).toBe(0);
      expect((await ctx(w))[0]).toBe('nan');

      // Good rows again, then none: 2 s later the phone stops vouching for the speed.
      await w.drive(a, 2000, 20);
      expect((await ctx(w))[0]).toBe('72.000');
      const lastRow = w.W;
      await w.runTo(lastRow + 1500);
      expect((await ctx(w))[0]).toBe('72.000');
      await w.runTo(lastRow + 3100);
      expect((await ctx(w))[0]).toBe('nan');

      // No STATE at all (the app suspended): the last speed holds 10 s, then unknown; local time advances.
      await w.drive(a, 2000, 20);
      w.suspend(a);
      const lastState = w.rxOf('STATE', 1).at(-1)!;
      await w.runTo(lastState.at + 9900);
      expect((await ctx(w))[0]).toBe('72.000');
      await w.runTo(lastState.at + 10_100);
      [speed, min] = await ctx(w);
      expect(speed).toBe('nan');
      expect(Number(min)).toBeCloseTo(lastState.f.localMin + (w.W - lastState.at) / 60_000, 3);
      await w.advance(120_000);
      expect(Number((await ctx(w))[1])).toBeCloseTo(lastState.f.localMin + (w.W - lastState.at) / 60_000, 3);
    }));

  test('row 24: two phones: the one in a drive becomes primary and holds the lease; the other gets alerts visual-only; coverage counts only on the primary; the primary leaving hands over', () =>
    scenario({ bootId: BOOT, bonded: ['A', 'B'] }, async (w) => {
      await w.dashcam('STATE 3 72'); // monitoring, calibrated, live face
      const a = await w.addPhone({ name: 'A', conn: 1, paired: true });
      await w.connected(a);
      await w.advance(1500);
      expect((a.rt.state().link.status?.flags ?? 0) & 0x10).toBe(0x10); // A is primary (alone)
      const b = await w.addPhone({ name: 'B', conn: 2, paired: true, platform: 'android', recording: true });
      await w.connected(b);
      await w.advance(1500);
      expect((b.rt.state().link.status?.flags ?? 0) & 0x10).toBe(0x10); // drive_active wins
      expect((a.rt.state().link.status?.flags ?? 0) & 0x10).toBe(0);

      // A starts a drive too: the current primary (B) keeps it. Rows on both: only B's are covered.
      a.host.recording = true;
      for (let i = 0; i < 5; i++) {
        w.row(a, { speed: 10 });
        w.row(b, { speed: 10 });
        await w.advance(1000);
      }
      expect((b.rt.state().link.status?.flags ?? 0) & 0x10).toBe(0x10);
      expect(await coverage(b)).toEqual({ moving_s: 5, covered_s: 5 });
      expect(await coverage(a)).toEqual({ moving_s: 5, covered_s: 0 });

      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      const toA = w.txOf('ALERT', 1, t0);
      const toB = w.txOf('ALERT', 2, t0);
      expect(toB.map((x) => x.f.route)).toEqual([1]);
      expect(toA.map((x) => [x.f.alertId, x.f.route])).toEqual([[toB[0]!.f.alertId, 0]]);
      expect(w.rxOf('ALERT_ACK', 2, t0).map((x) => x.f.outcome)).toEqual([1]);
      expect(w.rxOf('ALERT_ACK', 1, t0)).toEqual([]);
      await w.advance(1000);
      expect(b.player.sounded(t0).map((p) => p.decision.tone)).toEqual(['dp_glance']);
      expect(a.player.sounded(t0)).toEqual([]);
      expect(a.player.silent(t0).length).toBeGreaterThanOrEqual(1);
      expect(w.buzzer(t0)).toEqual([]);

      // B leaves mid-alert: the routed episode falls back to the buzzer; A becomes primary.
      const t1 = w.W;
      await w.outOfRange(b);
      expect(w.buzzer(t1)).toEqual([{ at: t1, line: 'PLAY cont 1 0' }]);
      expect(w.txOf('ALERT_FALLBACK', 1, t1).map((x) => x.f.cause)).toEqual([3]);
      await w.dashcam('SNDOFF');
      await w.advance(3000);
      expect((a.rt.state().link.status?.flags ?? 0) & 0x10).toBe(0x10);
      const t2 = w.W;
      await w.dashcam('SND 2 2 0');
      expect(w.txOf('ALERT', 1, t2).map((x) => x.f.route)).toEqual([1]);
      expect(w.rxOf('ALERT_ACK', 1, t2).map((x) => x.f.outcome)).toEqual([1]);
      expect(w.buzzer(t2)).toEqual([]);
    }));
});
