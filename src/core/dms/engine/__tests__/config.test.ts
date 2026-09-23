// The engine config (plan §M, Task 5): every DMS number lives once in DEFAULT_DMS_CONFIG, validated,
// round-tripped through JSON, and overridable by a deep partial (the host's `config` option).
import { PAUSE_AFTER_STOP_MS as MODULE_PAUSE_AFTER_STOP_MS } from '../../../../../modules/dms-vision/src/constants';
import {
  DEFAULT_DMS_CONFIG,
  PAUSE_AFTER_STOP_MS,
  ZONE_IDS,
  configFromJson,
  configToJson,
  resolveDmsConfig,
  validateDmsConfig,
  type DmsConfig,
} from '../config';

/** A deep, mutable copy to break. */
const copy = (): DmsConfig => JSON.parse(JSON.stringify(DEFAULT_DMS_CONFIG)) as DmsConfig;

test('the default config is valid', () => {
  expect(validateDmsConfig(DEFAULT_DMS_CONFIG)).toEqual([]);
});

test('the default is deeply frozen', () => {
  expect(Object.isFrozen(DEFAULT_DMS_CONFIG)).toBe(true);
  expect(Object.isFrozen(DEFAULT_DMS_CONFIG.distraction.d1)).toBe(true);
  expect(Object.isFrozen(DEFAULT_DMS_CONFIG.zones.table)).toBe(true);
  expect(Object.isFrozen(DEFAULT_DMS_CONFIG.zones.table[0])).toBe(true);
});

test('PAUSE_AFTER_STOP_MS is the dms-vision constant, not a second copy', () => {
  expect(PAUSE_AFTER_STOP_MS).toBe(MODULE_PAUSE_AFTER_STOP_MS);
  expect(PAUSE_AFTER_STOP_MS).toBe(5000);
});

describe('the binding numbers (plan §M1–§M10)', () => {
  const c = DEFAULT_DMS_CONFIG;
  test('gaze source and the geometric gaze (§M1a)', () => {
    expect(c.gazeSource).toBe('geometric');
    expect(c.geometric).toEqual({ kEye: 0.43, gPitch: 1.0, nearEyeYawDeg: 25, fallbackMarginDeg: 5 });
  });
  test('quality (§M2)', () => {
    expect(c.quality.lostMinBoxArea).toBe(0.01);
    expect(c.quality.lostMaxFaceLuma).toBe(25);
    expect(c.quality.lowLightFrameLuma).toBe(25);
    expect(c.quality.eyeMinLuma).toBe(0.45);
    expect(c.quality.eyeMinIrisContrast).toBe(12);
    expect(c.quality.eyeMaxSat).toBe(0.25);
    expect(c.quality.eyeMinWidthPx).toBe(10);
    expect(c.quality.headOnlyYawDeg).toBe(40);
    expect(c.quality.headOnlyMinBlur).toBe(15);
    expect(c.quality.headOnlyMinFaceLuma).toBe(50);
    expect(c.quality.limitedNoticeS).toBe(10);
    expect(c.quality.irisRecencyS).toBe(10); // T6 round-1 review R1-I1
  });
  test('the tunnel rule and stale rows (§M1, rev1 I6)', () => {
    expect(c.context.rowStaleMs).toBe(3000);
    expect(c.context.tunnelHoldMs).toBe(600_000);
    expect(c.context.unknownStillHoldMs).toBe(10_000);
  });
  test('calibration (§M3)', () => {
    expect(c.calibration.radiusMinDeg).toBe(8);
    expect(c.calibration.radiusMaxDeg).toBe(15);
    expect(c.calibration.confidenceMinShare).toBe(0.7);
    expect(c.calibration.neutralMarFloor).toBe(0.05);
    expect(c.calibration.emaTauS).toBe(180);
    expect(c.calibration.emaMaxDegPerMin).toBe(0.5);
    expect(c.calibration.resumeTolerance).toEqual({ yawDeg: 4, pitchDeg: 4, rollDeg: 3, box: 0.05, iodFrac: 0.1 });
    expect(c.calibration.driverChange).toEqual({ iodFrac: 0.15, box: 0.15 });
    expect(c.calibration.opennessRange).toEqual([0.6, 1.4]);
  });
  test('distraction (§M5): D1 buffers, sensitivity, D2 VATS reset, D3, D4', () => {
    expect(c.distraction.d1.bufferCityS).toBe(6);
    expect(c.distraction.d1.bufferFastS).toBe(3);
    expect(c.distraction.d1.sensitivity).toEqual({ low: 1.15, normal: 1.0, high: 0.85 });
    expect(c.distraction.d1.lowCapCityS).toBe(6);
    expect(c.distraction.d1.lowCapFastS).toBe(3.5);
    expect(c.distraction.d2.resetOnRoadS).toBe(2.0);
    expect(c.distraction.d2.windowS).toBe(30);
    expect(c.distraction.d2.warnS).toBe(10);
    expect(c.distraction.d3).toEqual({ minGlances: 3, minLapS: 1.0, withinS: 30, minSpeedKmh: 20, cooldownS: 600 });
    expect(c.distraction.d4.returnWithinS).toBe(3);
  });
  test('closure, nod and yawn (§M6)', () => {
    expect(c.closure.closedBelow).toBe(0.3);
    expect(c.closure.openAbove).toBe(0.45);
    expect(c.closure.f1).toEqual({ closedS: 1.0, lookDownClosedS: 1.5, minSpeedKmh: 20 });
    expect(c.closure.f2).toEqual({ closedS: 3.0, minSpeedKmh: 10 });
    expect(c.closure.f3).toEqual({ closedS: 6.0, noOnRoadS: 3.0, minSpeedKmh: 10 });
    expect(c.nod.closureOpenness).toBe(0.15);
    expect(c.nod.closureHoldS).toBe(0.5);
    expect(c.yawn.absMar).toBe(0.35);
    expect(c.yawn.minFps).toBe(9); // T6 review I2: between 10 and 8
  });
  test('the numbers added in Task 6 (Task 5 review m1)', () => {
    expect(c.fatigue.perclosOpennessBelow).toBe(0.2);
    expect(c.fatigue.perclosMinTrackingS).toBe(30);
    expect(c.closure.fpsWindowS).toBe(10);
    expect(c.distraction.gazeRulesMinFps).toBe(6.5);
    expect(c.summary).toEqual({ goodSessionMinMonitoredS: 600, goodSessionMinTrackingShare: 0.7, goodSessionMinBlinksPer2Min: 1 });
  });
  test('the fatigue weights sum to 1 (§M7)', () => {
    const s = Object.values(c.fatigue.signals).reduce((a, x) => a + x.weight, 0);
    expect(s).toBeCloseTo(1, 12);
    expect(c.fatigue.levels).toEqual([40, 60, 80]);
  });
});

