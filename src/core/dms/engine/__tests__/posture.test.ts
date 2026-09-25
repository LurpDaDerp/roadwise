// Task C4 (design rev2 §2.3.0, §2.3.2; rev1 K1; rev4 §2.3.2a): the posture detector (rotation-compensated
// translation only; a head-angle step alone never counts; a settled pitch drop is a slump) and the relative
// statistics the dual-centre state decides on.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import { createPostureDetector, relativelyVacated, relativeRevert, shareNear, unimodal, type PostureSample } from '../posture';
import type { WeightedDir } from '../histogram';
import { gauss, rng } from '../__fixtures__/synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const FPS = 15;
/** How the synthetic face box follows a head turn (per degree), the relation the compensation learns. */
const K_BOX = 0.003;

interface Pose {
  yaw: number;
  pitch: number;
  /** translation added to the box (image fraction) */
  dx?: number;
  dy?: number;
  /** IOD scale from moving closer or farther */
  iodScale?: number;
}

/** Frames at 15 fps from pose(t): the box follows the head (K_BOX), the IOD is projected (cos yaw · cos pitch). */
function feed(pose: (t: number) => Pose, seconds: number, det = createPostureDetector(C), t0 = 0) {
  const out: { t: number; step: boolean; slump: boolean; onset: boolean; dBox: number; dIod: number }[] = [];
  for (let i = 0; i < seconds * FPS; i++) {
    const t = t0 + i / FPS;
    const p = pose(t);
    const s: PostureSample = {
      t: t * 1000,
      yaw: p.yaw,
      pitch: p.pitch,
      cx: 0.5 + K_BOX * p.yaw + (p.dx ?? 0),
      cy: 0.45 - K_BOX * p.pitch + (p.dy ?? 0),
      iod: 0.2 * (p.iodScale ?? 1) * Math.cos((p.yaw * Math.PI) / 180) * Math.cos((p.pitch * Math.PI) / 180),
    };
    const r = det.push(s);
    out.push({ t, step: r.step !== null, slump: r.slump, onset: r.onset, dBox: r.step === null ? 0 : Math.hypot(r.step.dBox.x, r.step.dBox.y), dIod: r.step?.dIodFrac ?? 0 });
  }
  return { out, det };
}

/** 60 s of ordinary driving: the head scans ±12° (so the compensation fit has something to learn), seeded. */
function scanning(seed = 1): (t: number) => Pose {
  const r = rng(seed);
  let yaw = 0;
  let pitch = 0;
  return (t) => {
    const phase = Math.floor(t / 2);
    const target = phase % 3 === 0 ? { yaw: 12 * Math.sin(phase), pitch: 4 * Math.cos(phase * 1.7) } : { yaw: 0, pitch: 0 };
    yaw += (target.yaw - yaw) * 0.3 + 0.3 * gauss(r);
    pitch += (target.pitch - pitch) * 0.3 + 0.2 * gauss(r);
    return { yaw, pitch };
  };
}
const steps = (o: ReturnType<typeof feed>['out']) => o.filter((x) => x.step);

