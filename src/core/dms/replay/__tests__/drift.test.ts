// Task C5 (design rev2 §2.3.1, §2.3.3; rev1 I1; the engine reviewer's texting probe): slow drift, the rolling
// path and the slow uncorroborated path, and the guards that keep a texting driver from pulling the centre.
// Through the engine façade with motion evidence (the synth's face geometry on).
import { angularDistanceDeg } from '../../engine/angles';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import type { DmsAlertCommand } from '../../engine/alerts';
import { createDmsEngine, type DmsEvent, type DmsSnapshot } from '../../engine/engine';
import type { AnglePair } from '../../engine/types';
import { DEFAULT_INIT } from '../run';
import { gauss } from '../../engine/__fixtures__/synth';
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
  seconds: { tMs: number; centre: AnglePair | null; distraction: DmsSnapshot['distraction']; health: DmsSnapshot['health']['gaze']; calReason: DmsSnapshot['calReason'] }[];
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
      run.seconds.push({ tMs: it.frame.tMs, centre: s.centre.gaze, distraction: s.distraction, health: s.health.gaze, calReason: s.calReason });
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
    // C7 round 1 (review-C7 C7-3): a reader of the road-adjacent phone does not degrade health (no +5° on D1).
    expect(r.seconds.every((s) => s.health === 'good')).toBe(true);
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
/** Ordinary mirror checks: the rear mirror at 5 s and the driver mirror at 11 s of every 15 s (0.8 s each). */
const mirrors = (t: number): Partial<DriverState> => (t % 15 >= 5 && t % 15 < 5.8 ? { gaze: rel(27, 10) } : t % 15 >= 11 && t % 15 < 11.8 ? { gaze: rel(-45, 0) } : {});
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

