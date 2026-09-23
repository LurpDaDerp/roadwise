// The driver profile (plan §M3): DmsProfileV1, validated field by field on load, and the mount
// signature comparison (C-6 tolerances; driver change at ±15 % IOD or 0.15 box).
import { createCalibrator } from '../calibration';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import { compareSignatures, mountMatches, parseProfile, type DmsProfileV1 } from '../profile';
import { perceive, roadSampler, stream } from '../__fixtures__/harness';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const MOUNT = { yawDeg: 1, pitchDeg: -2, rollDeg: 0.5, boxCx: 0.5, boxCy: 0.45, iod: 0.2 };
const GOOD: DmsProfileV1 = {
  v: 1,
  driverSide: 'right',
  orientation: 270,
  mount: MOUNT,
  gazeCentres: { geometric: { yaw: -3, pitch: 2 }, net: { yaw: 1, pitch: 0 } },
  headCentre: { yaw: 0, pitch: 1 },
  rollOffsetDeg: 2,
  radiusDeg: 9,
  openEyeEar: [0.31, null],
  neutralMar: 0.06,
  neutralMouthW: 0.9,
  learnedZones: [{ id: 'rear_mirror', yawDeg: 27, pitchDeg: 8, halfYawDeg: 5, halfPitchDeg: 4, drives: 3 }],
  savedAtMs: 1_700_000_000_000,
};

test('a valid profile parses to an equal object (and survives JSON)', () => {
  expect(parseProfile(JSON.parse(JSON.stringify(GOOD)))).toEqual(GOOD);
  const noNet = { ...GOOD, gazeCentres: { geometric: GOOD.gazeCentres.geometric } };
  expect(parseProfile(noNet)).toEqual(noNet);
});

test.each([
  ['not an object', null],
  ['a wrong version', { ...GOOD, v: 2 }],
  ['a bad driver side', { ...GOOD, driverSide: 'middle' }],
  ['a bad orientation', { ...GOOD, orientation: 45 }],
  ['a non-finite mount field', { ...GOOD, mount: { ...MOUNT, iod: Number.NaN } }],
  ['a non-positive IOD', { ...GOOD, mount: { ...MOUNT, iod: 0 } }],
  ['no gaze centre at all', { ...GOOD, gazeCentres: {} }],
  ['a centre out of range', { ...GOOD, headCentre: { yaw: 200, pitch: 0 } }],
  ['a radius outside [8, 15]', { ...GOOD, radiusDeg: 20 }],
  ['an EAR pair of the wrong length', { ...GOOD, openEyeEar: [0.3] }],
  ['a negative EAR', { ...GOOD, openEyeEar: [-0.3, 0.3] }],
  ['a neutral MAR below the floor', { ...GOOD, neutralMar: 0.01 }],
  ['a learned zone with an unknown id', { ...GOOD, learnedZones: [{ ...GOOD.learnedZones[0], id: 'lap' }] }],
  ['an unknown key', { ...GOOD, extra: 1 }],
  ['a missing key', (() => { const { savedAtMs: _s, ...rest } = GOOD; return rest; })()],
])('refuses %s', (_n, value) => {
  expect(parseProfile(value)).toBeNull();
});

describe('signatures', () => {
  test('within the C-6 tolerances they match', () => {
    expect(mountMatches(MOUNT, { ...MOUNT, yawDeg: 4.9, rollDeg: 3.4, boxCx: 0.54, iod: 0.21 }, C)).toBe(true);
    expect(compareSignatures(MOUNT, MOUNT, C)).toEqual({ match: true, driverChange: false });
  });
  test('a mismatch is a driver change only at ≥ 15 % IOD or ≥ 0.15 box', () => {
    expect(compareSignatures(MOUNT, { ...MOUNT, yawDeg: 8 }, C)).toEqual({ match: false, driverChange: false });
    expect(compareSignatures(MOUNT, { ...MOUNT, iod: 0.2 * 1.16 }, C)).toEqual({ match: false, driverChange: true });
    expect(compareSignatures(MOUNT, { ...MOUNT, iod: 0.2 * 1.14 }, C)).toEqual({ match: false, driverChange: false });
    expect(compareSignatures(MOUNT, { ...MOUNT, boxCy: 0.61 }, C)).toEqual({ match: false, driverChange: true });
  });
});

test('toProfile after calibration round-trips through parseProfile', () => {
  const cal = createCalibrator(C, { driverSide: 'left' });
  perceive(C, cal, stream({ fps: 15, seconds: 90, sample: roadSampler({ yaw: -3, pitch: 2 }) }));
  const p = cal.toProfile(123)!;
  expect(p).not.toBeNull();
  expect(p.driverSide).toBe('left');
  expect(p.orientation).toBe(90);
  expect(parseProfile(JSON.parse(JSON.stringify(p)))).toEqual(p);
  // No profile before a pass: nothing learned to save.
  expect(createCalibrator(C, { driverSide: 'left' }).toProfile(1)).toBeNull();
});