describe('the zone table (§M4) against the spec\'s alert times (§M5)', () => {
  const c = DEFAULT_DMS_CONFIG;
  test('the eleven zones, in priority order', () => {
    expect(c.zones.table.map((z) => z.id)).toEqual([...ZONE_IDS]);
  });

  // One continuous glance empties a full buffer after grace + B / weight.
  const alertAt = (id: string, B: number, shoulder = false) => {
    const z = c.zones.table.find((x) => x.id === id)!;
    if (z.class === 'on_road') throw new Error('on-road');
    return (shoulder ? z.shoulderCheckGraceS! : z.graceS) + B / z.weight;
  };
  const fast = DEFAULT_DMS_CONFIG.distraction.d1.bufferFastS;
  const city = DEFAULT_DMS_CONFIG.distraction.d1.bufferCityS;
  test.each([
    ['centre_stack', 3.0, 6.0],
    ['other', 3.0, 6.0],
    ['lap', 2.4, 4.8],
    ['rear_mirror', 4.0, 7.0],
    ['cluster', 4.0, 7.0],
    ['far_lateral', 2.0, 4.0],
  ])('%s alerts at %s s (≥ 50 km/h) and %s s (20–50 km/h)', (id, atFast, atCity) => {
    expect(alertAt(id, fast)).toBeCloseTo(atFast, 12);
    expect(alertAt(id, city)).toBeCloseTo(atCity, 12);
  });
  test('a shoulder check alerts at 3.0 s and 5.0 s', () => {
    expect(alertAt('far_lateral', fast, true)).toBeCloseTo(3.0, 12);
    expect(alertAt('far_lateral', city, true)).toBeCloseTo(5.0, 12);
  });
  test('low sensitivity stays inside the ADDW caps', () => {
    const d1 = c.distraction.d1;
    expect(Math.min(d1.bufferFastS * d1.sensitivity.low, d1.lowCapFastS)).toBeCloseTo(3.45, 12);
    expect(Math.min(d1.bufferCityS * d1.sensitivity.low, d1.lowCapCityS)).toBe(6);
  });
});

