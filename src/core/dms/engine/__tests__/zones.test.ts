// The zone map (plan §M4): priority order, every boundary, hysteresis, widening, turn and curve
// extensions, learned mirrors, the phone-screen circle, RHD, and LOST after a fast turn (C-8).
import { toDriverFrame } from '../angles';
import { DEFAULT_DMS_CONFIG, resolveDmsConfig, type DmsConfig } from '../config';
import { cameraRel, createTurnExtender, createZoneClassifier, forwardExtension, widening, zoneClass, type ZoneContext } from '../zones';
import { ctx } from '../__fixtures__/synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const BASE: ZoneContext = { radiusDeg: 8, cameraRel: { yaw: -50, pitch: -45 }, widenDeg: 0, extension: { toward: 0, deg: 0 }, learned: {} };
/** A fresh classifier per point (no hysteresis). */
const z = (yaw: number, pitch: number, over: Partial<ZoneContext> = {}) => createZoneClassifier(C).classify({ yaw, pitch }, { ...BASE, ...over });

describe('priority and boundaries (±0.1° around every edge)', () => {
  test('road centre: the calibrated circle', () => {
    expect(z(7.9, 0)).toBe('road_centre');
    expect(z(8.1, 0)).toBe('forward_road');
    expect(z(0, -7.9)).toBe('road_centre');
  });
  test('the rear mirror wins over the forward road where they overlap', () => {
    expect(z(25, 8)).toBe('rear_mirror'); // inside both
    expect(z(20.1, 5.1)).toBe('rear_mirror');
    expect(z(19.9, 8)).toBe('forward_road');
    expect(z(25, 4.9)).toBe('forward_road');
    expect(z(34.9, 14.9)).toBe('rear_mirror');
    expect(z(35.1, 10)).toBe('other');
    expect(z(25, 15.1)).toBe('other');
  });
  test('forward road', () => {
    expect(z(-24.9, 0)).toBe('forward_road');
    expect(z(-25.1, 0)).toBe('other');
    expect(z(29.9, 0)).toBe('forward_road');
    expect(z(30.1, 0)).toBe('other');
    expect(z(0, 11.9)).toBe('forward_road');
    expect(z(0, 12.1)).toBe('other');
    expect(z(-20, -9.9)).toBe('forward_road');
  });
  test('driver-side and passenger mirrors', () => {
    expect(z(-30.1, 0)).toBe('driver_mirror');
    expect(z(-29.9, 0)).toBe('other');
    expect(z(-59.9, -11.9)).toBe('driver_mirror');
    expect(z(-45, 10.1)).toBe('other');
    expect(z(45.1, 0)).toBe('passenger_mirror');
    expect(z(44.9, 0)).toBe('other');
    expect(z(59.9, 9.9)).toBe('passenger_mirror');
  });
  test('cluster, lap, centre stack', () => {
    expect(z(0, -10.1)).toBe('cluster');
    expect(z(11.9, -24.9)).toBe('cluster');
    expect(z(12.1, -20)).toBe('other');
    expect(z(0, -25.1)).toBe('other');
    expect(z(0, -30.1)).toBe('lap');
    expect(z(0, -29.9)).toBe('other');
    expect(z(59.9, -40)).toBe('lap');
    expect(z(-60.1, -40)).toBe('far_lateral');
    expect(z(15.1, -10.1)).toBe('centre_stack');
    expect(z(44.9, -29.9)).toBe('centre_stack');
    expect(z(14.9, -20)).toBe('other'); // between the cluster (≤ 12) and the centre stack (≥ 15)
  });
  test('far lateral and other', () => {
    expect(z(60.1, 0)).toBe('far_lateral');
    expect(z(-60.1, 0)).toBe('far_lateral');
    expect(z(59.9, 20)).toBe('other');
  });
  test('the phone screen: a circle of 8° around the camera direction, which follows the centre', () => {
    const centre = { yaw: -20, pitch: 12 };
    const cam = cameraRel(centre, 0, 'left');
    expect(cam.yaw).toBeCloseTo(20, 12);
    expect(cam.pitch).toBeCloseTo(-12, 12);
    expect(z(20, -12, { cameraRel: cam })).toBe('phone_screen');
    // The circle is angular (great-circle), like the road centre's; along pitch that is plain degrees.
    expect(z(20, -19.9, { cameraRel: cam })).toBe('phone_screen');
    expect(z(20, -20.1, { cameraRel: cam })).toBe('centre_stack');
    // It beats every zone below it in priority, but not the road centre.
    expect(z(3, 0, { cameraRel: { yaw: 0, pitch: 0 } })).toBe('road_centre');
  });
  test('zone classes', () => {
    expect(zoneClass('road_centre', C)).toBe('on_road');
    expect(zoneClass('cluster', C)).toBe('driving');
    expect(zoneClass('lap', C)).toBe('non_driving');
  });
});

