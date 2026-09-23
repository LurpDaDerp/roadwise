// Random drives for the seeded property tests (plan Task 12): a random frame rate from {5, 8, 10, 15, 30},
// random segments of attentive driving, glances, closures, nods, LOST runs, head turns into LOST (C-8),
// lenses and face absence, over a random speed profile with stops, GNSS losses and turns, with random
// frame gaps. Deterministic in the seed. Test tooling.
import { gauss, rng } from '../engine/__fixtures__/synth';
import type { GazeSource } from '../engine/types';
import { TARGET } from './scenarios';
import { blinkOpenness, onRoad, rel, synthDrive, type DriverState, type SynthItem } from './synth';

export const PROPERTY_FPS = [5, 8, 10, 15, 30] as const;

type Seg = { until: number; kind: 'road' | 'glance' | 'closure' | 'nod' | 'lost' | 'c8' | 'lens' | 'absent'; target?: DriverState['gaze'] };
type Leg = { until: number; speed: number | null; turn: number };

export interface RandomDrive {
  seed: number;
  fps: number;
  source: GazeSource;
  items: SynthItem[];
}

/** One random drive of `seconds`. */
export function randomDrive(seed: number, seconds: number): RandomDrive {
  const r = rng(seed);
  const fps = PROPERTY_FPS[Math.floor(r() * PROPERTY_FPS.length)]!;
  const source: GazeSource = r() < 0.5 ? 'geometric' : 'net';
  const targets = Object.values(TARGET);
  const segs: Seg[] = [];
  for (let t = 0; t < seconds; ) {
    const u = r();
    const kind: Seg['kind'] = u < 0.5 ? 'road' : u < 0.7 ? 'glance' : u < 0.78 ? 'closure' : u < 0.83 ? 'nod' : u < 0.9 ? 'lost' : u < 0.94 ? 'c8' : u < 0.97 ? 'lens' : 'absent';
    const len = kind === 'road' ? 2 + r() * 20 : kind === 'closure' ? 0.2 + r() * 7 : kind === 'nod' ? 1.1 : kind === 'lost' || kind === 'absent' ? 0.5 + r() * 15 : kind === 'lens' ? 5 + r() * 30 : 0.3 + r() * 4;
    t += len;
    segs.push({ until: t, kind, target: targets[Math.floor(r() * targets.length)] });
  }
  const legs: Leg[] = [];
  for (let t = 0; t < seconds; ) {
    const u = r();
    const len = 5 + r() * 60;
    t += len;
    legs.push({ until: t, speed: u < 0.1 ? null : u < 0.25 ? r() * 12 : u < 0.4 ? 10 + r() * 20 : 30 + r() * 90, turn: r() < 0.2 ? (r() - 0.5) * 30 : 0 });
  }
  // Frame gaps: a few dropped stretches.
  const gaps: [number, number][] = [];
  for (let k = 0; k < Math.floor(seconds / 30); k++) {
    const g0 = r() * seconds;
    gaps.push([g0, g0 + 0.3 + r() * 3]);
  }
  let si = 0;
  let li = 0;
  const all = synthDrive({
    fps,
    seconds,
    seed,
    source,
    driver: (t, rr) => {
      while (si < segs.length - 1 && t >= segs[si]!.until) si++;
      while (li < legs.length - 1 && t >= legs[li]!.until) li++;
      const seg = segs[si]!;
      const leg = legs[li]!;
      const base: DriverState = { gaze: onRoad(rr), openness: blinkOpenness(t), speedKmh: leg.speed, turnDegS: leg.turn };
      const into = t - (si > 0 ? segs[si - 1]!.until : 0);
      switch (seg.kind) {
        case 'glance':
          return { ...base, gaze: seg.target! };
        case 'closure':
          return { ...base, openness: 0.1 };
        case 'nod': {
          const p = into < 0.5 ? (-20 * into) / 0.5 : into < 0.8 ? -20 : -20 + (20 * (into - 0.8)) / 0.3;
          return { ...base, gaze: rel(0, p), openness: 0.35 };
        }
        case 'lost':
          return { ...base, face: false };
        case 'c8':
          return into < 0.3 ? { ...base, gaze: rel(-85, 0), head: rel(-70 * (into / 0.3), 0) } : { ...base, face: false };
        case 'lens':
          return { ...base, lens: true };
        case 'absent':
          return { ...base, face: false, speedKmh: 0 };
        default:
          return { ...base, gaze: { yaw: base.gaze.yaw + 0.5 * gauss(rr), pitch: base.gaze.pitch } };
      }
    },
  });
  // A row on a dropped frame still arrives (rows come from the drive engine): the frame is dropped and its
  // row moves onto the next kept frame.
  const out: SynthItem[] = [];
  let pendingRow: SynthItem['row'];
  for (const it of all) {
    const dropped = gaps.some(([a, b]) => it.frame.tMs / 1000 >= a && it.frame.tMs / 1000 < b);
    if (dropped) {
      pendingRow = it.row ?? pendingRow;
      continue;
    }
    out.push(pendingRow !== undefined && it.row === undefined ? { ...it, row: pendingRow } : it);
    pendingRow = undefined;
  }
  return { seed, fps, source, items: out };
}
