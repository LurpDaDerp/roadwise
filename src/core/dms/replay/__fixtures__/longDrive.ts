// Task C9 (T9): the S-2H-MANY drive (see longDrive.test.ts for the scenario and its stated synth setup).
import { angularDistanceDeg } from '../../engine/angles';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import type { DmsAlertCommand } from '../../engine/alerts';
import { createDmsEngine, type DmsEvent } from '../../engine/engine';
import { drvToCam, rng } from '../../engine/__fixtures__/synth';
import type { AnglePair } from '../../engine/types';
import { DEFAULT_INIT } from '../run';
import { blinkOpenness, CAMERA_BOX_PER_DEG, onRoad, rel, synthDrive, type DriverFn } from '../synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
export const FULL = process.env.DMS_FULL === '1';

/** One posture step: when, the angle shift, the face box move and the IOD scale. */
export interface Step {
  tS: number;
  shift: AnglePair;
  box: { dx: number; dy: number };
  iodScale: number;
}

/** The plan of a drive: `n` steps from `firstS`, every `everyS`, 3–10° in seeded directions, the total kept within 12°. */
export function plan(seed: number, n: number, firstS: number, everyS: number): { steps: Step[]; drift: AnglePair[] } {
  const r = rng(seed * 7919 + 3);
  const steps: Step[] = [];
  const drift: AnglePair[] = [];
  let cum = { yaw: 0, pitch: 0 };
  for (let k = 0; k < n; k++) {
    const mag = 3 + 7 * r();
    let a = 2 * Math.PI * r();
    let s = { yaw: mag * Math.cos(a), pitch: mag * Math.sin(a) };
    // keep the seat within reach: a step that would take the total past 12° goes the other way
    if (Math.hypot(cum.yaw + s.yaw, cum.pitch + s.pitch) > 12) {
      s = { yaw: -s.yaw, pitch: -s.pitch };
      a += Math.PI;
    }
    cum = { yaw: cum.yaw + s.yaw, pitch: cum.pitch + s.pitch };
    // the face box moves with a translation (C4's steps: 0.04 at 3°, 0.06 at 10°), in a seeded direction
    const b = 2 * Math.PI * r();
    const boxC = 0.03 + 0.003 * mag;
    steps.push({ tS: firstS + k * everyS, shift: s, box: { dx: boxC * Math.cos(b), dy: boxC * Math.sin(b) }, iodScale: 1 + (r() < 0.5 ? -1 : 1) * 0.005 * mag });
    const d = 2 * Math.PI * r();
    drift.push({ yaw: Math.cos(d), pitch: Math.sin(d) });
  }
  return { steps, drift };
}

/** The driver's total shift at t (seconds): the steps so far plus the drift, 0.3°/min along each segment's direction. */
export function shiftAt(p: ReturnType<typeof plan>, t: number): AnglePair {
  const rate = 0.3 / 60;
  let yaw = 0;
  let pitch = 0;
  for (let k = 0; k < p.steps.length; k++) {
    const s = p.steps[k]!;
    if (t < s.tS) break;
    yaw += s.shift.yaw;
    pitch += s.shift.pitch;
    const end = k + 1 < p.steps.length ? p.steps[k + 1]!.tS : Number.POSITIVE_INFINITY;
    const dt = Math.min(t, end) - s.tS;
    yaw += rate * dt * p.drift[k]!.yaw;
    pitch += rate * dt * p.drift[k]!.pitch;
  }
  return { yaw, pitch };
}

/** The mount's own box displacement, undone (a mounted phone is aimed at the face: the box is centred). */
export const MOUNT_BOX = (() => {
  const cam = drvToCam({ yaw: -25, pitch: 15 }, 'left');
  return { dx: -CAMERA_BOX_PER_DEG * cam.yaw, dy: CAMERA_BOX_PER_DEG * cam.pitch };
})();

/**
 * The seat's translation: the face box moves with the steps' angle shift (0.012 of the image per degree, the C4
 * steps' scale) and the IOD by 0.4 % per degree of pitch (nearer when lower), so a drive's cumulative posture stays
 * a physical one (bounded with the angle, never off the frame). The drift is not a translation (no box change).
 */
export function postureAt(p: ReturnType<typeof plan>, t: number) {
  let yaw = 0;
  let pitch = 0;
  for (const s of p.steps) {
    if (t < s.tS) break;
    yaw += s.shift.yaw;
    pitch += s.shift.pitch;
  }
  return { shift: shiftAt(p, t), box: { dx: MOUNT_BOX.dx + 0.012 * yaw, dy: MOUNT_BOX.dy - 0.012 * pitch }, iodScale: 1 - 0.004 * pitch };
}

/** Mirror checks: the driver's mirror every 15 s, the rear-view mirror every 15 s (as the C5 drift tests). */
export const mirrors = (t: number): AnglePair | null => (t % 15 >= 5 && t % 15 < 5.8 ? rel(27, 10) : t % 15 >= 11 && t % 15 < 11.8 ? rel(-45, 0) : null);

/** The phone on the dash, about 25° right of and 15° below the road (as the C5 phone-ward test): off the road. */
export const MOUNT: AnglePair = { yaw: -25, pitch: 15 };