describe('JSON', () => {
  test('round trip is exact', () => {
    const json = configToJson(DEFAULT_DMS_CONFIG);
    expect(typeof json).toBe('string');
    expect(configFromJson(json)).toEqual(DEFAULT_DMS_CONFIG);
  });

  test('a changed but valid config round-trips too', () => {
    const c = copy();
    c.gazeSource = 'net';
    c.geometric.kEye = 0.4;
    expect(configFromJson(configToJson(c))).toEqual(c);
  });

  test('refuses unparsable text, an unknown key, a missing key and a wrong type', () => {
    expect(() => configFromJson('{')).toThrow(/JSON/);
    const extra = JSON.parse(configToJson(DEFAULT_DMS_CONFIG)) as Record<string, unknown>;
    extra.surprise = 1;
    expect(() => configFromJson(JSON.stringify(extra))).toThrow(/surprise/);
    const missing = JSON.parse(configToJson(DEFAULT_DMS_CONFIG)) as { quality: Record<string, unknown> };
    delete missing.quality.headOnlyYawDeg;
    expect(() => configFromJson(JSON.stringify(missing))).toThrow(/quality\.headOnlyYawDeg/);
    const typed = JSON.parse(configToJson(DEFAULT_DMS_CONFIG)) as { closure: Record<string, unknown> };
    typed.closure.closedBelow = '0.3';
    expect(() => configFromJson(JSON.stringify(typed))).toThrow(/closure\.closedBelow/);
  });

  test('refuses a structurally valid but invalid config', () => {
    const c = copy();
    c.closure.closedBelow = 0.5; // above openAbove
    expect(() => configFromJson(configToJson(c))).toThrow(/closure/);
  });
});

describe('validateDmsConfig refuses each broken rule', () => {
  const cases: [string, (c: DmsConfig) => void, RegExp][] = [
    ['a wrong version', (c) => ((c as { v: number }).v = 2), /\bv\b/],
    ['an unknown gaze source', (c) => ((c as { gazeSource: string }).gazeSource = 'magic'), /gazeSource/],
    ['a non-finite number', (c) => (c.quality.eyeMinLuma = Number.NaN), /quality\.eyeMinLuma/],
    ['a negative duration', (c) => (c.distraction.d2.windowS = -1), /distraction\.d2\.windowS/],
    ['a fraction above 1', (c) => (c.calibration.confidenceMinShare = 1.2), /calibration\.confidenceMinShare/],
    ['kEye outside (0, 1]', (c) => (c.geometric.kEye = 0), /geometric\.kEye/],
    ['closed not below open (hysteresis)', (c) => (c.closure.openAbove = 0.3), /closure\.closedBelow/],
    ['radius min above max', (c) => (c.calibration.radiusMinDeg = 20), /calibration\.radiusMinDeg/],
    ['an inverted openness range', (c) => (c.calibration.opennessRange = [1.4, 0.6]), /calibration\.opennessRange/],
    ['fatigue weights not summing to 1', (c) => (c.fatigue.signals.perclos.weight = 0.5), /fatigue\.signals/],
    ['fatigue levels out of order', (c) => (c.fatigue.levels = [60, 40, 80]), /fatigue\.levels/],
    ['the fast buffer not shorter than the city one', (c) => (c.distraction.d1.bufferFastS = 7), /distraction\.d1/],
    ['a sensitivity factor ≤ 0', (c) => (c.distraction.d1.sensitivity.high = 0), /distraction\.d1\.sensitivity/],
    ['a zone rectangle inverted', (c) => {
      const z = c.zones.table.find((x) => x.id === 'cluster')!;
      if (z.region.kind === 'rect') z.region.yaw = [12, -12];
    }, /zones\.table\[cluster\]/],
    ['a zone weight ≤ 0', (c) => (c.zones.table.find((x) => x.id === 'lap')!.weight = 0), /zones\.table\[lap\]/],
    ['a zone missing', (c) => c.zones.table.splice(2, 1), /zones\.table/],
    ['the widening cap below one step', (c) => (c.zones.widenCapDeg = 2), /zones\.widenCapDeg/],
    ['a night window beyond a day', (c) => (c.fatigue.nightEndMin = 2000), /fatigue\.nightEndMin/],
    ['the D2 bucket not dividing the window', (c) => (c.distraction.d2.bucketMs = 70), /distraction\.d2\.bucketMs/],
    ['the lap zone above the centre (Task 5 review m2)', (c) => {
      const z = c.zones.table.find((x) => x.id === 'lap')!;
      if (z.region.kind === 'below') z.region.maxPitchDeg = 30;
    }, /zones\.table\[lap\]\.region\.maxPitchDeg/],
    ['the lap zone with no yaw extent', (c) => {
      const z = c.zones.table.find((x) => x.id === 'lap')!;
      if (z.region.kind === 'below') z.region.maxAbsYawDeg = 0;
    }, /zones\.table\[lap\]\.region\.maxAbsYawDeg/],
    ['far lateral from 0°', (c) => {
      const z = c.zones.table.find((x) => x.id === 'far_lateral')!;
      if (z.region.kind === 'lateral') z.region.minAbsYawDeg = 0;
    }, /zones\.table\[far_lateral\]\.region\.minAbsYawDeg/],
    ['an absurd grace', (c) => (c.zones.table.find((x) => x.id === 'cluster')!.graceS = 60), /zones\.table\[cluster\]\.graceS/],
    ['a shoulder-check grace on a mirror', (c) => (c.zones.table.find((x) => x.id === 'rear_mirror')!.shoulderCheckGraceS = 1), /zones\.table\[rear_mirror\]\.shoulderCheckGraceS/],
    ['far lateral without its shoulder-check grace', (c) => (c.zones.table.find((x) => x.id === 'far_lateral')!.shoulderCheckGraceS = null), /zones\.table\[far_lateral\]\.shoulderCheckGraceS/],
    ['PERCLOS below the looking-down threshold', (c) => (c.fatigue.perclosOpennessBelow = 0.1), /fatigue\.perclosOpennessBelow/],
    ['a gaze-rules fps floor of 0', (c) => (c.distraction.gazeRulesMinFps = 0), /distraction\.gazeRulesMinFps/],
  ];
  test.each(cases)('%s', (_name, breakIt, path) => {
    const c = copy();
    breakIt(c);
    const errors = validateDmsConfig(c);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(path);
  });
});