describe('C4: the posture detector (translation only, rotation-compensated)', () => {
  test('a settled box translation of 0.05 is one step, 5–7 s after it (the settled test), with its size', () => {
    const base = scanning();
    const { out } = feed((t) => ({ ...base(t), ...(t >= 70 ? { dx: 0.05 } : {}) }), 90);
    const s = steps(out);
    expect(s).toHaveLength(1);
    expect(s[0]!.t).toBeGreaterThanOrEqual(74.5);
    expect(s[0]!.t).toBeLessThanOrEqual(77.5);
    expect(s[0]!.dBox).toBeGreaterThan(0.04);
    expect(s[0]!.dBox).toBeLessThan(0.06);
  });
  test('an IOD change of +8 % (moving closer) is a step', () => {
    const base = scanning(2);
    const s = steps(feed((t) => ({ ...base(t), ...(t >= 70 ? { iodScale: 1.08 } : {}) }), 90).out);
    expect(s).toHaveLength(1);
    expect(s[0]!.dIod).toBeGreaterThan(0.06);
  });
  test('S-TURN20 (unit; NC-K1a, NC-K1b): a 20° head turn held 8 s is no step: the box follows the head and the raw IOD falls 6 %', () => {
    const base = scanning(3);
    const { out } = feed((t) => (t >= 70 && t < 78 ? { yaw: 20, pitch: 0 } : base(t)), 95);
    expect(steps(out)).toEqual([]);
  });
  test('below the threshold (box 0.02, IOD 3 %) is no step', () => {
    const base = scanning(4);
    expect(steps(feed((t) => ({ ...base(t), ...(t >= 70 ? { dx: 0.02, iodScale: 1.03 } : {}) }), 90).out)).toEqual([]);
  });
  test('a slow drift (0.05 over 20 s) is not a step: the transition must take ≤ 4 s', () => {
    const base = scanning(5);
    expect(steps(feed((t) => ({ ...base(t), dx: t < 60 ? 0 : Math.min(0.05, ((t - 60) / 20) * 0.05) }), 100).out)).toEqual([]);
  });
  test('S-SLUMP (unit): the head pitch settles 5° lower with no translation: a slump, never a step', () => {
    const base = scanning(6);
    const { out } = feed((t) => {
      const b = base(t);
      return t >= 70 ? { ...b, pitch: b.pitch - 5, dy: K_BOX * 5 } : b; // the box moves only as the head rotation explains
    }, 90);
    expect(steps(out)).toEqual([]);
    expect(out.filter((x) => x.slump)).toHaveLength(1);
  });
  test('the onset: half the threshold within 2 s, held 1 s, is reported before the step is confirmed', () => {
    const base = scanning(7);
    const { out } = feed((t) => ({ ...base(t), ...(t >= 70 ? { dx: 0.05 } : {}) }), 90);
    const onset = out.find((x) => x.onset);
    const step = out.find((x) => x.step);
    expect(onset).toBeDefined();
    expect(onset!.t).toBeGreaterThanOrEqual(71);
    expect(onset!.t).toBeLessThan(step!.t);
  });
  test('clear() forgets the window (a stop is a gap): a step across it is never seen', () => {
    const base = scanning(8);
    const det = createPostureDetector(C);
    feed(base, 70, det);
    det.clear();
    const { out } = feed((t) => ({ ...base(t), dx: 0.05 }), 20, det, 70);
    expect(steps(out)).toEqual([]);
  });
});

describe('C4: the relative statistics (rev2 §2.3.0)', () => {
  /** A cluster of n directions around c with SD sigma (seeded). */
  const cluster = (c: { yaw: number; pitch: number }, sigma: number, n: number, seed = 1): WeightedDir[] => {
    const r = rng(seed);
    return Array.from({ length: n }, () => ({ yaw: c.yaw + sigma * gauss(r), pitch: c.pitch + sigma * gauss(r), w: 1 }));
  };
  test('shareNear: the weight share within r', () => {
    const d = [...cluster({ yaw: 0, pitch: 0 }, 0.5, 100), ...cluster({ yaw: 20, pitch: 0 }, 0.5, 100, 2)];
    expect(shareNear(d, { yaw: 0, pitch: 0 }, 3)).toBeCloseTo(0.5, 2);
  });
  test('relatively vacated: a 6° step at σ 4° vacates the old centre; a 3° step does not (the small-shift path decides it)', () => {
    const six = cluster({ yaw: 6, pitch: 0 }, 4, 2000);
    expect(relativelyVacated(six, { yaw: 0, pitch: 0 }, { yaw: 6, pitch: 0 }, 9, C)).toBe(true);
    const three = cluster({ yaw: 3, pitch: 0 }, 4, 2000);
    expect(relativelyVacated(three, { yaw: 0, pitch: 0 }, { yaw: 3, pitch: 0 }, 9, C)).toBe(false);
  });
  test('relative revert: the samples back at the old centre', () => {
    const back = cluster({ yaw: 0, pitch: 0 }, 4, 2000);
    expect(relativeRevert(back, { yaw: 0, pitch: 0 }, { yaw: 6, pitch: 0 }, 9, C)).toBe(true);
    expect(relativeRevert(cluster({ yaw: 6, pitch: 0 }, 4, 2000), { yaw: 0, pitch: 0 }, { yaw: 6, pitch: 0 }, 9, C)).toBe(false);
  });
  test('unimodal: one cluster yes; two separated clusters of similar weight no', () => {
    expect(unimodal(cluster({ yaw: 0, pitch: 0 }, 4, 2000), { yaw: 0, pitch: 0 }, 9, 4, C)).toBe(true);
    const two = [...cluster({ yaw: 0, pitch: 0 }, 2, 1000), ...cluster({ yaw: 14, pitch: 0 }, 2, 700, 3)];
    expect(unimodal(two, { yaw: 0, pitch: 0 }, 9, 2, C)).toBe(false);
  });
});
