// Task C9 (T9; review-C9): S-DISPLAY-STEP. A single 7° posture step during a 20 % display share is followed through
// the template translation (T9-2); when the search is forced to miss, the suspect path (T9-3: the posture seed check
// and a background Stage 1) recovers the centre. The drive, the phone mount (25° right, 15° below the road) and the
// box model are the S-2H-MANY fixture's.
import { angularDistanceDeg } from '../../engine/angles';
import { resolveDmsConfig } from '../../engine/config';
import type { AnglePair } from '../../engine/types';
import { rel } from '../synth';
import { driver, MOUNT_BOX, play, shiftAt, type Step } from '../__fixtures__/longDrive';

/** One step at 300 s, no drift. */
const onePlan = (shift: AnglePair): { steps: Step[]; drift: AnglePair[] } => ({
  steps: [{ tS: 300, shift, box: { dx: 0, dy: 0 }, iodScale: 1 }],
  drift: [{ yaw: 0, pitch: 0 }],
});
const DISPLAY = { yaw: 14, pitch: -8 };

describe('S-DISPLAY-STEP (review-C9): a 7° step during a 20 % display is followed within 90 s, ≤ 1.5° left', () => {
  test.each([
    [{ yaw: 5, pitch: -5 }, 1],
    [{ yaw: -7, pitch: 0 }, 2],
    [{ yaw: 0, pitch: 7 }, 3],
  ] as const)('%o, seed %i', (shift, seed) => {
    const p = onePlan(shift);
    const r = play(driver(p, 0.2, DISPLAY), 420, 8, 20 + seed);
    const at = (tMs: number) => [...r.seconds].reverse().find((x) => x.tMs <= tMs)!.centre!;
    const c0 = at(290_000);
    const sh = shiftAt(p, 390);
    expect(angularDistanceDeg(at(390_000), { yaw: c0.yaw + sh.yaw, pitch: c0.pitch + sh.pitch })).toBeLessThanOrEqual(1.5);
    expect(r.events.filter((e) => e.kind === 'posture_commit').length).toBeGreaterThanOrEqual(1);
  });
});

describe('S-DISPLAY-STEP-MISS (review-C9 T9-3; NC-T9-R): a step the search is forced to miss is recovered by the suspect path', () => {
  // templateMatchMin 1.01: no template candidate can form, so the dual state exits no_candidate. The centres are then
  // suspect: widened, re-verified, and a background Stage 1 replaces them (≤ 1.5° within 180 s of the step).
  test('no_candidate, posture_suspect, and the background pass', () => {
    const cfg = resolveDmsConfig({ calibration: { posture: { templateMatchMin: 1.01 } } });
    // A 10° step: beyond the rolling path's range (radiusMinDeg), and the slow path's relative peakedness is held
    // down by the display at (7°, −1°): without T9-3 nothing else recovers it. The box moves against the camera-step
    // signature (a seat translation, never read as a camera bump, whose pre-shift would recover it by itself).
    const p = onePlan({ yaw: 7, pitch: -7.1 });
    const base = driver(p, 0.2, { yaw: 7, pitch: -1 });
    const d = (t: number, rr: () => number) => {
      const b = base(t, rr);
      return t >= 300 ? { ...b, posture: { ...b.posture!, box: { dx: MOUNT_BOX.dx - 0.012 * 7, dy: MOUNT_BOX.dy - 0.012 * 7.1 } } } : b;
    };
    const r = play(d, 500, 8, 21, cfg);
    const kinds = r.events.map((e) => `${e.kind}${(e as { cause?: string }).cause ? '/' + (e as { cause?: string }).cause : ''}`);
    // the centre first (NC-T9-R: without the suspect path the step is never recovered), then the path it took
    const at = (tMs: number) => [...r.seconds].reverse().find((x) => x.tMs <= tMs)!.centre!;
    const c0 = at(290_000);
    const sh = shiftAt(p, 480);
    expect(angularDistanceDeg(at(480_000), { yaw: c0.yaw + sh.yaw, pitch: c0.pitch + sh.pitch })).toBeLessThanOrEqual(1.5);
    expect(kinds).toContain('posture_revert/no_candidate');
    expect(kinds).toContain('posture_suspect');
  });
});

describe('S-DISPLAY-80-LEAN (review-C9 T9-2 (c); NC-T9-T): a seat shift while a display is read 80 % of the time never commits onto it', () => {
  // A translation with no angle change (the box moves 0.05, the road stays) at 200 s, while the driver reads the
  // display at (14°, −8°) 8 s of every 10 s until 270 s, then drives normally. The display then fills the dual state's
  // window and matches the template's road peak shifted onto it (s ≈ 0.8): test (c) sees the road still watched at c₀
  // and refuses it.
  test('no commit moves the centre; ≤ 1.5° from the road at 400 s', () => {
    const d = (t: number, r: () => number) => {
      const base = driver(onePlan({ yaw: 0, pitch: 0 }), 0)(t, r);
      const lean = t >= 200 ? { posture: { ...base.posture!, box: { dx: base.posture!.box!.dx + 0.05, dy: base.posture!.box!.dy } } } : {};
      const reading = t >= 200 && t < 270 && (t - 200) % 10 < 8 ? { gaze: rel(8, -4) } : {};
      return { ...base, ...lean, ...reading };
    };
    const r = play(d, 420, 8, 25);
    const at = (tMs: number) => [...r.seconds].reverse().find((x) => x.tMs <= tMs)!.centre!;
    const c0 = at(190_000);
    for (const e of r.events.filter((x) => x.kind === 'posture_commit')) expect(angularDistanceDeg(at(e.tMs + 1000), c0)).toBeLessThanOrEqual(1.5);
    expect(angularDistanceDeg(at(400_000), c0)).toBeLessThanOrEqual(1.5);
  });
});
