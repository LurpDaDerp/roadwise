// Task C7 (review-C2 §3; rev4 §2.3.6; rev5 §2): the eye-mover reading drives, shared by reading.test.ts. An
// eye-mover (the head at 20 % of the gaze, lagging 200 ms) reads a lap phone at −40° or −45° in bouts of 3–8 s,
// separated by 1–2 s looks up at the road; the lid follows the gaze (lidGaze, the floor 0.17, a lag of 150 ms or
// 50 ms); in `blinkShare` of the bouts a blink lands on the saccade down. Before the bouts the driver either
// drives 120 s at 60 km/h (so the calibration, the EAR and the gate references exist) or not at all (C6-2's
// prior mode: no reference of any kind).
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import type { DmsAlertCommand } from '../../engine/alerts';
import { createDmsEngine, type DmsEvent } from '../../engine/engine';
import { rng } from '../../engine/__fixtures__/synth';
import { DEFAULT_INIT } from '../run';
import { blinkOpenness, onRoad, rel, synthDrive, type DriverState } from '../synth';

export interface ReadingOpts {
  /** the reading gaze pitch relative to the road centre (−40 or −45) */
  pitch: number;
  fps: number;
  lidLagS: number;
  /** the share of bouts with a blink on the saccade down (0.25) */
  blinkShare: number;
  /** the speed while reading: 0 (stopped at a light) or 60 */
  speedKmh: number;
  /** drive 120 s at 60 km/h first (a calibrated drive), or start reading at once (the prior mode) */
  calibrated: boolean;
  /** the synth's iris visibility threshold (0.2, or the C2 reviewer's 0.33) */
  irisMinLid: number;
  /** the head's share of the gaze (an eye-mover: 0.2) */
  headShare?: number;
  /** reading time, seconds (600) */
  seconds?: number;
  seed?: number;
  cfg?: DmsConfig;
}

export interface ReadingResult {
  bouts: { start: number; end: number; blink: boolean }[];
  events: DmsEvent[];
  commands: DmsAlertCommand[];
  /** closure episodes during the reading (the longest closedMs of each) */
  closures: number[];
  /** the reading start, seconds */
  t0: number;
  priorFrames: number;
  frames: number;
}

export function playReading(o: ReadingOpts): ReadingResult {
  const t0 = o.calibrated ? 120 : 5;
  const seconds = o.seconds ?? 600;
  const r = rng(o.seed ?? 7);
  const bouts: ReadingResult['bouts'] = [];
  for (let t = t0; t < t0 + seconds; ) {
    const len = 3 + 5 * r();
    bouts.push({ start: t, end: Math.min(t + len, t0 + seconds), blink: r() < o.blinkShare });
    t += len + 1 + r();
  }
  let bi = 0;
  // A bout without an injected blink has none on its saccade: a natural blink from 0.3 s before its start to 0.4 s
  // after it is dropped (it would be a blink on the saccade, which `blinkShare` controls).
  const onSaccade = (t: number) => bouts.some((b) => !b.blink && t >= b.start - 0.3 && t < b.start + 0.4);
  const driver = (t: number, rr: () => number): DriverState => {
    const blinkNow = t >= t0 && onSaccade(t) ? 1 : blinkOpenness(t);
    const base: DriverState = { gaze: onRoad(rr), openness: blinkNow, speedKmh: t < t0 ? 60 : o.speedKmh };
    if (t < t0) return base;
    while (bi < bouts.length - 1 && t >= bouts[bi]!.end + 1e-9 && t >= bouts[bi + 1]!.start) bi++;
    const b = bouts[bi]!;
    if (t < b.start || t >= b.end) return base;
    const openness = b.blink && t < b.start + 0.2 ? 0.1 : blinkNow;
    return { ...base, gaze: rel(0, o.pitch), openness };
  };
  const items = synthDrive({ fps: o.fps, seconds: t0 + seconds, seed: o.seed ?? 7, source: 'geometric', driver, motion: true, lidGaze: true, lidLagS: o.lidLagS, headShare: o.headShare ?? 0.2, irisMinLid: o.irisMinLid });
  const engine = createDmsEngine(o.cfg ?? (DEFAULT_DMS_CONFIG as DmsConfig), { ...DEFAULT_INIT, profile: null });
  const out: ReadingResult = { bouts, events: [], commands: [], closures: [], t0, priorFrames: 0, frames: 0 };
  let longest = 0;
  for (const it of items) {
    if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    engine.pushFrame(it.frame);
    const d = engine.drain();
    out.events.push(...d.events);
    out.commands.push(...d.commands);
    if (it.frame.tMs < t0 * 1000) continue;
    const s = engine.snapshot();
    out.frames++;
    if (s.priorMode) out.priorFrames++;
    if (s.closedMs > 0) longest = Math.max(longest, s.closedMs);
    else if (longest > 0) {
      out.closures.push(longest);
      longest = 0;
    }
  }
  return out;
}

export const sleepCriticals = (x: ReadingResult) => x.commands.filter((c) => c.tier === 3 && c.action === 'start' && (c.kind === 'microsleep' || c.kind === 'sleep' || c.kind === 'unresponsive'));
export const f1s = (x: ReadingResult) => x.events.filter((e) => e.kind === 'microsleep' && e.tMs >= x.t0 * 1000);
/** the bouts in which an F1 fired (from the bout's start to 1 s after its end) */
export const boutsWithF1 = (x: ReadingResult) => x.bouts.filter((b) => f1s(x).some((e) => e.tMs >= b.start * 1000 && e.tMs < (b.end + 1) * 1000)).length;
