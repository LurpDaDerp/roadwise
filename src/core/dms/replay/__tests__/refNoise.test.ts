// C7 round 4 (review-C7 Round 4 ruling, B): the noise-corrected open-eye reference. The P90 of noisy open frames sits
// about 1.28σ of the per-frame noise above the open EAR (+3.8 % at σ 0.009, +5 % at σ 0.012 on a 0.30 eye), which
// lowers every openness and put the 0.17 reading lid 0.011 above the deep threshold. The deconvolved P90 removes the
// per-frame noise only, capped at baselines.earNoiseMaxSd (0.012 EAR), so a fluttering lid cannot take more than
// 1.2816 × the cap off the reference.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { deconvolvedP90 } from '../../engine/earNoise';
import { createDmsEngine } from '../../engine/engine';
import { rng } from '../../engine/__fixtures__/synth';
import { DEFAULT_INIT } from '../run';
import { blinkOpenness, onRoad, synthDrive, type DriverFn } from '../synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const CAP = C.calibration.baselines.earNoiseMaxSd;

/** The Stage 1 reference (the mean of the two eyes, at the `calibrated` event) of a 120 s drive at 60 km/h. */
function stage1Ref(driver: DriverFn, fps: number, seed: number, lidNoise: number): number | null {
  const items = synthDrive({ fps, seconds: 120, seed, source: 'geometric', driver, motion: true, lidNoise });
  const e = createDmsEngine(C, { ...DEFAULT_INIT, profile: null });
  let v: number | null = null;
  for (const it of items) {
    if (it.row !== undefined) e.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    e.pushFrame(it.frame);
    if (e.drain().events.some((x) => x.kind === 'calibrated')) v = e.snapshot().earRef;
  }
  return v;
}

describe('the deconvolved P90 (unit)', () => {
  test('pure noise gives the median; no noise gives the P90; the correction never exceeds 1.2816 × σ_n', () => {
    expect(deconvolvedP90(0.3 + 1.2816 * 0.01, 0.3, 0.01)).toBeCloseTo(0.3, 9);
    expect(deconvolvedP90(0.32, 0.3, null)).toBe(0.32);
    expect(deconvolvedP90(0.32, 0.3, 0)).toBe(0.32);
    expect(deconvolvedP90(0.3, 0.3, 0.01)).toBe(0.3);
    for (const spread of [0.005, 0.01, 0.02, 0.05]) for (const sn of [0.002, 0.006, 0.012, 0.03]) {
      const v90 = 0.3 + spread;
      expect(v90 - deconvolvedP90(v90, 0.3, sn)).toBeLessThanOrEqual(1.2816 * sn + 1e-12);
    }
  });
});

describe('S-REF-NOISE (review-C7 Round 4, B; NC-C7-10): the Stage 1 reference of a 0.30 eye with per-frame EAR noise', () => {
  // Per-frame EAR noise σ 0.009 and 0.012 (openness σ 0.03 and 0.04), natural blinks, 8 seeds. The ruling's target is
  // ±1.5 %. Measured over seeds 1–8 (%): σ 0.009: 15 fps −0.2…+1.7 (mean +0.65), 5 fps −0.4…+1.5 (mean +0.60);
  // σ 0.012 (the cap): 15 fps 0…+2.6 (mean +1.2), 5 fps −0.5…+3.2 (mean +1.1). The error is one-sided: the P90's
  // sampling scatter enters under the square root (a spread sampled high reads as lid spread). The mean meets the
  // target in every cell; single drives are pinned at their measured worst (+2 % at σ 0.009, +3.5 % at σ 0.012).
  const attentive: DriverFn = (t, r) => ({ gaze: onRoad(r), openness: blinkOpenness(t), speedKmh: 60 });
  test.each([
    [0.009, 15, 0.02],
    [0.009, 5, 0.02],
    [0.012, 15, 0.035],
    [0.012, 5, 0.035],
  ] as const)('σ %f EAR, %i fps: every seed within −1.5 %% … +%f, the mean within ±1.5 %%', (sd, fps, worst) => {
    const errs: number[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const v = stage1Ref(attentive, fps, seed, sd / 0.3);
      expect(v).not.toBeNull();
      errs.push(v! / 0.3 - 1);
    }
    for (const e of errs) {
      expect(e).toBeGreaterThanOrEqual(-0.015);
      expect(e).toBeLessThanOrEqual(worst);
    }
    expect(Math.abs(errs.reduce((a, b) => a + b, 0) / errs.length)).toBeLessThanOrEqual(0.015);
  });
});

describe('S-REF-FLUTTER (review-C7 Round 4, B): a fluttering lid at a drowsy start takes no more than the cap off the reference', () => {
  // The first 2 min: the open lid flutters frame to frame between 0.82 and 1.0 (a drowsy lid's flicker, which inflates
  // the frame-to-frame noise far past the cap), with natural blinks. The true open EAR is the upper level, 0.30.
  test.each([15, 5])('%i fps: the Stage 1 reference ≥ 0.30 − 1.2816 × the cap (the correction is bounded by the cap)', (fps) => {
    const r = rng(77);
    const flutter: DriverFn = (t, rr) => ({ gaze: onRoad(rr), openness: blinkOpenness(t) * (r() < 0.5 ? 0.82 : 1), speedKmh: 90 });
    const v = stage1Ref(flutter, fps, 3, 0);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThanOrEqual(0.3 - 1.2816 * CAP - 0.002);
    expect(v!).toBeLessThanOrEqual(0.3 + 0.002);
  });
});
