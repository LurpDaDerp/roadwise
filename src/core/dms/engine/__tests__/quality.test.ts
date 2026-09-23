// Per-frame quality (plan §M2, C-22): LOST / HEAD_ONLY / TRACKING, the single definition of a reliable
// eye, and the near eye.
import { DEFAULT_DMS_CONFIG as C } from '../config';
import { classifyQuality, eyeReliable, eyeUsable, nearEye } from '../quality';
import { eye, frame } from '../__fixtures__/synth';

const q = (f: Parameters<typeof frame>[0]) => classifyQuality(frame(f), C);

describe('LOST', () => {
  test('no face', () => {
    expect(q({ tMs: 0, face: false })).toMatchObject({ quality: 'lost', reasons: ['no_face'] });
  });
  test('no face in the dark is low light (frameLuma < 25)', () => {
    expect(q({ tMs: 0, face: false, frameLuma: 24 }).reasons).toEqual(['no_face', 'low_light']);
    expect(q({ tMs: 0, face: false, frameLuma: 25 }).reasons).toEqual(['no_face']);
  });
  test('a box smaller than 1 % of the frame', () => {
    expect(q({ tMs: 0, box: { cx: 0.5, cy: 0.5, w: 0.09, h: 0.1 } })).toMatchObject({ quality: 'lost', reasons: ['small_face'] });
    expect(q({ tMs: 0, box: { cx: 0.5, cy: 0.5, w: 0.1, h: 0.1 } }).quality).toBe('tracking');
  });
  test('a face darker than 25', () => {
    expect(q({ tMs: 0, faceLuma: 24.9 })).toMatchObject({ quality: 'lost', reasons: ['dark_face'] });
  });
});

describe('HEAD_ONLY', () => {
  test('|head yaw| > 40°', () => {
    expect(q({ tMs: 0, head: { yaw: 40.1, pitch: 0, roll: 0 } })).toMatchObject({ quality: 'head_only', reasons: ['head_yaw'] });
    expect(q({ tMs: 0, head: { yaw: -40.1, pitch: 0, roll: 0 } }).quality).toBe('head_only');
    expect(q({ tMs: 0, head: { yaw: 40, pitch: 0, roll: 0 } }).quality).toBe('tracking');
  });
  test('blur < 15, face luma < 50, a missing pose', () => {
    expect(q({ tMs: 0, blur: 14.9 }).reasons).toEqual(['blur']);
    expect(q({ tMs: 0, faceLuma: 49.9 }).reasons).toEqual(['dim_face']);
    expect(q({ tMs: 0, poseMissing: true }).reasons).toEqual(['pose_missing']);
  });
  test('glare on one eye keeps TRACKING; both eyes out → HEAD_ONLY (C-22)', () => {
    expect(q({ tMs: 0, eyeR: { sat: 0.4 } })).toMatchObject({ quality: 'tracking', reliableR: false, reliableL: true, usableR: false });
    expect(q({ tMs: 0, eyeR: { sat: 0.4 }, eyeL: { sat: 0.4 } })).toMatchObject({ quality: 'head_only', reasons: ['eyes_unreliable'] });
    expect(q({ tMs: 0, eyeR: null, eyeL: { luma: 0.3 } })).toMatchObject({ quality: 'head_only', reasons: ['eyes_unreliable'] });
    // An open eye whose iris is not found is still usable: TRACKING, with the head as the gaze.
    expect(q({ tMs: 0, eyeR: null, eyeL: { irisIn: false } })).toMatchObject({ quality: 'tracking', reliableL: false, usableL: true });
  });
});

describe('eyeReliable: the single definition (§M2, rev2 R1-I1)', () => {
  test.each([
    ['dark (luma ratio 0.44)', { luma: 0.44 }],
    ['low iris contrast (11.9)', { irisContrast: 11.9 }],
    ['glare (26 % saturated)', { sat: 0.26 }],
    ['narrow (9.9 px)', { widthPx: 9.9 }],
    ['iris outside the contour', { irisIn: false }],
  ])('%s is unreliable', (_n, over) => {
    expect(eyeReliable(eye(over), C)).toBe(false);
  });
  test('the edges themselves are reliable, and a clipped eye (null) is not', () => {
    expect(eyeReliable(eye({ luma: 0.45, irisContrast: 12, sat: 0.25, widthPx: 10 }), C)).toBe(true);
    expect(eyeReliable(null, C)).toBe(false);
  });
});

test('nearEye: the eye with the larger corner width; null with no eyes', () => {
  expect(nearEye(frame({ tMs: 0, eyeR: { widthPx: 20 }, eyeL: { widthPx: 30 } }))).toBe('l');
  expect(nearEye(frame({ tMs: 0, eyeR: { widthPx: 31 }, eyeL: { widthPx: 30 } }))).toBe('r');
  expect(nearEye(frame({ tMs: 0, eyeR: null, eyeL: { widthPx: 5 } }))).toBe('l');
  expect(nearEye(frame({ tMs: 0, eyeR: null, eyeL: null }))).toBeNull();
});

describe('two tiers (T6 review C1): usable eyes judge openness, reliable eyes judge gaze', () => {
  test('a closed eye (iris contrast ≈ 0, iris outside the collapsed contour) is usable but not reliable', () => {
    const closed = eye({ ear: 0.05, irisContrast: 2, irisIn: false });
    expect(eyeUsable(closed, C)).toBe(true);
    expect(eyeReliable(closed, C)).toBe(false);
  });
  test('both eyes closed stays TRACKING (closure rules must see it)', () => {
    expect(q({ tMs: 0, ear: [0.05, 0.05] })).toMatchObject({ quality: 'tracking', usableR: true, usableL: true, reliableR: false, reliableL: false });
  });
  test('glare and darkness still fail the usable tier', () => {
    expect(eyeUsable(eye({ sat: 0.26 }), C)).toBe(false);
    expect(eyeUsable(eye({ luma: 0.44 }), C)).toBe(false);
    expect(eyeUsable(eye({ widthPx: 9.9 }), C)).toBe(false);
    expect(eyeUsable(null, C)).toBe(false);
  });
});
