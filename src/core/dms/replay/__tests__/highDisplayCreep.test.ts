// C9 round 3 (review-C9 R2-C; the user's "no drift over time"): after a correct pass, a display 7–9° ABOVE the road
// watched 40 or 60 % of the time for 15 min does not walk the centre toward it.
//
// At frame level such a display and the road form one mode, and `locate` from the window's peak lands between them;
// before C9 round 3 the rolling small follow walked the centre toward the display (the review measured 3.5–5.0° in 5 of
// 30 runs). Now, when a small follow is possible, the window's clusters are found on its half-second fixation medians
// at the block scale, and the follow reads the frames on the side of the cluster nearest the centre (NC-C9-C: the blend
// locate fails this file). Where the block clusters are ambiguous (one cluster away from the frame mode, or two about
// equally near the centre) the follow holds (NC-C9-H); a road-side mode agrees only with a road-side mode before it
// (NC-C9-S, S-DISPLAY-70); and the rule is off in probation after a posture commit (NC-C9-P, S-2H-MANY-DISPLAY).
//
// The drive (navStart's synth): 60 km/h straight, mirror checks every 15 s and the road for 1.3 s after each; the truth
// is each seed's display-free centre.
import { angularDistanceDeg } from '../../engine/angles';
import { firstCalS, navDrive, truthOf, worstAfterCal } from '../__fixtures__/navStart';

const DISPLAYS = [[6, 8], [0, 9], [10, 7], [0, 7], [4, 6]] as const;
const cases: [number, number, number, number][] = [];
for (const [y, p] of DISPLAYS) for (const share of [0.4, 0.6]) for (const seed of [1, 2, 3]) cases.push([y, p, share, seed]);

describe('S-HIGH-DISPLAY-CREEP (review-C9 R2-C; NC-C9-C): 30 runs, the display from 90 s (after a clean pass), 15 min', () => {
  // Measured: every first pass at 60 s, 0.5–1.1° off; the worst offset over the 15 min 0.5–1.3° (the blend follow, NC-C9-C:
  // up to 2.3°, over 2° in one run here).
  test.each(cases)('(%i°, %i°) at %f, seed %i: the worst offset after the pass ≤ 2.0°', (y, p, share, seed) => {
    const truth = truthOf(seed);
    const d = navDrive({ seed, share, at: { yaw: y, pitch: p }, displayFromS: 90, startS: 90 + 900, seconds: 90 + 900, roadAfterMirrorS: 1.3 });
    expect(firstCalS(d)).not.toBeNull();
    expect(firstCalS(d)!).toBeLessThanOrEqual(90);
    expect(angularDistanceDeg(d.passes[0]!.centre, truth)).toBeLessThanOrEqual(1.5);
    expect(worstAfterCal(d, truth)).toBeLessThanOrEqual(2);
  });
});

describe('S-HIGH-DISPLAY-CREEP, the review\'s runs (the display from the start, 15 min): a road pass does not creep', () => {
  // The review's own grid. With the pitch rule restored (R2-R) a 60 % display ≥ 8° above the road is often passed onto
  // or not passed at all (the KNOWN LIMIT, S-NAV-START-HIGH); those runs are outside this pin. Every run whose first pass
  // is on the road (≤ 1.5°) stays within 2.0° for 15 min. Measured: 14 such runs, 0.7–1.7°. The review's outlier, (0°, 7°) 60 %
  // seed 1 (a pass 1.3° off, then 2.8°: a one-cluster window whose block cluster was the DISPLAY let the blend follow
  // run), is now 1.4° (the follow holds on that window).
  test.each(cases)('(%i°, %i°) at %f, seed %i', (y, p, share, seed) => {
    const truth = truthOf(seed);
    const d = navDrive({ seed, share, at: { yaw: y, pitch: p }, startS: 900, seconds: 900, roadAfterMirrorS: 1.3 });
    if (firstCalS(d) === null || angularDistanceDeg(d.passes[0]!.centre, truth) > 1.5) return;
    expect(worstAfterCal(d, truth)).toBeLessThanOrEqual(2);
  });
});
