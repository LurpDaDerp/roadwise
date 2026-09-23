// The trip summary (plan §M9, rev1 R-U4/m9, U-11) and the Tier 0 log (§M5 "Logged only").
import { createAlertManager } from '../alerts';
import { DEFAULT_DMS_CONFIG, type DmsConfig, type ZoneId } from '../config';
import { createFatigue } from '../fatigue';
import type { Glance } from '../glances';
import { createSummary, type SummaryFrame } from '../summary';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
type Sm = ReturnType<typeof createSummary>;

/** Frames at `fps` over [fromS, toS); `blinkEvery` s a blink. */
function feed(sm: Sm, fromS: number, toS: number, spec: (t: number) => Partial<SummaryFrame> = () => ({}), o: { fps?: number; blinkEvery?: number } = {}) {
  const fps = o.fps ?? 15;
  for (let i = Math.round(fromS * fps); i < Math.round(toS * fps); i++) {
    const t = i / fps;
    sm.onFrame({
      tMs: t * 1000,
      dtS: 1 / fps,
      ruleSpeedKmh: 60,
      quality: 'tracking',
      zone: 'road_centre',
      gazeRel: { yaw: 4 * Math.sin((2 * Math.PI * t) / 3), pitch: 2 * Math.cos((2 * Math.PI * t) / 4) },
      fps,
      thermalLevel: 0,
      ...spec(t),
    });
    if (o.blinkEvery !== undefined && i % Math.round(o.blinkEvery * fps) === 0 && i > 0) sm.onBlink(t * 1000);
  }
}
const glance = (zone: ZoneId, durS: number, endS: number, shoulderCheck = false): Glance => ({ startT: (endS - durS) * 1000, endT: endS * 1000, durS, zone, perZone: { [zone]: durS }, shoulderCheck });
const build = (sm: Sm) => sm.build({ alerts: createAlertManager(C, { mode: 'live' }).stats(), fatigue: createFatigue(C).stats(), calibrationState: 'calibrated' });

/** Every number in the value is finite (no NaN or Infinity), and it survives a JSON round trip. */
function jsonSafe(v: unknown): boolean {
  const walk = (x: unknown): boolean => {
    if (typeof x === 'number') return Number.isFinite(x);
    if (x === null || typeof x !== 'object') return x === undefined ? false : true;
    return Object.values(x as object).every(walk);
  };
  return walk(v) && JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v);
}

describe('a scripted drive (§M9, U-11)', () => {
  // 20 min at 60 km/h; 80 % TRACKING; the gaze in the lap 10 % of the time; a blink every 30 s.
  const drive = (o: { minutes?: number; blinkEvery?: number; speed?: number } = {}) => {
    const sm = createSummary(C, { gazeSource: 'geometric' });
    feed(
      sm,
      0,
      (o.minutes ?? 20) * 60,
      (t) => ({ ruleSpeedKmh: o.speed ?? 60, quality: (t % 10) < 8 ? 'tracking' : 'head_only', zone: (t % 20) < 2 ? 'lap' : 'road_centre' }),
      { blinkEvery: o.blinkEvery }
    );
    return build(sm);
  };
  test('monitored seconds by quality, TRACKING coverage, eyes-off-road seconds and the attention score', () => {
    const s = drive({ blinkEvery: 30 });
    expect(s.monitoredS.total).toBeCloseTo(1200, 0);
    expect(s.monitoredS.tracking).toBeCloseTo(960, 0);
    expect(s.monitoredS.head_only).toBeCloseTo(240, 0);
    expect(s.trackingCoverage).toBeCloseTo(0.8, 2);
    expect(s.eyesOffRoadS).toBeCloseTo(120, 0);
    expect(s.attentionScore).toBe(90);
    expect(s.gazeSource).toBe('geometric');
  });
  test('cameraSession: good; limited without blinks (a photo), or under 10 min; none when nothing was monitored', () => {
    expect(drive({ blinkEvery: 30 }).cameraSession).toBe('good');
    expect(drive().cameraSession).toBe('limited');
    expect(drive({ blinkEvery: 30, minutes: 8 }).cameraSession).toBe('limited');
    expect(drive({ blinkEvery: 30, speed: 15 }).cameraSession).toBe('none');
    expect(drive({ blinkEvery: 30, speed: 15 }).attentionScore).toBeNull();
  });
  test('JSON-safe, with no NaN, for an empty trip and a full one', () => {
    expect(jsonSafe(build(createSummary(C, { gazeSource: 'net' })))).toBe(true);
    expect(jsonSafe(drive({ blinkEvery: 30 }))).toBe(true);
  });
});

