// The mount signature over recent TRACKING frames, and the step-test camera bump (plan §M3, C-6,
// rev1 I7 and m5). Pure helpers of the calibrator; bounded windows only.
import type { DmsConfig } from './config';
import type { MountSignature } from './profile';
import { median } from './stats';
import { RingBuffer } from './windows';

export interface MountSample {
  t: number;
  /** head pose, camera frame */
  yaw: number;
  pitch: number;
  roll: number;
  cx: number;
  cy: number;
  iod: number;
}

/** 30 fps is the most any capture state delivers; windows are sized from it. */
const MAX_FPS = 30;

export function signatureOf(samples: readonly MountSample[]): MountSignature | null {
  if (samples.length === 0) return null;
  const m = (k: keyof Omit<MountSample, 't'>) => median(samples.map((s) => s[k]));
  return { yawDeg: m('yaw'), pitchDeg: m('pitch'), rollDeg: m('roll'), boxCx: m('cx'), boxCy: m('cy'), iod: m('iod') };
}

/** The last `windowS` of TRACKING samples. */
export class SignatureWindow {
  private readonly ring: RingBuffer<MountSample>;

  constructor(private readonly windowS: number) {
    this.ring = new RingBuffer(Math.ceil(windowS * MAX_FPS) + 1);
  }

  push(s: MountSample): void {
    this.ring.push(s);
    this.ring.dropWhile((x) => x.t < s.t - this.windowS * 1000);
  }

  signature(): MountSignature | null {
    return signatureOf(this.ring.toArray());
  }

  clear(): void {
    this.ring.clear();
  }
}

/**
 * The step test (rev1 m5). Every 0.5 s, with the candidate change point c = now − halfWindow: the
 * medians of [c − halfWindow, c) and [c, now] differ by ≥ bumpAngleDeg in head yaw or pitch, AND the box
 * centre moved ≥ bumpBoxShift or the IOD ≥ bumpIodFrac, AND the angle's transition took ≤ bumpSpanS.
 * The step must be whole and settled (both window ends at their levels), and the transition time is
 * measured on the step's own scale (`transitionSeconds`). A slow drift is not a bump, and neither is a
 * head turn that leaves the face box where it was.
 */
export class StepBump {
  private readonly ring: RingBuffer<MountSample>;
  private nextCheck = Number.NEGATIVE_INFINITY;

  constructor(private readonly cfg: Pick<DmsConfig, 'calibration'>) {
    this.ring = new RingBuffer(Math.ceil(2 * cfg.calibration.bumpHalfWindowS * MAX_FPS) + 2);
  }

  clear(): void {
    this.ring.clear();
    this.nextCheck = Number.NEGATIVE_INFINITY;
  }

  /** Adds a TRACKING sample; true when a bump is detected (the window is then cleared). */
  push(s: MountSample): boolean {
    const c = this.cfg.calibration;
    const half = c.bumpHalfWindowS * 1000;
    this.ring.push(s);
    this.ring.dropWhile((x) => x.t < s.t - 2 * half);
    if (s.t < this.nextCheck) return false;
    this.nextCheck = s.t + 500;
    const all = this.ring.toArray();
    if (all.length < 8 || all[0]!.t > s.t - 2 * half + 1000) return false; // need (nearly) the full span
    const cut = s.t - half;
    const before = all.filter((x) => x.t < cut);
    const after = all.filter((x) => x.t >= cut);
    if (before.length < 4 || after.length < 4) return false;
    const med = (xs: MountSample[], k: keyof Omit<MountSample, 't'>) => median(xs.map((x) => x[k]));
    const dYaw = med(after, 'yaw') - med(before, 'yaw');
    const dPitch = med(after, 'pitch') - med(before, 'pitch');
    const key: 'yaw' | 'pitch' = Math.abs(dYaw) >= Math.abs(dPitch) ? 'yaw' : 'pitch';
    const step = key === 'yaw' ? dYaw : dPitch;
    if (Math.abs(step) < c.bumpAngleDeg) return false;
    // Only a whole, settled step is measured: the window's first and last bumpSpanS must sit at the old
    // and the new level (within 20 % of the step), so a check that cuts the transition never sees a
    // partial step.
    const head = all.filter((x) => x.t < all[0]!.t + c.bumpSpanS * 1000);
    const tail = all.filter((x) => x.t >= s.t - c.bumpSpanS * 1000);
    if (Math.abs(med(tail, key) - med(after, key)) > 0.2 * Math.abs(step)) return false;
    if (Math.abs(med(head, key) - med(before, key)) > 0.2 * Math.abs(step)) return false;
    const box = Math.hypot(med(after, 'cx') - med(before, 'cx'), med(after, 'cy') - med(before, 'cy'));
    const iodB = med(before, 'iod');
    const iod = iodB > 0 ? Math.abs(med(after, 'iod') - iodB) / iodB : 0;
    if (box < c.bumpBoxShift && iod < c.bumpIodFrac) return false;
    const span = transitionSeconds(all, key, med(before, key), step);
    if (span === null || span > c.bumpSpanS) return false;
    this.clear();
    return true;
  }
}

/**
 * How long the step's transition took: the time the signal spends between 20 % and 80 % of the step
 * (linear between samples, after a 5-sample running median so a one- or two-frame glance spike adds
 * nothing), divided by 0.6, which is the full duration of a linear ramp. A signal that dwells inside
 * the band (a slow drift) reads long, so the test errs toward "no bump".
 */
function transitionSeconds(xs: readonly MountSample[], key: 'yaw' | 'pitch', from: number, step: number): number | null {
  if (xs.length < 5) return null;
  const raw = xs.map((x) => (x[key] - from) / step);
  const p = raw.map((_, i) => median(raw.slice(Math.max(0, i - 2), Math.min(raw.length, i + 3))));
  let inBand = 0;
  for (let i = 1; i < xs.length; i++) {
    const a = p[i - 1]!;
    const b = p[i]!;
    const dt = xs[i]!.t - xs[i - 1]!.t;
    if (a === b) {
      if (a > 0.2 && a < 0.8) inBand += dt;
      continue;
    }
    const lo = Math.max(Math.min(a, b), 0.2);
    const hi = Math.min(Math.max(a, b), 0.8);
    if (hi > lo) inBand += ((hi - lo) / Math.abs(b - a)) * dt;
  }
  return inBand / 1000 / 0.6;
}
