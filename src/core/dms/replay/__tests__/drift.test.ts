// Task C5 (design rev2 §2.3.1, §2.3.3; rev1 I1; the engine reviewer's texting probe): slow drift, the rolling
// path and the slow uncorroborated path, and the guards that keep a texting driver from pulling the centre.
// Through the engine façade with motion evidence (the synth's face geometry on).
import { angularDistanceDeg } from '../../engine/angles';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import type { DmsAlertCommand } from '../../engine/alerts';
import { createDmsEngine, type DmsEvent, type DmsSnapshot } from '../../engine/engine';
import type { AnglePair } from '../../engine/types';
import { DEFAULT_INIT } from '../run';
import { blinkOpenness, onRoad, rel, synthDrive, type DriverFn, type DriverState } from '../synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;

function drv(over: (t: number, r: () => number) => Partial<DriverState> | null, speedKmh = 60): DriverFn {
  return (t, r) => {
    const base: DriverState = { gaze: onRoad(r), openness: blinkOpenness(t), speedKmh };
    const o = over(t, r);
    return o === null ? base : { ...base, ...o };
  };
}

interface Run {
  events: DmsEvent[];
  commands: DmsAlertCommand[];
  /** once a second: time, the primary centre, the distraction state */
  seconds: { tMs: number; centre: AnglePair | null; distraction: DmsSnapshot['distraction'] }[];
}

function play(driver: DriverFn, seconds: number, o: { fps?: number; cfg?: DmsConfig; seed?: number } = {}): Run {
  const items = synthDrive({ fps: o.fps ?? 15, seconds, seed: o.seed ?? 21, source: 'geometric', driver, motion: true });
  const engine = createDmsEngine(o.cfg ?? C, DEFAULT_INIT);
  const run: Run = { events: [], commands: [], seconds: [] };
  let next = 0;
  for (const it of items) {
    if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    engine.pushFrame(it.frame);
    const out = engine.drain();
    run.events.push(...out.events);
    run.commands.push(...out.commands);
    if (it.frame.tMs >= next) {
      next += 1000;
      const s = engine.snapshot();
      run.seconds.push({ tMs: it.frame.tMs, centre: s.centre.gaze, distraction: s.distraction });
    }
  }
  return run;
}
const at = (r: Run, tMs: number) => [...r.seconds].reverse().find((s) => s.tMs <= tMs)!;
const d1 = (r: Run, from: number) => r.commands.filter((c) => c.kind === 'distraction' && c.action === 'start' && c.tMs >= from);
/** The bias against the true centre (the calibrated one at t0 moved by the shift the driver made since). */
function biases(r: Run, t0: number, until: number, shift: (tS: number) => AnglePair): number[] {
  const c0 = at(r, t0 * 1000).centre!;
  return r.seconds.filter((s) => s.tMs > t0 * 1000 && s.tMs <= until * 1000).map((s) => {
    const sh = shift(s.tMs / 1000);
    return angularDistanceDeg(s.centre!, { yaw: c0.yaw + sh.yaw, pitch: c0.pitch + sh.pitch });
  });
}
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;

describe('S-D1 / S-D2: slow drift is followed (S-D1: NC-C5-M, NC-C5-L)', () => {
  test('S-D1: 0.3°/min for 30 min: bias ≤ 1.5° throughout, 0 false D1', () => {
    const rate = 0.3 / 60;
    const shift = (t: number) => ({ yaw: t > 100 ? rate * (t - 100) : 0, pitch: 0 });
    const r = play(drv((t) => ({ posture: { shift: shift(t) } })), 100 + 1800);
    expect(Math.max(...biases(r, 100, 1900, shift))).toBeLessThanOrEqual(1.5);
    expect(d1(r, 100_000)).toEqual([]);
  });
  test.each([15, 8])('S-D2 at %i fps: 1°/min for 15 min: bias ≤ 3.5° max and ≤ 2.5° for 90 % of the time; D1 ≤ 1', (fps) => {
    const rate = 1 / 60;
    const shift = (t: number) => ({ yaw: t > 100 ? rate * (t - 100) : 0, pitch: 0 });
    const r = play(drv((t) => ({ posture: { shift: shift(t) } })), 100 + 900, { fps });
    const b = biases(r, 100, 1000, shift);
    expect(Math.max(...b)).toBeLessThanOrEqual(3.5);
    expect(quantile(b, 0.9)).toBeLessThanOrEqual(2.5);
    expect(d1(r, 100_000).length).toBeLessThanOrEqual(1);
  });
});