export function driver(p: ReturnType<typeof plan>, displayShare: number, at: AnglePair = { yaw: 8, pitch: -4 }): DriverFn {
  return (t, r) => {
    const m = mirrors(t);
    // the display: 1.5 s of every 1.5 / share s, from 120 s (after the calibration)
    const period = displayShare > 0 ? 1.5 / displayShare : 0;
    const onDisplay = displayShare > 0 && t >= 120 && m === null && (t - 120) % period < 1.5;
    return { gaze: m ?? (onDisplay ? rel(at.yaw, at.pitch) : onRoad(r)), openness: blinkOpenness(t), speedKmh: 80, posture: postureAt(p, t), mountShift: MOUNT };
  };
}

export interface Run {
  events: DmsEvent[];
  commands: DmsAlertCommand[];
  /** once a second */
  seconds: { tMs: number; centre: AnglePair | null }[];
  /** the centre on the frame after each posture_commit */
  commits: { tMs: number; centre: AnglePair }[];
}

export function play(d: DriverFn, seconds: number, fps: number, seed: number, cfg: DmsConfig = C): Run {
  const items = synthDrive({ fps, seconds, seed, source: 'geometric', driver: d, motion: true });
  const engine = createDmsEngine(cfg, DEFAULT_INIT);
  const run: Run = { events: [], commands: [], seconds: [], commits: [] };
  let next = 0;
  let pendingCommit: number | null = null;
  for (const it of items) {
    if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    engine.pushFrame(it.frame);
    const out = engine.drain();
    run.events.push(...out.events);
    run.commands.push(...out.commands);
    if (out.events.some((e) => e.kind === 'posture_commit')) pendingCommit = it.frame.tMs;
    else if (pendingCommit !== null) {
      const c = engine.snapshot().centre.gaze;
      if (c !== null) run.commits.push({ tMs: pendingCommit, centre: c });
      pendingCommit = null;
    }
    if (it.frame.tMs >= next) {
      next += 1000;
      run.seconds.push({ tMs: it.frame.tMs, centre: engine.snapshot().centre.gaze });
    }
  }
  return run;
}

export interface Verdict {
  maxSettledBias: number;
  commitErrors: number[];
  d1: number;
  commits: number;
  reverts: number;
  duals: number;
  unsettled: number[];
  /** per step: seconds from the step until the bias is ≤ 2° for the rest of its segment (null: never) */
  settleS: (number | null)[];
}

/** The bias against the truth (the centre at t0 moved by the driver's shift since), in the settled part of each segment. */
export function verdict(r: Run, p: ReturnType<typeof plan>, t0: number, settleS: number): Verdict {
  const at = (tMs: number) => [...r.seconds].reverse().find((s) => s.tMs <= tMs)!;
  const c0 = at(t0 * 1000).centre!;
  const truth = (tS: number) => {
    const sh = shiftAt(p, tS);
    return { yaw: c0.yaw + sh.yaw, pitch: c0.pitch + sh.pitch };
  };
  let maxB = 0;
  const unsettled: number[] = [];
  for (const s of r.seconds) {
    const tS = s.tMs / 1000;
    if (tS <= t0 || s.centre === null) continue;
    const last = [...p.steps].reverse().find((st) => st.tS <= tS);
    if (last !== undefined && tS < last.tS + settleS) continue;
    const b = angularDistanceDeg(s.centre, truth(tS));
    if (b > maxB) maxB = b;
    if (b > 2) unsettled.push(Math.round(tS));
  }
  const settle = p.steps.map((st, k) => {
    const end = k + 1 < p.steps.length ? p.steps[k + 1]!.tS : r.seconds[r.seconds.length - 1]!.tMs / 1000;
    const seg = r.seconds.filter((x) => x.tMs / 1000 >= st.tS && x.tMs / 1000 < end && x.centre !== null);
    let last: number | null = null;
    for (const x of seg) if (angularDistanceDeg(x.centre!, truth(x.tMs / 1000)) > 2) last = x.tMs / 1000;
    if (last === null) return 0;
    return last >= end - 1 ? null : Math.round(last + 1 - st.tS);
  });
  return {
    settleS: settle,
    maxSettledBias: maxB,
    commitErrors: r.commits.map((c) => angularDistanceDeg(c.centre, truth(c.tMs / 1000))),
    d1: r.commands.filter((c) => c.kind === 'distraction' && c.action === 'start' && c.tMs > t0 * 1000).length,
    commits: r.events.filter((e) => e.kind === 'posture_commit').length,
    reverts: r.events.filter((e) => e.kind === 'posture_revert').length,
    duals: r.events.filter((e) => e.kind === 'posture_dual').length,
    unsettled,
  };
}


export interface Case {
  name: string;
  seed: number;
  fps: number;
  share: number;
  at?: AnglePair;
  settleS?: number;
}
export function check(c: Case): void {
  const p = plan(c.seed, 20, 300, 340);
  const r = play(driver(p, c.share, c.at), 300 + 20 * 340, c.fps, 10 + c.seed);
  const v = verdict(r, p, 290, c.settleS ?? 90);
  expect(v.maxSettledBias).toBeLessThanOrEqual(2);
  expect(Math.max(...v.commitErrors)).toBeLessThanOrEqual(1.8);
  expect(v.d1).toBe(0);
}

