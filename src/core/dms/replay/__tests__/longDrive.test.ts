// Task C9 (T9; design rev1 I8, rev2 §3.1; review-C5 the T9 carry; review-C9): S-2H-MANY, the cumulative bound.
// Two hours at 80 km/h, twenty posture steps of 3–10° in seeded directions (every 340 s from 300 s, the total kept
// within 12°), a slow drift of 0.3°/min between them, normal scanning with mirror checks every 15 s; alone, and with a
// navigation display watched 20 % or 40 % of the time (S-2H-MANY-DISPLAY: 1.5 s looks at a fixed point from the road).
//
// The synth's setup (stated, as the coordinator asked):
// - The PHONE MOUNT is 25° right of and 15° below the road (mountShift (−25°, 15°)), off the road as a real mount is.
//   With the synth's default camera about 3.6° from the road, a road that wanders by 10° or more reads as "the phone"
//   (the lean-to-phone guard) and no posture candidate can form. The mount's own box displacement is undone: a mounted
//   phone is aimed at the face, so the face box is centred.
// - A step's face box moves 0.012 of the image per degree of the step's angle and the IOD 0.4 % per degree of pitch,
//   so the cumulative posture stays physical (never off the frame); the drift is no translation (no box change).
// Measured (8 and 15 fps; the bias against the moving truth, outside the 90 s after each step): with no display
// 1.0–1.3°; with the displays 1.1–1.8° in 23 of 24 runs; (7°, −1°) 20 % plan 1 at 8 fps has one 5.5° step that
// commits at 95 s (its bias ≤ 2° from 95 s): the one exception, pinned at 95 s. Commit errors ≤ 1.7° (8 fps), ≤ 1.4°
// (15 fps). Re-measured after the Stage 1 robustness rules (S1): unchanged within 0.1°.
import { check, FULL, type Case } from '../__fixtures__/longDrive';

// The default suite: one drive (about 10 s); DMS_FULL: the whole matrix. The displays are in longDriveDisplay.test.ts.
describe('S-2H-MANY (T9; the display-free bound, root-caused: the rolling small follow runs through probation)', () => {
  const cases: Case[] = FULL ? [1, 2, 3].flatMap((seed) => [8, 15].map((fps) => ({ name: 'none', seed, fps, share: 0 }))) : [{ name: 'none', seed: 1, fps: 8, share: 0 }];
  test.each(cases)('plan $seed, $fps fps: the bias ≤ 2° outside the 90 s after each step; commits ≤ 1.8°; 0 D1', (c) => check(c));
});