describe('hysteresis: 2.5°', () => {
  const walk = (points: [number, number][]) => {
    const k = createZoneClassifier(C);
    return points.map(([yaw, pitch]) => k.classify({ yaw, pitch }, BASE));
  };
  test('leaving the cluster: still in it 2.4° past its edge, out at 2.6°', () => {
    expect(walk([[0, -20], [14.4, -20]])).toEqual(['cluster', 'cluster']);
    expect(walk([[0, -20], [14.6, -20]])).toEqual(['cluster', 'other']);
  });
  test('entering the road centre from the forward road needs 2.5° inside its circle', () => {
    expect(walk([[15, 0], [5.6, 0]])).toEqual(['forward_road', 'forward_road']);
    expect(walk([[15, 0], [5.4, 0]])).toEqual(['forward_road', 'road_centre']);
    // …and leaving it needs 2.5° past it.
    expect(walk([[0, 0], [10.4, 0]])).toEqual(['road_centre', 'road_centre']);
    expect(walk([[0, 0], [10.6, 0]])).toEqual(['road_centre', 'forward_road']);
  });
  test('"other" holds nothing: any zone is entered at its edge', () => {
    expect(walk([[35.5, 30], [0, -10.1]])).toEqual(['other', 'cluster']);
  });
});

describe('widening (+5° per condition, capped at +10°; on-road zones only)', () => {
  test('the condition count', () => {
    expect(widening({ uncalibrated: false, warmup: false, headOnly: false, resumeCheck: false }, C)).toBe(0);
    expect(widening({ uncalibrated: true, warmup: false, headOnly: false, resumeCheck: false }, C)).toBe(5);
    expect(widening({ uncalibrated: true, warmup: true, headOnly: true, resumeCheck: true }, C)).toBe(10);
  });
  test('road centre and forward road grow', () => {
    expect(z(12.9, 0, { widenDeg: 5 })).toBe('road_centre');
    expect(z(-29.9, 0, { widenDeg: 5 })).toBe('forward_road');
    expect(z(-34.9, 0, { widenDeg: 10 })).toBe('forward_road');
    // Non-road zones do not.
    expect(z(0, -35, { widenDeg: 10 })).toBe('lap');
  });
});

describe('turn and curve extensions (§M4, C-18)', () => {
  test('a junction turn (> 8°/s below 40 km/h) with a KNOWN sign extends the forward road 30° toward it', () => {
    const right = forwardExtension(ctx({ tMs: 0, speedKmh: 25, yawRateDegS: 12, turnSign: 1 }), 0, 'left', C);
    expect(right).toEqual({ toward: 1, deg: 30 });
    expect(z(59, 0, { extension: right })).toBe('forward_road');
    expect(z(61, 0, { extension: right })).toBe('far_lateral');
    // Unknown sign: no extension (conservative).
    expect(forwardExtension(ctx({ tMs: 0, speedKmh: 25, yawRateDegS: 12, turnSign: 0 }), 0, 'left', C)).toEqual({ toward: 0, deg: 0 });
    // A right turn is −yaw in RHD.
    expect(forwardExtension(ctx({ tMs: 0, speedKmh: 25, yawRateDegS: 12, turnSign: 1 }), 0, 'right', C)).toEqual({ toward: -1, deg: 30 });
    // Not at ≥ 40 km/h.
    expect(forwardExtension(ctx({ tMs: 0, speedKmh: 40, yawRateDegS: 12, turnSign: 1 }), 0, 'left', C).deg).toBe(0);
  });
  test('a sustained curve at ≥ 40 km/h: clamp((rate − 2) / 6, 0, 1) × 15° after 3 rows', () => {
    const ext = (rate: number, rows: number) => forwardExtension(ctx({ tMs: 0, speedKmh: 80, yawRateDegS: rate, turnSign: -1 }), rows, 'left', C);
    expect(ext(2, 3)).toEqual({ toward: -1, deg: 0 });
    expect(ext(5, 3).deg).toBeCloseTo(7.5, 12);
    expect(ext(8, 3).deg).toBe(15);
    expect(ext(20, 3).deg).toBe(15);
    expect(ext(8, 2).deg).toBe(0); // not yet sustained
  });
  test('the turn extender counts the sustained curve rows', () => {
    const t = createTurnExtender(C, 'left');
    const row = (rate: number) => ctx({ tMs: 0, speedKmh: 80, yawRateDegS: rate, turnSign: 1 });
    expect(t.onRow(row(5)).deg).toBe(0);
    expect(t.onRow(row(5)).deg).toBe(0);
    expect(t.onRow(row(5)).deg).toBeCloseTo(7.5, 12);
    expect(t.onRow(row(1)).deg).toBe(0); // the run breaks
    expect(t.onRow(row(5)).deg).toBe(0);
  });
});

