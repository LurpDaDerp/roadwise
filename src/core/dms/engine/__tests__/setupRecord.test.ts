// The setup record: mirror zones from the prompts' gaze samples (within the learned-zone bounds), and the stored
// record validated field by field.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import { MIRROR_MIN_SAMPLES, mirrorZoneFromSamples, parseSetupRecord, SETUP_MIRRORS, type DmsSetupRecord } from '../setupRecord';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const SEED = { gazeCentres: { geometric: { yaw: 2, pitch: -3 }, net: null }, headCentre: { yaw: 1, pitch: -1 }, rollOffsetDeg: 0, mount: { yawDeg: -10, pitchDeg: 5, rollDeg: 0, boxCx: 0.5, boxCy: 0.45, iod: 0.2 }, orientation: 90 as const, openEyeEar: { r: 0.3, l: null } };

/** `n` samples around (yaw, pitch) with a small spread. */
const around = (yaw: number, pitch: number, n = 20, spread = 1.5) => Array.from({ length: n }, (_, i) => ({ yaw: yaw + ((i % 5) - 2) * (spread / 2), pitch: pitch + ((i % 3) - 1) * (spread / 2) }));

test('the three prompts measure the three mirrors (LHD: the left mirror is the driver’s)', () => {
  expect(SETUP_MIRRORS.map((m) => [m.prompt, m.id])).toEqual([
    ['left_mirror', 'driver_mirror'],
    ['right_mirror', 'passenger_mirror'],
    ['rear_mirror', 'rear_mirror'],
  ]);
});

test('a mirror zone: the median direction, half-widths within the learned bounds, promoted at once (drives = drivesToAdopt)', () => {
  const z = mirrorZoneFromSamples('driver_mirror', around(-42, -1), C)!;
  expect(z).not.toBeNull();
  expect(z.id).toBe('driver_mirror');
  expect(z.yawDeg).toBeCloseTo(-42, 0);
  expect(z.pitchDeg).toBeCloseTo(-1, 0);
  expect(z.halfYawDeg).toBeGreaterThanOrEqual(C.zones.ellipseMinHalfWidthDeg);
  expect(z.halfYawDeg).toBeLessThanOrEqual(C.zones.learnedMaxHalfWidthDeg);
  expect(z.drives).toBe(C.zones.drivesToAdopt);
  expect(mirrorZoneFromSamples('passenger_mirror', around(52, 0), C)!.id).toBe('passenger_mirror');
  expect(mirrorZoneFromSamples('rear_mirror', around(27, 10), C)!.id).toBe('rear_mirror');
});

test(`too few samples (< ${MIRROR_MIN_SAMPLES}), a look that stayed on the road, or one far from the default mirror: null (the default rectangle stays)`, () => {
  expect(mirrorZoneFromSamples('driver_mirror', around(-42, 0, MIRROR_MIN_SAMPLES - 1), C)).toBeNull();
  expect(mirrorZoneFromSamples('driver_mirror', around(-42, 0, MIRROR_MIN_SAMPLES), C)).not.toBeNull();
  expect(mirrorZoneFromSamples('driver_mirror', around(-5, 0), C)).toBeNull(); // within the road-centre reach
  expect(mirrorZoneFromSamples('driver_mirror', around(-90, -30), C)).toBeNull(); // nowhere near the default
  expect(mirrorZoneFromSamples('rear_mirror', around(0, -40), C)).toBeNull(); // the lap, not the mirror
});

test('a wide scatter is capped at the maximum half-width; a tight one floors at the minimum', () => {
  const wide = mirrorZoneFromSamples('driver_mirror', around(-45, 0, 40, 30), C);
  // 30° of spread: the zone reaches too close to the centre or past the bounds — null, or capped.
  if (wide !== null) expect(wide.halfYawDeg).toBeLessThanOrEqual(C.zones.learnedMaxHalfWidthDeg);
  const tight = mirrorZoneFromSamples('driver_mirror', Array.from({ length: 20 }, () => ({ yaw: -45, pitch: 0 })), C)!;
  expect(tight.halfYawDeg).toBe(C.zones.ellipseMinHalfWidthDeg);
  expect(tight.halfPitchDeg).toBe(C.zones.ellipseMinHalfWidthDeg);
});

describe('parseSetupRecord', () => {
  const record: DmsSetupRecord = { v: 1, seed: SEED, mirrors: [mirrorZoneFromSamples('driver_mirror', around(-42, 0), C)!], savedAtMs: 1_760_000_000_000 };
  test('a valid record round-trips through JSON', () => {
    expect(parseSetupRecord(JSON.parse(JSON.stringify(record)), C)).toEqual(record);
  });
  test('an empty mirror list is fine; an out-of-bounds mirror is dropped, never the record', () => {
    expect(parseSetupRecord({ ...record, mirrors: [] }, C)!.mirrors).toEqual([]);
    const far = { id: 'rear_mirror', yawDeg: 0, pitchDeg: 0, halfYawDeg: 4, halfPitchDeg: 4, drives: 3 };
    expect(parseSetupRecord({ ...record, mirrors: [far, ...record.mirrors] }, C)!.mirrors).toEqual(record.mirrors);
  });
  test.each([
    ['not an object', 'x'],
    ['another version', { ...record, v: 2 }],
    ['no seed', { ...record, seed: null }],
    ['a seed with no gaze centre', { ...record, seed: { ...SEED, gazeCentres: { geometric: null, net: null } } }],
    ['a seed with a bad angle', { ...record, seed: { ...SEED, headCentre: { yaw: 400, pitch: 0 } } }],
    ['a seed with a bad mount', { ...record, seed: { ...SEED, mount: { ...SEED.mount, iod: 0 } } }],
    ['a seed with a bad EAR', { ...record, seed: { ...SEED, openEyeEar: { r: 1.5, l: null } } }],
    ['a seed with a bad orientation', { ...record, seed: { ...SEED, orientation: 45 } }],
    ['a seed with an extra key', { ...record, seed: { ...SEED, gazeCentres: { geometric: { yaw: 0, pitch: 0 }, net: null, extra: 1 } } }],
    ['mirrors not a list', { ...record, mirrors: {} }],
    ['a malformed mirror', { ...record, mirrors: [{ id: 'driver_mirror' }] }],
    ['a mirror twice', { ...record, mirrors: [...record.mirrors, ...record.mirrors] }],
    ['a bad date', { ...record, savedAtMs: -1 }],
  ])('%s is null', (_n, x) => {
    expect(parseSetupRecord(x, C)).toBeNull();
  });
});