describe('the texting guards (rev1 I1)', () => {
  // S-TEXT's pattern resets D2 (2 s on the road each cycle) and its 2.5 s lap glances pass D1's 2.4 s: the
  // distraction rules answer it (D1), as their rules say; the subject here is the centre, which must not move.
  test('S-TEXT: 10 min of 2.5 s glances at (0°, −12°) and (5°, −35°), 2 s on the road: the distraction rules fire; the centre moves ≤ 1°; no posture', () => {
    const r = play(
      drv((t) => {
        if (t < 100) return null;
        const k = (t - 100) % 9; // glance 2.5, road 2, glance 2.5, road 2
        return k < 2.5 ? { gaze: rel(0, -12) } : k >= 4.5 && k < 7 ? { gaze: rel(5, -35) } : null;
      }),
      700
    );
    expect(r.commands.some((c) => (c.kind === 'distraction' || c.kind === 'cumulative') && c.action === 'start')).toBe(true);
    expect(angularDistanceDeg(at(r, 99_000).centre!, at(r, 699_000).centre!)).toBeLessThanOrEqual(1);
    expect(r.events.filter((e) => e.kind === 'posture_dual')).toEqual([]);
  });
  test.each([
    ['(0°, −12°)', rel(0, -12)],
    ['(0°, −8°)', rel(0, -8)],
  ])('the texting probe: 15 min at 80 km/h, 60 %% of a 5 s cycle at %s: the centre moves ≤ 0.3° (NC-I1)', (_, phone) => {
    const r = play(drv((t) => (t >= 100 && (t - 100) % 5 < 3 ? { gaze: phone } : null), 80), 100 + 900);
    expect(angularDistanceDeg(at(r, 99_000).centre!, at(r, 999_000).centre!)).toBeLessThanOrEqual(0.3);
  });
});