test('RHD: the same driver-frame zones; the camera-frame input is mirrored by the driver frame', () => {
  const lhd = toDriverFrame({ yaw: 40, pitch: 0 }, 'left');
  const rhd = toDriverFrame({ yaw: -40, pitch: 0 }, 'right');
  expect(z(lhd.yaw, lhd.pitch)).toBe('driver_mirror');
  expect(z(rhd.yaw, rhd.pitch)).toBe('driver_mirror');
});

test('a learned mirror ellipse replaces the default rectangle', () => {
  const learned = { rear_mirror: { id: 'rear_mirror' as const, yawDeg: 38, pitchDeg: 18, halfYawDeg: 5, halfPitchDeg: 4, drives: 3 } };
  expect(z(40, 19, { learned })).toBe('rear_mirror');
  expect(z(25, 8, { learned })).toBe('forward_road'); // the default rectangle no longer applies
});

describe('LOST after a fast turn (C-8)', () => {
  const p = (tMs: number, over: Record<string, unknown>) => ({ tMs, quality: 'tracking' as const, gazeRel: { yaw: 0, pitch: 0 }, headRel: { yaw: 0, pitch: 0 }, headYawSpeedDegS: 0, ...over });
  test('a head turning > 100°/s just before the loss → far lateral, for 5 s', () => {
    const k = createZoneClassifier(C);
    k.step(p(0, { headYawSpeedDegS: 20 }), BASE);
    k.step(p(66, { headYawSpeedDegS: 150, headRel: { yaw: 30, pitch: 0 } }), BASE);
    expect(k.step(p(133, { quality: 'lost', gazeRel: null, headRel: null, headYawSpeedDegS: null }), BASE)).toBe('far_lateral');
    expect(k.step(p(5000, { quality: 'lost', gazeRel: null, headRel: null, headYawSpeedDegS: null }), BASE)).toBe('far_lateral');
    expect(k.step(p(5200, { quality: 'lost', gazeRel: null, headRel: null, headYawSpeedDegS: null }), BASE)).toBeNull(); // occlusion after 5 s
  });
  test('a last relative head yaw beyond 45° counts too; a loss from a centred, still head is occlusion', () => {
    const k = createZoneClassifier(C);
    k.step(p(0, { headRel: { yaw: 50, pitch: 0 } }), BASE);
    expect(k.step(p(66, { quality: 'lost', gazeRel: null, headRel: null, headYawSpeedDegS: null }), BASE)).toBe('far_lateral');
    const q = createZoneClassifier(C);
    q.step(p(0, { headRel: { yaw: 5, pitch: 0 }, headYawSpeedDegS: 10 }), BASE);
    expect(q.step(p(66, { quality: 'lost', gazeRel: null, headRel: null, headYawSpeedDegS: null }), BASE)).toBeNull();
  });
  test('a turn older than 300 ms before the loss does not count', () => {
    const k = createZoneClassifier(C);
    k.step(p(0, { headYawSpeedDegS: 150 }), BASE);
    k.step(p(400, { headYawSpeedDegS: 5 }), BASE);
    expect(k.step(p(466, { quality: 'lost', gazeRel: null, headRel: null, headYawSpeedDegS: null }), BASE)).toBeNull();
  });
});

test('the config refuses a hysteresis wider than a mirror is tall', () => {
  expect(() => resolveDmsConfig({ zones: { hysteresisDeg: 6 } })).toThrow(/hysteresisDeg/);
});
