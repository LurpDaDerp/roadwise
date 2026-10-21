// Synthetic v3 drives for the replay suite (product spec v3 "Event detection", "Rules against false
// positives"). Each builder returns a trace whose expectations encode one rule. `npm run traces:make`
// writes them to `src/core/__fixtures__/traces`; the suite asserts the committed JSON is exactly a
// fresh generation.
//
// Node reads this module directly with `--experimental-strip-types`, so it imports nothing at run
// time: no `@scoring`, no `@/` alias. The few numbers it needs are written out.
import type { FeatureRow } from '../engine/types';
import type { Trace } from './trace';

/** epoch ms of row 0 (2023-11-14T22:13:20Z: a dark evening in Seattle, so the night rule has work). */
export const T0 = 1_700_000_000_000;
export const MPH = 0.44704;
export const G = 9.80665;

/** The straight line east out of Seattle every trace drives. */
const START = { lat: 47.6062, lng: -122.3321 };
const M_PER_DEG_LAT = 111_194.93;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((START.lat * Math.PI) / 180);

export const ROW_DEFAULTS: Omit<FeatureRow, 'ts' | 'lat' | 'lng' | 'speed'> = {
  hAcc: 5,
  speedAcc: 0.5,
  course: 90,
  alt: 50,
  gnssValid: true,
  aLonMax: 0.02,
  aLonMin: -0.02,
  aLatMax: 0.02,
  aLatMin: -0.02,
  yawRateMax: 0.01,
  jerkMax: 0.02,
  gravityStability: 0.99,
  orientationDelta: 0.01,
  handlingScore: 0,
  locked: true,
  screenOn: false,
  appForeground: true,
};

type Shape = (i: number) => Partial<FeatureRow> & { speedMph?: number };

/**
 * `n` rows at 1 Hz. `shape(i)` returns the row's overrides; `speedMph` (default 35) drives the
 * position, which is integrated from the speed so the GNSS agrees with itself: due east, or along
 * each row's course with `followCourse` (a drive that turns).
 */
export function drive(n: number, shape: Shape = () => ({}), opts: { followCourse?: boolean } = {}): FeatureRow[] {
  const rows: FeatureRow[] = [];
  let lat = START.lat;
  let lng = START.lng;
  for (let i = 0; i < n; i += 1) {
    const { speedMph, ...over } = shape(i);
    const mph = speedMph ?? 35;
    const speed = mph * MPH;
    const row: FeatureRow = { ...ROW_DEFAULTS, ts: T0 + i * 1000, lat, lng, speed, ...over };
    rows.push(row);
    if (opts.followCourse === true) {
      const rad = (row.course * Math.PI) / 180;
      lat += (speed * Math.cos(rad)) / M_PER_DEG_LAT;
      lng += (speed * Math.sin(rad)) / M_PER_DEG_LNG;
    } else {
      lng += speed / M_PER_DEG_LNG;
    }
  }
  return rows;
}

const posted = (limitMph: number, fromTs = T0) => ({ fromTs, limitMps: limitMph * MPH, source: 'posted' as const, matchConfidence: 0.95, parallelRoads: false });
const unknown = (fromTs: number) => ({ fromTs, limitMps: null, source: 'unknown' as const, matchConfidence: 0, parallelRoads: false });

const at = (i: number): number => T0 + i * 1000;
const between = (i: number, a: number, b: number): boolean => i >= a && i < b;