describe('resolveDmsConfig (the host override)', () => {
  test('no override is the default', () => {
    expect(resolveDmsConfig()).toEqual(DEFAULT_DMS_CONFIG);
  });

  test('a deep partial changes only its leaves', () => {
    const c = resolveDmsConfig({ gazeSource: 'net', geometric: { kEye: 0.41 } });
    expect(c.gazeSource).toBe('net');
    expect(c.geometric.kEye).toBe(0.41);
    expect(c.geometric.gPitch).toBe(DEFAULT_DMS_CONFIG.geometric.gPitch);
    expect(c.quality).toEqual(DEFAULT_DMS_CONFIG.quality);
    expect(DEFAULT_DMS_CONFIG.geometric.kEye).toBe(0.43); // the default is untouched
  });

  test('refuses an override that breaks a rule, or names an unknown key', () => {
    expect(() => resolveDmsConfig({ closure: { closedBelow: 0.9 } })).toThrow(/closure/);
    expect(() => resolveDmsConfig({ quality: { bogus: 1 } } as never)).toThrow(/bogus/);
  });
});

describe('the fps floors sit between capture rates (T6 review I2)', () => {
  const c = DEFAULT_DMS_CONFIG;
  test('the values', () => {
    expect(c.distraction.gazeRulesMinFps).toBe(6.5);
    expect(c.closure.blinkMinFps).toBe(12.5);
    expect(c.fatigue.signals.longBlinks.minFps).toBe(12.5);
    expect(c.fatigue.signals.blinkDuration.minFps).toBe(12.5);
    expect(c.fatigue.signals.perclos.minFps).toBe(9);
    expect(c.fatigue.signals.yawns.minFps).toBe(9);
    expect(c.yawn.minFps).toBe(9);
  });
  test('an exact 15 fps stream, and one with 1 ms of jitter, pass the blink floor; 10 fps does not', () => {
    for (const dt of [1000 / 15, 1000 / 15 + 1]) expect(1000 / dt).toBeGreaterThanOrEqual(c.closure.blinkMinFps);
    expect(1000 / 100).toBeLessThan(c.closure.blinkMinFps);
  });
  test.each([
    ['gaze rules at 8', (x: DmsConfig) => (x.distraction.gazeRulesMinFps = 8), /distraction\.gazeRulesMinFps/],
    ['blinks at 15', (x: DmsConfig) => (x.closure.blinkMinFps = 15), /closure\.blinkMinFps/],
    ['PERCLOS at 10', (x: DmsConfig) => (x.fatigue.signals.perclos.minFps = 10), /fatigue\.signals\.perclos\.minFps/],
    ['yawns at 10', (x: DmsConfig) => (x.yawn.minFps = 10), /yawn\.minFps/],
  ])('a floor equal to a capture rate is refused: %s', (_n, breakIt, path) => {
    const x = copy();
    breakIt(x);
    expect(validateDmsConfig(x).join('\n')).toMatch(path);
  });
});