describe('S-U12: an uncorroborated 12° shift is followed by the slow path (NC-R3b)', () => {
  test('followed within 7 min, 0 false D1 meanwhile, widened until then', () => {
    const shift = { yaw: 12, pitch: 0 };
    const r = play(
      drv((t) => ({
        ...(t >= 110 ? { posture: { shift } } : {}),
        // normal scanning: a rear-mirror and a driver-mirror check every 15 s
        ...(t % 15 >= 5 && t % 15 < 5.8 ? { gaze: rel(27, 10) } : t % 15 >= 11 && t % 15 < 11.8 ? { gaze: rel(-45, 0) } : {}),
      })),
      110 + 480
    );
    const c0 = at(r, 109_000).centre!;
    const target = { yaw: c0.yaw + shift.yaw, pitch: c0.pitch };
    const followedAt = r.seconds.find((s) => s.tMs > 110_000 && angularDistanceDeg(s.centre!, target) <= 1.5);
    expect(followedAt).toBeDefined();
    expect(followedAt!.tMs).toBeLessThanOrEqual(110_000 + 420_000);
    expect(d1(r, 110_000)).toEqual([]);
    expect(r.seconds.some((s) => s.tMs > 200_000 && s.tMs < followedAt!.tMs && s.distraction === 'widened')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The C4 carries (review-C4 and its rounds): the wrong small commit, the fatigue gate on a lowering commit, the
// curve search on admissible time, a translation too small to detect, a step then reading, a near-road phone.
// ---------------------------------------------------------------------------------------------------------

const within = (t: number, a: number, b: number) => t >= a && t < b;
const ev = (r: Run, kind: string) => r.events.filter((e) => e.kind === kind) as (DmsEvent & { cause?: string })[];
/** The first second from `fromMs` at which the centre is within 1.5° of `target` and stays there to the end. */
function settledAt(r: Run, fromMs: number, target: AnglePair): number | null {
  let found: number | null = null;
  for (const s of r.seconds) {
    if (s.tMs < fromMs) continue;
    const ok = s.centre !== null && angularDistanceDeg(s.centre, target) <= 1.5;
    if (ok && found === null) found = s.tMs;
    if (!ok) found = null;
  }
  return found;
}

describe('S-WRONG-SMALL-COMMIT (review-C4 deviation 4): a forced 4° wrong commit is followed back within 5 min (NC-C5-P)', () => {
  test('a translation with no angle change, a 90 s stare 4° off (committed), then normal driving: bias ≤ 1.5° within 5 min of the commit', () => {
    const r = play(
      drv((t, rr) => ({ ...(t >= 110 ? { posture: { box: { dx: 0.05, dy: 0 } } } : {}), ...(within(t, 110, 200) ? { gaze: { yaw: onRoad(rr).yaw + 4, pitch: onRoad(rr).pitch } } : {}) })),
      700
    );
    const commit = ev(r, 'posture_commit');
    expect(commit.length).toBeGreaterThanOrEqual(1);
    const c0 = at(r, 109_000).centre!;
    expect(angularDistanceDeg(at(r, commit[0]!.tMs + 1000).centre!, c0)).toBeGreaterThan(2.5); // the wrong commit
    const back = settledAt(r, commit[0]!.tMs, c0);
    expect(back).not.toBeNull();
    expect(back! - commit[0]!.tMs).toBeLessThanOrEqual(300_000);
  });
});

describe('the fatigue gate on a lowering commit (review-C4 §5, rev1 K1-C; NC-C5-F)', () => {
  /** A slide down the seat (the road 8° lower, the box down 0.05) at 110 s; `drowsy` adds a 1.2 s microsleep at 100 s. */
  const slide = (drowsy: boolean) =>
    drv((t) => ({ ...(drowsy && within(t, 100, 101.2) ? { openness: 0.1 } : {}), ...(t >= 110 ? { posture: { shift: { yaw: 0, pitch: -8 }, box: { dx: 0, dy: 0.05 } } } : {}) }));
  test('S-SLIDE-DROWSY: with the fatigue gate set (a microsleep 10 s before), the slide is fatigue evidence: no commit, c₀ kept, a head_slump', () => {
    const r = play(slide(true), 260);
    expect(ev(r, 'microsleep').length).toBeGreaterThanOrEqual(1);
    expect(ev(r, 'posture_commit')).toEqual([]);
    expect(ev(r, 'posture_revert').map((e) => e.cause)).toContain('fatigue');
    expect(ev(r, 'head_slump').length).toBeGreaterThanOrEqual(1);
    expect(angularDistanceDeg(at(r, 259_000).centre!, at(r, 109_000).centre!)).toBeLessThanOrEqual(1);
  });
  test('the control: the same slide, alert, commits 8° lower', () => {
    const r = play(slide(false), 260);
    const commit = ev(r, 'posture_commit');
    expect(commit.length).toBeGreaterThanOrEqual(1);
    const c0 = at(r, 109_000).centre!;
    expect(angularDistanceDeg(at(r, commit[0]!.tMs + 1000).centre!, { yaw: c0.yaw, pitch: c0.pitch - 8 })).toBeLessThanOrEqual(1.5);
  });
});

describe('S-P6-CURVE-120 (review-C4 deviation 5): the candidate search counts admissible time, capped at 300 s (NC-C5-C)', () => {
  test('a posture step 5 s into a 120 s curve at 4°/s: committed after the curve, bias ≤ 1.5°', () => {
    const shift = { yaw: 6, pitch: 0 };
    const r = play(drv((t) => ({ ...(within(t, 105, 225) ? { turnDegS: 4 } : {}), ...(t >= 110 ? { posture: { shift, box: { dx: 0.05, dy: 0 }, iodScale: 1.07 } } : {}) })), 400);
    const commit = ev(r, 'posture_commit');
    expect(commit.length).toBeGreaterThanOrEqual(1);
    expect(commit[0]!.tMs).toBeGreaterThan(225_000);
    const c0 = at(r, 104_000).centre!;
    expect(angularDistanceDeg(at(r, commit[0]!.tMs + 1000).centre!, { yaw: c0.yaw + shift.yaw, pitch: c0.pitch })).toBeLessThanOrEqual(1.5);
  });
  test('the cap: a posture step in a 6 min curve leaves the dual state at 300 s observed', () => {
    const r = play(drv((t) => ({ ...(within(t, 105, 465) ? { turnDegS: 4 } : {}), ...(t >= 110 ? { posture: { shift: { yaw: 6, pitch: 0 }, box: { dx: 0.05, dy: 0 }, iodScale: 1.07 } } : {}) })), 470);
    const dual = ev(r, 'posture_dual');
    const revert = ev(r, 'posture_revert');
    expect(dual.length).toBeGreaterThanOrEqual(1);
    expect(revert.length).toBeGreaterThanOrEqual(1);
    expect(['no_candidate', 'undecided']).toContain(revert[0]!.cause); // both limits are 300 s observed
    expect(revert[0]!.tMs - dual[0]!.tMs).toBeGreaterThanOrEqual(299_000);
    expect(revert[0]!.tMs - dual[0]!.tMs).toBeLessThanOrEqual(306_000);
  });
});

describe('S-P6-SMALLBOX (review-C4 round 1, deviation 3): a translation below the fit-uncertainty margin is followed by the rolling path', () => {
  test('a 6° step with a box shift of 0.03 and no IOD change: followed within 7 min with bias ≤ 1.5°, 0 false D1', () => {
    const shift = { yaw: 6, pitch: 0 };
    const r = play(drv((t) => (t >= 110 ? { posture: { shift, box: { dx: 0.03, dy: 0 } } } : null)), 110 + 480);
    const c0 = at(r, 109_000).centre!;
    const back = settledAt(r, 110_000, { yaw: c0.yaw + shift.yaw, pitch: c0.pitch });
    expect(back).not.toBeNull();
    expect(back!).toBeLessThanOrEqual(110_000 + 420_000);
    expect(d1(r, 110_000)).toEqual([]);
  });
});

describe('S-P6-THEN-READ (C4 approval carry): a real step, then a minute of 50 % dash reading (NC-R2b)', () => {
  test('followed within 7 min with bias ≤ 1.5°; D1 fires during the reading', () => {
    const shift = { yaw: 6, pitch: 0 };
    const r = play(
      drv((t) => ({ ...(t >= 110 ? { posture: { shift, box: { dx: 0.05, dy: 0 }, iodScale: 1.07 } } : {}), ...(within(t, 110, 170) && (t - 110) % 10 < 5 ? { gaze: rel(15, -14) } : {}) })),
      110 + 480
    );
    const c0 = at(r, 109_000).centre!;
    const back = settledAt(r, 110_000, { yaw: c0.yaw + shift.yaw, pitch: c0.pitch });
    expect(back).not.toBeNull();
    expect(back!).toBeLessThanOrEqual(110_000 + 420_000);
    expect(r.commands.some((c) => c.kind === 'distraction' && c.action === 'start' && c.tMs >= 110_000 && c.tMs < 175_000)).toBe(true);
  });
});

describe('S-LEAN-NEARPHONE (C4 approval carry): the phone mounted inside the road-centre circle', () => {
  // The synth's default camera sits about 3.4° from the road, inside the circle. A lean to tap it for 8 s every
  // 20 s over 2 min (the lean held throughout), then a 3 s lap glance at 240 s.
  test('a lap glance still alerts; any commit is pulled back within 5 min', () => {
    const camera = rel(-1.6, 3); // the camera, relative to the road (about (−1.6°, 3°) in the synth)
    const r = play(
      drv((t) => ({
        ...(t >= 110 && t < 230 ? { posture: { box: { dx: 0.03, dy: 0.03 }, iodScale: 1.1 } } : {}),
        ...(t >= 110 && t < 230 && (t - 110) % 20 < 8 ? { gaze: camera } : {}),
        ...(within(t, 240, 243) ? { gaze: rel(0, -40) } : {}),
      })),
      600
    );
    expect(r.commands.some((c) => c.kind === 'distraction' && c.action === 'start' && c.tMs >= 240_000 && c.tMs < 245_000)).toBe(true);
    const c0 = at(r, 109_000).centre!;
    for (const cm of ev(r, 'posture_commit')) {
      const back = settledAt(r, cm.tMs, c0);
      expect(back).not.toBeNull();
      expect(back! - cm.tMs).toBeLessThanOrEqual(300_000);
    }
  });
});
