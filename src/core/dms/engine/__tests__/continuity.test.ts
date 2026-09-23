// Continuity across camera gaps (plan §M3, rev1 I7, rev2 R1-m2 / R1-I1): the mount signature before a
// pause or a long SEARCH, the comparison after the resume, driver change vs camera bump, the provisional
// EAR re-derived on any mismatch, the openness sanity reset, and the rotation change.
import { createCalibrator, type Calibrator } from '../calibration';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import { perceiver, roadSampler, stream } from '../__fixtures__/harness';
import type { FrameSpec } from '../__fixtures__/synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const TRUTH = { yaw: -3, pitch: 2 };

/** Calibrated on 90 s of driving (EAR 0.3, MAR 0.08), then a pause at 90 s. */
function beforeGap(): { cal: Calibrator; run: ReturnType<typeof perceiver> } {
  const cal = createCalibrator(C, { driverSide: 'left' });
  const run = perceiver(C, cal);
  run(stream({ fps: 15, seconds: 90, seed: 3, sample: roadSampler(TRUTH) }));
  expect(cal.state()).toBe('calibrated');
  cal.drainEvents();
  cal.markGap(90_000);
  return { cal, run };
}

/** Resumes at 120 s with frames changed by `over`. */
function resume(cal: Calibrator, run: ReturnType<typeof perceiver>, seconds: number, over: Partial<FrameSpec> & { earScale?: number } = {}) {
  const { earScale = 1, ...spec } = over;
  run(
    stream({
      fps: 15,
      seconds,
      fromMs: 120_000,
      seed: 9,
      sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), ear: [0.3 * earScale, 0.3 * earScale], ...spec }),
    })
  );
  return cal.drainEvents().map((e) => e.kind);
}

test('the same driver after a pause: no event, calibration kept', () => {
  const { cal, run } = beforeGap();
  expect(resume(cal, run, 12)).toEqual([]);
  expect(cal.state()).toBe('calibrated');
  expect(cal.resumeChecking()).toBe(false);
});

test('during the first 5 s after the resume the check is pending (zones widen, D2/D3 off downstream)', () => {
  const { cal, run } = beforeGap();
  resume(cal, run, 2);
  expect(cal.resumeChecking()).toBe(true);
});

test('a different IOD after a pause → driver_change: fresh Stage 1 and fresh EAR/MAR baselines', () => {
  const { cal, run } = beforeGap();
  expect(cal.neutralMar()).not.toBeNull();
  const events = resume(cal, run, 6, { iod: 0.2 * 1.2 });
  expect(events).toContain('driver_change');
  expect(cal.state()).toBe('recalibrating');
  expect(cal.centre('geometric')).toBeNull();
  expect(cal.neutralMar()).toBeNull();
});

test('a shifted box with the same IOD → camera_bump: MAR kept, the provisional EAR re-derived (rev2 R1-m2)', () => {
  const { cal, run } = beforeGap();
  const mar = cal.neutralMar();
  expect(cal.openEyeEar()).toEqual({ r: 0.3, l: 0.3 });
  expect(resume(cal, run, 6, { box: { cx: 0.58, cy: 0.45 }, earScale: 1.2 })).toContain('camera_bump');
  expect(cal.state()).toBe('recalibrating');
  expect(cal.neutralMar()).toBe(mar);
  // The old EAR holds until the new one exists (20 s of TRACKING after the resume)…
  expect(cal.openEyeEar()).toEqual({ r: 0.3, l: 0.3 });
  const later = createLaterRun(cal, run, 22, { box: { cx: 0.58, cy: 0.45 }, earScale: 1.2 });
  expect(later.r!).toBeCloseTo(0.36, 9);
});

function createLaterRun(cal: Calibrator, run: ReturnType<typeof perceiver>, seconds: number, over: Partial<FrameSpec> & { earScale?: number }) {
  const { earScale = 1, ...spec } = over;
  run(
    stream({
      fps: 15,
      seconds,
      fromMs: 126_000,
      seed: 10,
      sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), ear: [0.3 * earScale, 0.3 * earScale], ...spec }),
    })
  );
  return cal.openEyeEar()!;
}