describe('counts, glances and the fatigue timeline', () => {
  test('alert counts per kind (delivered, muted, dropped) and event counts pass through', () => {
    const am = createAlertManager(C, { mode: 'live' });
    const base = { epochMs: 0, ruleSpeedKmh: 60, speedKnown: true, quality: 'tracking' as const, onRoad: false, eyesOpen: true, warmup: false };
    am.onFrame({ ...base, tMs: 0, requests: [{ kind: 'distraction' }] });
    am.onFrame({ ...base, tMs: 100, onRoad: true, requests: [{ kind: 'phone_pattern' }] });
    const sm = createSummary(C, { gazeSource: 'net' });
    sm.onEvent('d1_warning');
    sm.onEvent('d1_warning');
    sm.onEvent('microsleep');
    const s = sm.build({ alerts: am.stats(), fatigue: createFatigue(C).stats(), calibrationState: 'seeded' });
    expect(s.alerts.distraction).toMatchObject({ delivered: 1, muted: 0, dropped: 0 });
    expect(s.alerts.phone_pattern!.delivered).toBe(1);
    expect(s.events).toEqual({ d1_warning: 2, microsleep: 1 });
    expect(s.calibration.state).toBe('seeded');
  });
  test('the longest non-driving glance (shoulder checks and mirrors aside) and the Tier 0 count of those over 2 s', () => {
    const sm = createSummary(C, { gazeSource: 'geometric' });
    feed(sm, 0, 60);
    sm.onGlance(glance('lap', 2.5, 10));
    sm.onGlance(glance('rear_mirror', 3, 20));
    sm.onGlance(glance('centre_stack', 4, 30));
    sm.onGlance(glance('far_lateral', 6, 40, true));
    sm.onGlance(glance('phone_screen', 1.5, 50));
    const s = build(sm);
    expect(s.longestNonDrivingGlance).toEqual({ durS: 4, zone: 'centre_stack' });
    expect(s.tier0.nonDrivingGlancesOver2s).toBe(2);
  });
  test('the fatigue timeline, its degraded and PERCLOS-dropped minutes, and the sparse rows come from the fatigue stats', () => {
    const fz = createFatigue(C);
    for (let i = 0; i < 8 * 700; i++) {
      const t = i / 8;
      fz.onFrame({ tMs: t * 1000, dtS: 1 / 8, quality: 'tracking', closureBridged: false, openness: 1, lookingDown: false, gazeRel: { yaw: Math.sin(t), pitch: 0 }, speedKmh: 60, fps: 8, hot: t > 600, tripElapsedS: t, localMinutes: null, floor: 'none' });
    }
    const sm = createSummary(C, { gazeSource: 'geometric' });
    const s = sm.build({ alerts: createAlertManager(C, { mode: 'live' }).stats(), fatigue: fz.stats(), calibrationState: 'calibrated' });
    expect(s.fatigue.timeline.length).toBe(fz.stats().timeline.length);
    expect(s.fatigue.timeline.at(-1)).toMatchObject({ status: 'scored', reason: 'hot', perclosDropped: true });
    expect(s.fatigue.degradedMinutes.hot).toBeGreaterThanOrEqual(1);
    expect(s.fatigue.perclosDroppedMinutes).toBe(fz.stats().perclosDroppedMinutes);
    expect(s.fatigue.sparseRowMinutes).toEqual(fz.stats().sparseRowMinutes);
  });
  test('bump and driver-change events are listed', () => {
    const sm = createSummary(C, { gazeSource: 'geometric' });
    sm.onCalibration({ kind: 'calibrated', tMs: 60_000 });
    sm.onCalibration({ kind: 'camera_bump', tMs: 90_000, cause: 'step' });
    sm.onCalibration({ kind: 'driver_change', tMs: 120_000 });
    const s = build(sm);
    expect(s.calibration.bumps).toBe(1);
    expect(s.calibration.driverChanges).toBe(1);
    expect(s.calibration.events.map((e) => e.kind)).toEqual(['calibrated', 'camera_bump', 'driver_change']);
  });
});

describe('thermal and frame-rate minutes (rev1 R-U4, m9)', () => {
  test('minutes per thermal level and per capture rate', () => {
    const sm = createSummary(C, { gazeSource: 'geometric' });
    feed(sm, 0, 120);
    feed(sm, 120, 180, () => ({ thermalLevel: 2 }), { fps: 8 });
    const s = build(sm);
    expect(s.thermalMinutes['0']).toBeCloseTo(2, 2);
    expect(s.thermalMinutes['2']).toBeCloseTo(1, 2);
    expect(s.fpsMinutes['15']).toBeCloseTo(2, 2);
    expect(s.fpsMinutes['8']).toBeCloseTo(1, 2);
  });
});

describe('the Tier 0 log (§M5 "Logged only")', () => {
  test('mirror checks per minute at ≥ 50 km/h', () => {
    const sm = createSummary(C, { gazeSource: 'geometric' });
    for (let k = 0; k < 4; k++) {
      feed(sm, k * 30, (k + 1) * 30);
      sm.onGlance(glance('driver_mirror', 0.8, (k + 1) * 30));
    }
    feed(sm, 120, 180, () => ({ ruleSpeedKmh: 40 }));
    sm.onGlance(glance('rear_mirror', 0.8, 180)); // at 40 km/h: not counted, nor its minute
    expect(build(sm).tier0.mirrorChecksPerMin).toBeCloseTo(2, 2);
  });
  test('per minute: eyes-off-road seconds, the road-centre share and mirror checks', () => {
    const sm = createSummary(C, { gazeSource: 'geometric' });
    feed(sm, 0, 61, (t) => ({ zone: (t % 10) < 3 ? 'forward_road' : (t % 10) < 4 ? 'lap' : 'road_centre' }));
    const m = build(sm).tier0.minutes[0]!;
    expect(m.eyesOffRoadS).toBeCloseTo(6, 1);
    expect(m.roadCentreShare).toBeCloseTo(0.6, 2);
  });
  test('"no scanning": dispersion < 2° for ≥ 15 s at ≥ 50 km/h is one episode; not at 40 km/h; not while scanning', () => {
    const still = (speed: number) => {
      const sm = createSummary(C, { gazeSource: 'geometric' });
      feed(sm, 0, 30);
      feed(sm, 30, 60, () => ({ ruleSpeedKmh: speed, gazeRel: { yaw: 0.5, pitch: -0.5 } }));
      feed(sm, 60, 90);
      return build(sm).tier0.noScanningEpisodes;
    };
    expect(still(60)).toBe(1);
    expect(still(40)).toBe(0);
    const sm = createSummary(C, { gazeSource: 'geometric' });
    feed(sm, 0, 90);
    expect(build(sm).tier0.noScanningEpisodes).toBe(0);
  });
});