export const TRACE_BUILDERS: Record<string, () => Trace> = {
  /** A clean commute at the limit: nothing fires. */
  'clean-commute': () => ({
    name: 'clean-commute',
    rows: drive(300, (i) => ({ speedMph: 33 + (i % 3) })),
    limits: [posted(35)],
    expected: [
      { type: 'speeding', startsNear: T0, absent: true },
      { type: 'hard_brake', startsNear: T0, absent: true },
    ],
    noEvents: true,
  }),

  /** 20 s at 41 mph on a 35 (T = 4: minor above 39): one minor episode of 20 s. */
  'speeding-minor': () => ({
    name: 'speeding-minor',
    rows: drive(240, (i) => ({ speedMph: between(i, 60, 80) ? 41 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), tier: 'minor', durationMin: 19, durationMax: 21 }],
  }),

  /** 8 s at 52 mph on a 35 (severe above 48): an event from its 6th over row, from the first; peak tier severe. */
  'speeding-severe-brief': () => ({
    name: 'speeding-severe-brief',
    rows: drive(200, (i) => ({ speedMph: between(i, 60, 68) ? 52 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), tier: 'severe', durationMin: 8, durationMax: 8 }],
  }),

  /** 5 s at 52 mph on a 35, back under the line within the 5-s grace: severe, but no incident. */
  'speeding-grace': () => ({
    name: 'speeding-grace',
    rows: drive(200, (i) => ({ speedMph: between(i, 60, 65) ? 52 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), absent: true }],
    noEvents: true,
  }),

  /** 3 s at 42 mph: within the 5-s grace, no incident. */
  'speeding-blip': () => ({
    name: 'speeding-blip',
    rows: drive(200, (i) => ({ speedMph: between(i, 60, 63) ? 42 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), absent: true }],
    noEvents: true,
  }),

  /** Hovering at 37 mph (between L+T−2 = 37 and L+T = 39) after 8 s over keeps the episode open: one incident. */
  'speeding-hover': () => ({
    name: 'speeding-hover',
    rows: drive(240, (i) => ({ speedMph: between(i, 60, 68) ? 42 : between(i, 68, 90) ? 37 : between(i, 90, 98) ? 42 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), tier: 'minor', durationMin: 15, durationMax: 17 }],
  }),

  /**
   * Five scattered 1-s blips over L+T, hovering at 37 (in the 2-mph buffer) between them: one episode
   * of five over rows, all within the grace: no incident.
   */
  'speeding-blip-hover': () => ({
    name: 'speeding-blip-hover',
    rows: drive(200, (i) => ({ speedMph: between(i, 60, 100) && i % 8 === 0 ? 41 : between(i, 60, 100) ? 37 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), absent: true }],
    noEvents: true,
  }),

  /**
   * 3 s over, one row under the buffer, 3 s over: one episode (it ends only after 5 s back under the
   * buffer), still over past the 5-s grace: an incident of 6 over rows from the first.
   */
  'speeding-split': () => ({
    name: 'speeding-split',
    rows: drive(200, (i) => ({ speedMph: between(i, 60, 63) || between(i, 64, 67) ? 42 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), tier: 'minor', durationMin: 6, durationMax: 6 }],
  }),

  /** The minor episode's 20 s at 41 mph, every over-limit row rating its speed at 3 m/s: no speeding event. */
  'speeding-poor-speedacc': () => ({
    name: 'speeding-poor-speedacc',
    rows: drive(240, (i) => ({ speedMph: between(i, 60, 80) ? 41 : 34, speedAcc: between(i, 60, 80) ? 3 : 0.5 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), absent: true }],
    noEvents: true,
  }),

  /** Speeding with a poor fix (hAcc 40 m): no speeding event. */
  'speeding-poor-gps': () => ({
    name: 'speeding-poor-gps',
    rows: drive(200, (i) => ({ speedMph: between(i, 60, 90) ? 50 : 34, hAcc: between(i, 55, 95) ? 40 : 5 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), absent: true }],
    noEvents: true,
  }),

  /** Speeding in the first 30 s only: the warm-up swallows it. */
  'speeding-warmup': () => ({
    name: 'speeding-warmup',
    rows: drive(200, (i) => ({ speedMph: i < 25 ? 55 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: T0, absent: true }],
    noEvents: true,
  }),

  /** A 0.35 g brake the GNSS confirms (35 → 25 mph in a second): one minor hard brake. */
  'hard-brake-confirmed': () => ({
    name: 'hard-brake-confirmed',
    rows: drive(200, (i) => ({ speedMph: i >= 100 ? 25 : 35, aLonMin: i === 100 ? -0.35 : -0.02 })),
    limits: [posted(35)],
    expected: [{ type: 'hard_brake', startsNear: at(100), tier: 'minor' }],
  }),

  /** The confirmed brake's drive, the phone rating its speed at 3 m/s on the brake and the row after: the GNSS cannot confirm it. */
  'hard-brake-poor-speedacc': () => ({
    name: 'hard-brake-poor-speedacc',
    rows: drive(200, (i) => ({ speedMph: i >= 100 ? 25 : 35, aLonMin: i === 100 ? -0.35 : -0.02, speedAcc: i === 100 || i === 101 ? 3 : 0.5 })),
    limits: [posted(35)],
    expected: [{ type: 'hard_brake', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /** A 0.60 g brake the GNSS confirms (45 → 30 mph): severe. */
  'hard-brake-severe': () => ({
    name: 'hard-brake-severe',
    rows: drive(200, (i) => ({ speedMph: i >= 100 ? 30 : 45, aLonMin: i === 100 ? -0.6 : -0.02 })),
    limits: [posted(45)],
    expected: [{ type: 'hard_brake', startsNear: at(100), tier: 'severe' }],
  }),

  /** A 0.45 g IMU spike with the GNSS speed unchanged: a jolt, not a brake. */
  'hard-brake-unconfirmed': () => ({
    name: 'hard-brake-unconfirmed',
    rows: drive(200, (i) => ({ aLonMin: i === 100 ? -0.45 : -0.02 })),
    limits: [posted(35)],
    expected: [{ type: 'hard_brake', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /** A 0.36 g acceleration the GNSS confirms (20 → 30 mph): one minor hard accel. */
  'hard-accel-confirmed': () => ({
    name: 'hard-accel-confirmed',
    rows: drive(200, (i) => ({ speedMph: i >= 100 ? 30 : 20, aLonMax: i === 100 ? 0.36 : 0.02 })),
    limits: [posted(35)],
    expected: [{ type: 'hard_accel', startsNear: at(100), tier: 'minor' }],
  }),

  /**
   * A 0.45 g push to the right (the lateral force is left-positive) with the gyroscope turning and
   * the course swinging 45° right in a second at 30 mph: plausible, one corner.
   */
  'hard-corner-plausible': () => ({
    name: 'hard-corner-plausible',
    rows: drive(200, (i) => ({ speedMph: 30, course: i >= 100 ? 135 : 90, aLatMin: i === 100 ? -0.45 : -0.02, yawRateMax: i === 100 ? 0.8 : 0.01 })),
    limits: [posted(35)],
    expected: [{ type: 'hard_corner', startsNear: at(100), tier: 'minor' }],
  }),

  /** The same turn with the push to the left, against the turn: a jolt, not the corner. */
  'hard-corner-wrong-side': () => ({
    name: 'hard-corner-wrong-side',
    rows: drive(200, (i) => ({ speedMph: 30, course: i >= 100 ? 135 : 90, aLatMax: i === 100 ? 0.45 : 0.02, yawRateMax: i === 100 ? 0.8 : 0.01 })),
    limits: [posted(35)],
    expected: [{ type: 'hard_corner', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /** The turn's push with no course on the fixes around it (-1, a fix with no bearing): nothing confirms it. */
  'hard-corner-no-course': () => ({
    name: 'hard-corner-no-course',
    rows: drive(200, (i) => ({ speedMph: 30, course: between(i, 95, 105) ? -1 : 90, aLatMin: i === 100 ? -0.45 : -0.02, yawRateMax: i === 100 ? 0.8 : 0.01 })),
    limits: [posted(35)],
    expected: [{ type: 'hard_corner', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /** The same lateral peak, the gyroscope reading a turn, on a dead-straight course: the phone, not the car. */
  'hard-corner-straight': () => ({
    name: 'hard-corner-straight',
    rows: drive(200, (i) => ({ speedMph: 30, aLatMin: i === 100 ? -0.45 : -0.02, yawRateMax: i === 100 ? 0.8 : 0.01 })),
    limits: [posted(35)],
    expected: [{ type: 'hard_corner', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /** The phone slides off the seat during a brake: an orientation spike within 2 s vetoes it. */
  'phone-slide-false-positive': () => ({
    name: 'phone-slide-false-positive',
    rows: drive(200, (i) => ({
      speedMph: i >= 100 ? 25 : 35,
      aLonMin: i === 100 ? -0.5 : -0.02,
      orientationDelta: i === 101 ? 0.8 : 0.01,
      gravityStability: i === 101 ? 0.3 : 0.99,
    })),
    limits: [posted(35)],
    expected: [{ type: 'hard_brake', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /**
   * A right turn at a city corner: 90° in 4 s at a steady 20 mph (0.36 g sideways, under the corner
   * line), the fixes following the road east then south: one turn, no event.
   */
  'turn-right-90': () => ({
    name: 'turn-right-90',
    rows: drive(
      200,
      (i) => {
        const turning = between(i, 100, 104);
        return {
          speedMph: 20,
          course: i < 100 ? 90 : i >= 104 ? 180 : 90 + 22.5 * (i - 99),
          aLatMin: turning ? -0.36 : -0.02,
          yawRateMax: turning ? 0.39 : 0.01,
        };
      },
      { followCourse: true }
    ),
    limits: [posted(25)],
    expected: [{ type: 'hard_corner', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /**
   * Stop-and-go: 30 mph, then three stops at lights (10 s down to 0 at 0.14 g, 20 s stopped, 10 s
   * back up to 30, 30 s at 30): three slowdowns and three speed-ups, no hard brake or start.
   */
  'stop-and-go': () => ({
    name: 'stop-and-go',
    rows: drive(250, (i) => {
      const k = i < 40 ? -1 : (i - 40) % 70;
      if (k < 0 || k >= 40) return { speedMph: 30 };
      if (k < 10) return { speedMph: 30 - 3 * (k + 1), aLonMin: -0.14 };
      if (k < 30) return { speedMph: 0 };
      return { speedMph: 3 * (k - 29), aLonMax: 0.14 };
    }),
    limits: [posted(35)],
    expected: [
      { type: 'hard_brake', startsNear: at(40), absent: true },
      { type: 'hard_accel', startsNear: at(70), absent: true },
    ],
    noEvents: true,
  }),

  /** The limit is unknown for a stretch: speed there is not judged. */
  'speeding-unknown-limit': () => ({
    name: 'speeding-unknown-limit',
    rows: drive(200, (i) => ({ speedMph: between(i, 60, 90) ? 55 : 34 })),
    limits: [posted(35), unknown(at(50)), posted(35, at(100))],
    expected: [{ type: 'speeding', startsNear: at(60), absent: true }],
    noEvents: true,
  }),
};

/** Stable JSON: one row per line, so a diff reads as rows. */
export function serializeTrace(trace: Trace): string {
  const { rows, ...rest } = trace;
  const head = JSON.stringify(rest, null, 2);
  const body = rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n');
  return `${head.slice(0, -2)},\n  "rows": [\n${body}\n  ]\n}\n`;
}