describe('the openness sanity check after every resume (rev2 R1-m2)', () => {
  test.each([
    [0.5, true],
    [1.5, true],
    [0.61, false],
    [1.39, false],
  ])('median openness %s → baseline_reset: %s', (scale, reset) => {
    const { cal, run } = beforeGap();
    const events = resume(cal, run, 12, { earScale: scale });
    expect(events.includes('baseline_reset')).toBe(reset);
    expect(events).not.toContain('camera_bump');
    // Never null (T6 review I3): at once the p90 of the sanity window's raw EARs.
    expect(cal.openEyeEar()).not.toBeNull();
    if (reset) expect(cal.openEyeEar()!.r!).toBeCloseTo(0.3 * scale, 9);
    else expect(cal.openEyeEar()).toEqual({ r: 0.3, l: 0.3 });
  });

  test('closure keeps working through a reset: a 1.2 s closure 2 s after it is seen (T6 review I3)', () => {
    const { cal, run } = beforeGap();
    const eyes = (t: number): [number, number] => (t >= 132 && t < 133.2 ? [0.02, 0.02] : [0.15, 0.15]);
    const out = run(stream({ fps: 15, seconds: 16, fromMs: 120_000, seed: 9, sample: (t) => ({ gazeDrv: TRUTH, headDrv: { yaw: 0, pitch: 0 }, ear: eyes(t) }) }));
    expect(cal.drainEvents().map((e) => e.kind)).toContain('baseline_reset');
    const nulls = out.filter((p) => p.tMs > 120_000 && cal.openEyeEar() === null);
    expect(nulls).toHaveLength(0);
    const during = out.filter((p) => p.tMs >= 132_000 && p.tMs < 133_200);
    expect(during.some((p) => p.eyesClosed && p.closedMs >= 1000)).toBe(true);
  });

  test('the interim EAR is replaced by the re-derived one at 20 s', () => {
    const { cal, run } = beforeGap();
    run(stream({ fps: 15, seconds: 12, fromMs: 120_000, seed: 9, sample: () => ({ gazeDrv: TRUTH, headDrv: { yaw: 0, pitch: 0 }, ear: [0.15, 0.15] }) }));
    expect(cal.openEyeEar()!.r!).toBeCloseTo(0.15, 9);
    run(stream({ fps: 15, seconds: 12, fromMs: 132_000, seed: 9, sample: () => ({ gazeDrv: TRUTH, headDrv: { yaw: 0, pitch: 0 }, ear: [0.18, 0.18] }) }));
    const e = cal.openEyeEar()!;
    expect(e.r!).toBeCloseTo(0.18, 9); // the 20 s collection's p90: the later, higher values
  });
});

test('a second pause before the comparison finishes keeps the first signature (T6 review I1)', () => {
  const { cal, run } = beforeGap();
  // 3 s of another driver (a different IOD), then another stop before 5 s of TRACKING
  run(stream({ fps: 15, seconds: 3, fromMs: 120_000, seed: 9, sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), iod: 0.24 }) }));
  cal.markGap(123_000);
  run(stream({ fps: 15, seconds: 6, fromMs: 140_000, seed: 10, sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), iod: 0.24 }) }));
  expect(cal.drainEvents().map((e) => e.kind)).toContain('driver_change');
});

test('a rotation change across a pause is one camera_bump, with no second bump or driver change from the comparison (T6 review m3)', () => {
  const { cal, run } = beforeGap();
  run(stream({ fps: 15, seconds: 8, fromMs: 120_000, seed: 9, sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), rotationDeg: 270, box: { cx: 0.62, cy: 0.3 } }) }));
  expect(cal.drainEvents().map((e) => e.kind)).toEqual(['camera_bump']);
  expect(cal.neutralMar()).not.toBeNull();
});


test('a rotationDeg change mid-drive (90 → 270) is a camera_bump (rev2 R1-I1)', () => {
  const cal = createCalibrator(C, { driverSide: 'left' });
  const run = perceiver(C, cal);
  run(stream({ fps: 15, seconds: 90, seed: 3, sample: roadSampler(TRUTH) }));
  cal.drainEvents();
  run(stream({ fps: 15, seconds: 2, fromMs: 90_000, sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), rotationDeg: 270 }) }));
  expect(cal.drainEvents().map((e) => e.kind)).toContain('camera_bump');
  expect(cal.state()).toBe('recalibrating');
});

test('a long SEARCH (≥ 30 s without TRACKING) is a gap too, without markGap', () => {
  const cal = createCalibrator(C, { driverSide: 'left' });
  const run = perceiver(C, cal);
  run(stream({ fps: 15, seconds: 90, seed: 3, sample: roadSampler(TRUTH) }));
  cal.drainEvents();
  run(stream({ fps: 5, seconds: 31, fromMs: 90_000, sample: () => ({ face: false }) }));
  run(stream({ fps: 15, seconds: 6, fromMs: 121_000, seed: 4, sample: (t, r) => ({ ...roadSampler(TRUTH)(t, r), iod: 0.25 }) }));
  expect(cal.drainEvents().map((e) => e.kind)).toContain('driver_change');
});
