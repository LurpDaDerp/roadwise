// Task C9 (T9; review-C9 "Stage 1 robustness", S1-2): S-WARM-NAV-DUAL. An UNVERIFIED profile (adopted at the warm
// start, not yet verified by the seed windows) with the S-NAV-START starts: displays at (9°, −6°), (14°, −8°), (0°, −15°)
// and a phone at the camera (the phone mount 25° right of and 15° below the road, mountShift (−25°, 15°)), watched 20,
// 40, 60 or 85 % of every 10 s for the first 60 s or 120 s, then normal driving; mirror checks every 15 s. The profile
// is a clean 300 s drive's (seed 1, the same mount); the truth is each seed's display-free centre.
//
// A window disagrees only with the seed vacated beyond noise, and never from the Stage 1 window's other cluster
// (NC-S1-2): the centre never goes onto the screen, and the seed is verified or correctly replaced by 180 s.
// Measured: verified at 13–22 s at ≤ 60 % (47–92 s at 85 %, 133–141 s for the phone at 85 % with a 120 s start), and
// the centre correct throughout. A 'seed' dual state opens in two of the 96 drives ((0°, −15°) 85 %, seed 3, at 57 s:
// two windows wholly on the display before Stage 1 knows its two clusters); its road (S1-1) is the seed itself, so it
// reverts when its search window fills (67 s) and the seed verifies (75 s, 92 s).
import { angularDistanceDeg } from '../../engine/angles';
import type { DmsProfileV1 } from '../../engine/profile';
import { AT_CAMERA, navDrive, truthOf } from '../__fixtures__/navStart';

const DISPLAYS: [string, { yaw: number; pitch: number }, boolean][] = [
  ['(9°, −6°)', { yaw: 9, pitch: -6 }, false],
  ['(14°, −8°)', { yaw: 14, pitch: -8 }, false],
  ['(0°, −15°)', { yaw: 0, pitch: -15 }, false],
  ['the phone at the camera', AT_CAMERA, true],
];

const profiles = new Map<boolean, DmsProfileV1>();
beforeAll(() => {
  for (const camera of [false, true]) profiles.set(camera, navDrive({ seed: 1, share: 0, at: { yaw: 0, pitch: 0 }, camera, startS: 0, seconds: 300 }).profile!);
});

interface Case {
  name: string;
  at: { yaw: number; pitch: number };
  camera: boolean;
  share: number;
  startS: number;
  seed: number;
}
const cases: Case[] = [];
for (const [name, at, camera] of DISPLAYS) for (const share of [0.2, 0.4, 0.6, 0.85]) for (const startS of [60, 120]) for (const seed of [2, 3, 4]) cases.push({ name, at, camera, share, startS, seed });

describe('S-WARM-NAV-DUAL (review-C9 S1-2; NC-S1-2): an unverified profile through a navigation start', () => {
  test.each(cases)('$name, $share, a $startS s start, seed $seed: never onto the screen; verified or replaced by 180 s', (c) => {
    const truth = truthOf(c.seed, c.camera);
    const d = navDrive({ seed: c.seed, share: c.share, at: c.at, camera: c.camera, startS: c.startS, seconds: 200, profile: profiles.get(c.camera)! });
    expect(d.events.filter((e) => e.kind === 'warm_start')).toHaveLength(1);
    // never onto the screen (every display is ≥ 9° away): no commit, and the centre stays on the road throughout
    expect(d.events.filter((e) => e.kind === 'posture_commit')).toEqual([]);
    for (const s of d.seconds) if (s.centre !== null) expect(angularDistanceDeg(s.centre, truth)).toBeLessThanOrEqual(2);
    // verified or correctly replaced (a pass) by 180 s
    const settled = d.events.some((e) => (e.kind === 'seed_verified' || e.kind === 'calibrated') && e.tMs <= 180_000);
    expect(settled).toBe(true);
    const at180 = d.seconds.find((s) => s.tMs >= 180_000)!.centre!;
    expect(angularDistanceDeg(at180, truth)).toBeLessThanOrEqual(1.5);
  });
});