describe('S-P6-SMALLBOX (review-C4 round 1, deviation 3): a translation below the fit-uncertainty margin is followed by the rolling path (with ordinary mirror checks: C5 round 1)', () => {
  test('a 6° step with a box shift of 0.03 and no IOD change: followed within 7 min with bias ≤ 1.5°, 0 false D1', () => {
    const shift = { yaw: 6, pitch: 0 };
    const r = play(drv((t) => ({ ...mirrors(t), ...(t >= 110 ? { posture: { shift, box: { dx: 0.03, dy: 0 } } } : {}) })), 110 + 480);
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
      drv((t) => ({ ...mirrors(t), ...(t >= 110 ? { posture: { shift, box: { dx: 0.05, dy: 0 }, iodScale: 1.07 } } : {}), ...(within(t, 110, 170) && (t - 110) % 10 < 5 ? { gaze: rel(15, -14) } : {}) })),
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

// ---------------------------------------------------------------------------------------------------------
// C5 round 1 (review-C5): a display watched most of the time is not a road; the 40 % reader's bound; the
// fatigue gate on a phone-ward commit.
// ---------------------------------------------------------------------------------------------------------

/** The review's attack: attentive at 80 km/h until calibrated (120 s), then `share` of every `periodS` at `target`, a driver-mirror check every 20 s. */
function watcher(target: AnglePair, share: number, periodS: number) {
  return drv((t) => {
    if (t % 20 >= 10 && t % 20 < 10.8) return { gaze: rel(-45, 0) };
    return t >= 120 && (t - 120) % periodS < share * periodS ? { gaze: rel(target.yaw, target.pitch) } : null;
  }, 80);
}
/** The centre's max and final shift from the calibrated one (at 119 s). */
function shifts(r: Run, untilS: number) {
  const c0 = at(r, 119_000).centre!;
  const d = r.seconds.filter((s) => s.tMs >= 120_000 && s.centre !== null).map((s) => angularDistanceDeg(s.centre!, c0));
  return { max: Math.max(...d), final: angularDistanceDeg(at(r, untilS * 1000).centre!, c0) };
}

describe('S-DISPLAY-70 (review-C5 C5-1; NC-C5-S4, NC-C5-S2+S4): a display watched 70 % of the time never pulls the centre', () => {
  const CASES = ([
    ['(7°, −1°)', { yaw: 7, pitch: -1 }],
    ['(14°, −8°)', { yaw: 14, pitch: -8 }],
    ['(16°, −4°)', { yaw: 16, pitch: -4 }],
  ] as const).flatMap(([n, target]) => [11, 12, 13].map((seed) => [n, seed, target] as const));
  test.each(CASES)('%s, seed %i: 12 min, max shift ≤ 2.5°, no slow dual state; health never degraded (C7-3, NC-C7-3)', (_, seed, target) => {
    const r = play(watcher(target, 0.7, 3), 120 + 720, { seed });
    expect(shifts(r, 839).max).toBeLessThanOrEqual(2.5);
    expect(ev(r, 'posture_dual').filter((e) => e.cause === 'slow')).toEqual([]);
    // C7 round 1 (review-C7 C7-3): the road is still watched 30 %, c₀ is not vacated beyond noise: D1 keeps its zones.
    expect(r.seconds.every((s) => s.health === 'good')).toBe(true);
  });
});

describe('C5-1 rules one at a time (NC-C5-S1, NC-C5-S2)', () => {
  test('S-U16-CAP (NC-C5-S1): an uncorroborated 16° shift is beyond the slow path (12.5°): never followed by it', () => {
    const shift = { yaw: 16, pitch: 0 };
    const r = play(drv((t) => ({ ...mirrors(t), ...(t >= 110 ? { posture: { shift } } : {}) })), 110 + 600);
    expect(ev(r, 'posture_dual').filter((e) => e.cause === 'slow')).toEqual([]);
    const c0 = at(r, 109_000).centre!;
    expect(angularDistanceDeg(at(r, 709_000).centre!, c0)).toBeLessThanOrEqual(2.5);
  });
  /** A display watched 90 % of the time, except the 2 s after each driver-mirror check, when the driver looks at the road. */
  function roadAfterMirrors(target: AnglePair) {
    return drv((t) => {
      if (t % 20 >= 10 && t % 20 < 10.8) return { gaze: rel(-45, 0) };
      if (t % 20 >= 10.8 && t % 20 < 12.8) return null;
      return t >= 120 ? { gaze: rel(target.yaw, target.pitch) } : null;
    }, 80);
  }
  test.each([
    ['(7°, −1°), the rolling large path', { yaw: 7, pitch: -1 }],
    ['(10°, −6°), the slow path', { yaw: 10, pitch: -6 }],
  ] as const)('S-DISPLAY-90-RETURNS (NC-C5-S2) %s: the driver returns to the road after every mirror check: no follow, no slow dual', (_, target) => {
    const r = play(roadAfterMirrors(target), 120 + 720, { seed: 11 });
    expect(shifts(r, 839).max).toBeLessThanOrEqual(2.5);
    expect(ev(r, 'posture_dual').filter((e) => e.cause === 'slow')).toEqual([]);
  });
});

describe('C5 round 2 (R1-a): an uncorroborated shift at 8 fps is followed (return fixation noise; NC-C5-R95)', () => {
  /** An uncorroborated shift (the angles only) at 110 s, ordinary mirror checks, 10 min at 8 fps: the bias at the end. */
  const bias = (shift: AnglePair) => {
    const r = play(drv((t) => ({ ...mirrors(t), ...(t >= 110 ? { posture: { shift } } : {}) })), 110 + 600, { fps: 8, seed: 11 });
    const c0 = at(r, 109_000).centre!;
    return angularDistanceDeg(at(r, 709_000).centre!, { yaw: c0.yaw + shift.yaw, pitch: c0.pitch + shift.pitch });
  };
  test('S-U5.5-8FPS: 5.5° yaw: followed, bias ≤ 1.5° at the end', () => {
    expect(bias({ yaw: 5.5, pitch: 0 })).toBeLessThanOrEqual(1.5);
  });
  // Task C7 (the binding carry; review-C5 Round 1 (d), Round 2): the road 7° up puts road frames above the forward
  // road; the false D1 warnings void the admitted samples ±30 s, which locked the rolling path out (the test was
  // test.failing until T7). Health's own window is never voided: H2 sees the offset, the zones widen, the warnings
  // stop, and the rolling path follows.
  test('S-U7-UP-8FPS: 7° up: health degraded ≤ 60 s after the shift, 0 D1 after it (HUD widened), followed (bias ≤ 1.5°), health recovers', () => {
    const shift = { yaw: 0, pitch: 7 };
    const r = play(drv((t) => ({ ...mirrors(t), ...(t >= 110 ? { posture: { shift } } : {}) })), 110 + 600, { fps: 8, seed: 11 });
    const deg = r.seconds.find((s) => s.tMs > 110_000 && s.health === 'degraded');
    expect(deg).toBeDefined();
    expect(deg!.tMs).toBeLessThanOrEqual(110_000 + 60_000);
    // the zones widen from the next frame on (the widening reads the health of the frame before)
    const after = at(r, deg!.tMs + 1000);
    expect(after.distraction).toBe('widened');
    expect(after.calReason).toBe('recalibrating');
    expect(d1(r, deg!.tMs)).toEqual([]);
    const c0 = at(r, 109_000).centre!;
    expect(angularDistanceDeg(at(r, 709_000).centre!, { yaw: c0.yaw + shift.yaw, pitch: c0.pitch + shift.pitch })).toBeLessThanOrEqual(1.5);
    expect(at(r, 709_000).health).toBe('good');
  });
});

describe('S-40-DISPLAY (review-C5 deviation 1; NC-C5-K): a 40 % reader at an on-road display moves the centre ≤ 2.5°, ending ≤ 1.5°', () => {
  test.each([11, 12, 13])('seed %i: 1.5 s on, 2.25 s off at (8°, −4°) for 10 min', (seed) => {
    const r = play(watcher({ yaw: 8, pitch: -4 }, 0.4, 3.75), 120 + 600, { seed });
    const sh = shifts(r, 719);
    expect(sh.max).toBeLessThanOrEqual(2.5);
    expect(sh.final).toBeLessThanOrEqual(1.5);
  });
});

describe('a phone-ward commit needs the fatigue gate clear (review-C5 §4; NC-C5-F2)', () => {
  // The mount 25° right and 15° below the road, so the camera is off the road; the step moves the road 8° toward it.
  const toward = (drowsy: boolean) =>
    drv((t) => ({
      mountShift: { yaw: -25, pitch: 15 },
      ...(drowsy && within(t, 100, 101.2) ? { openness: 0.1 } : {}),
      ...(t >= 110 ? { posture: { shift: { yaw: 8, pitch: 0 }, box: { dx: 0.05, dy: 0 }, iodScale: 1.07 } } : {}),
    }));
  test('drowsy (a microsleep 10 s before): no commit, posture_revert(fatigue), c₀ kept', () => {
    const r = play(toward(true), 260);
    expect(ev(r, 'microsleep').length).toBeGreaterThanOrEqual(1);
    expect(ev(r, 'posture_commit')).toEqual([]);
    expect(ev(r, 'posture_revert').map((e) => e.cause)).toContain('fatigue');
    expect(angularDistanceDeg(at(r, 259_000).centre!, at(r, 109_000).centre!)).toBeLessThanOrEqual(1);
  });
  test('the control, alert: committed 8° over', () => {
    const r = play(toward(false), 260);
    expect(ev(r, 'posture_commit').length).toBeGreaterThanOrEqual(1);
  });
});

describe('Task C7: the gaze accuracy monitor (rev2 §2.4; review-C5 Round 1 (d): S-U7-NOMIRROR; NC-K2a)', () => {
  // A driver who never checks a mirror never gets a large rolling follow (C5 (d)): the residual is safe only because
  // health widens. The shift stays uncorrected (health never re-centres), the HUD says so, and no false D1 sounds.
  test.each([8, 15])('S-U7-NOMIRROR at %i fps: 7° up, no mirror checks: degraded ≤ 60 s, 0 D1 after it, widened to the end; never re-centred', (fps) => {
    const shift = { yaw: 0, pitch: 7 };
    const r = play(drv((t) => (t >= 110 ? { posture: { shift } } : null)), 110 + 600, { fps, seed: 11 });
    const deg = r.seconds.find((s) => s.tMs > 110_000 && s.health === 'degraded');
    expect(deg).toBeDefined();
    expect(deg!.tMs).toBeLessThanOrEqual(110_000 + 60_000);
    expect(d1(r, deg!.tMs)).toEqual([]);
    expect(r.seconds.filter((s) => s.tMs > deg!.tMs).every((s) => s.distraction === 'widened' && s.health === 'degraded')).toBe(true);
    // health never re-centres (NC-K2a): the centre stays well short of the 7° shift
    expect(angularDistanceDeg(at(r, 109_000).centre!, at(r, 709_000).centre!)).toBeLessThanOrEqual(2.5);
  });
  test('S-HEALTH-CLEAN: 30 min of ordinary driving with mirror checks: never degraded, the HUD full', () => {
    const r = play(drv((t) => mirrors(t)), 1800, { seed: 12 });
    expect(r.seconds.filter((s) => s.tMs > 120_000).every((s) => s.health === 'good')).toBe(true);
  });
  test('S-TEXT and the texting probe read no calibration fault: health stays good', () => {
    const r = play(
      drv((t) => {
        if (t < 100) return null;
        const k = (t - 100) % 9;
        return k < 2.5 ? { gaze: rel(0, -12) } : k >= 4.5 && k < 7 ? { gaze: rel(5, -35) } : null;
      }),
      700
    );
    expect(r.seconds.every((s) => s.health === 'good')).toBe(true);
  });
});


describe('C7 round 2 (review-C7 R1-H): health sees a shift of a road wider than Stage 1 measured (NC-C7-3c)', () => {
  // The road's spread after the shift raised by an extra per-frame σ (night noise, a wider scan): the excess test uses
  // the window's own spread, and beyond the radius a c₀ with no cluster of its own is vacated.
  const cases: [string, AnglePair, number, number, boolean][] = [];
  for (const [name, shift] of [['S-U7-WIDE 7° up', { yaw: 0, pitch: 7 }], ['S-U9-WIDE 9° up', { yaw: 0, pitch: 9 }], ['S-U9-WIDE 9° right', { yaw: 9, pitch: 0 }]] as const)
    for (const extra of [3, 4.5]) for (const fps of [8, 15]) for (const withMirrors of [true, false]) cases.push([name, shift, extra, fps, withMirrors]);
  test.each(cases)('%s (%o), +%f° spread, %i fps, mirror checks %s: degraded ≤ 60 s after the shift, 0 D1 after 60 s', (_, shift, extra, fps, withMirrors) => {
    const driver: DriverFn = (t, r) => {
      const g = onRoad(r);
      const gaze = t >= 110 ? { yaw: g.yaw + extra * gauss(r), pitch: g.pitch + extra * gauss(r) } : g;
      return { gaze, openness: blinkOpenness(t), speedKmh: 60, ...(withMirrors ? mirrors(t) : {}), ...(t >= 110 ? { posture: { shift } } : {}) };
    };
    const r = play(driver, 110 + 600, { fps, seed: 11 });
    const deg = r.seconds.find((s) => s.tMs > 110_000 && s.health === 'degraded');
    expect(deg).toBeDefined();
    expect(deg!.tMs).toBeLessThanOrEqual(110_000 + 60_000);
    expect(d1(r, 110_000 + 60_000)).toEqual([]);
  });
});

describe('C7 round 2 (R1-H): S-DISPLAY-70-SCAN, a display read across (3° jitter) at 14° and 16°: never degraded', () => {
  test.each([
    [{ yaw: 14, pitch: -8 }, 11],
    [{ yaw: 14, pitch: -8 }, 12],
    [{ yaw: 16, pitch: -4 }, 11],
    [{ yaw: 16, pitch: -4 }, 12],
  ] as const)('%o, seed %i', (target, seed) => {
    const r = play(
      drv((t, rr) => {
        if (t % 20 >= 10 && t % 20 < 10.8) return { gaze: rel(-45, 0) };
        return t >= 120 && (t - 120) % 3 < 2.1 ? { gaze: rel(target.yaw + 3 * gauss(rr), target.pitch + 3 * gauss(rr)) } : null;
      }, 80),
      120 + 720,
      { seed }
    );
    expect(r.seconds.every((s) => s.health === 'good')).toBe(true);
  });
});
