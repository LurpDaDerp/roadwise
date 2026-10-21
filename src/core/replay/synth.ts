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
 * position, which is integrated from the speed so the GNSS agrees with itself.
 */
export function drive(n: number, shape: Shape = () => ({})): FeatureRow[] {
  const rows: FeatureRow[] = [];
  let lng = START.lng;
  for (let i = 0; i < n; i += 1) {
    const { speedMph, ...over } = shape(i);
    const mph = speedMph ?? 35;
    const speed = mph * MPH;
    rows.push({ ...ROW_DEFAULTS, ts: T0 + i * 1000, lat: START.lat, lng, speed, ...over });
    lng += speed / M_PER_DEG_LNG;
  }
  return rows;
}

const posted = (limitMph: number, fromTs = T0) => ({ fromTs, limitMps: limitMph * MPH, source: 'posted' as const, matchConfidence: 0.95, parallelRoads: false });
const unknown = (fromTs: number) => ({ fromTs, limitMps: null, source: 'unknown' as const, matchConfidence: 0, parallelRoads: false });

const at = (i: number): number => T0 + i * 1000;
const between = (i: number, a: number, b: number): boolean => i >= a && i < b;

/**
 * The navigation app opened with the navigation button: unlocked, screen on, RoadWise in the
 * background, and every row stamped with the button's exemption by the host.
 */
const NAVIGATION_IN_FRONT = { locked: false, screenOn: true, appForeground: false, exempt: 'nav' } as const;

/** Another app in front of an unlocked phone, reached any other way than the navigation button: a screen switch. */
const OTHER_APP = { locked: false, screenOn: true, appForeground: false } as const;
/** RoadWise in front of an unlocked phone with its screen on. */
const ROADWISE = { locked: false, screenOn: true, appForeground: true } as const;
/** iPhone: the lock report (protected data gone) with RoadWise in the background. */
const IOS_LOCKED = { locked: true, screenOn: false, appForeground: false } as const;

export const TRACE_BUILDERS: Record<string, () => Trace> = {
  /** A clean commute at the limit: nothing fires. */
  'clean-commute': () => ({
    name: 'clean-commute',
    rows: drive(300, (i) => ({ speedMph: 33 + (i % 3) })),
    limits: [posted(35)],
    expected: [
      { type: 'speeding', startsNear: T0, absent: true },
      { type: 'hard_brake', startsNear: T0, absent: true },
      { type: 'phone_pickup', startsNear: T0, absent: true },
    ],
    noEvents: true,
  }),

  /** 20 s at 41 mph on a 35 (T = 3: minor above 38): one minor episode of 20 s. */
  'speeding-minor': () => ({
    name: 'speeding-minor',
    rows: drive(240, (i) => ({ speedMph: between(i, 60, 80) ? 41 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), tier: 'minor', durationMin: 19, durationMax: 21 }],
  }),

  /** 4 s at 52 mph on a 35 (severe above 47): counts after 3 s; peak tier severe. */
  'speeding-severe-brief': () => ({
    name: 'speeding-severe-brief',
    rows: drive(200, (i) => ({ speedMph: between(i, 60, 64) ? 52 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), tier: 'severe', durationMin: 3, durationMax: 5 }],
  }),

  /** 3 s at 42 mph: under the 4-s minimum, no incident. */
  'speeding-blip': () => ({
    name: 'speeding-blip',
    rows: drive(200, (i) => ({ speedMph: between(i, 60, 63) ? 42 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), absent: true }],
    noEvents: true,
  }),

  /** Hovering at 37 mph (between L+T−2 and L+T) after 8 s over keeps the episode open: one incident. */
  'speeding-hover': () => ({
    name: 'speeding-hover',
    rows: drive(240, (i) => ({ speedMph: between(i, 60, 68) ? 42 : between(i, 68, 90) ? 37 : between(i, 90, 98) ? 42 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), tier: 'minor', durationMin: 15, durationMax: 17 }],
  }),

  /** Five scattered 1-s blips over L+T, hovering at L+T−1 between them: no incident (not continuous). */
  'speeding-blip-hover': () => ({
    name: 'speeding-blip-hover',
    rows: drive(200, (i) => ({ speedMph: between(i, 60, 100) && i % 8 === 0 ? 41 : between(i, 60, 100) ? 37 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), absent: true }],
    noEvents: true,
  }),

  /** 3 s over, one row under L+T, 3 s over: neither run reaches 4 s, so no incident. */
  'speeding-split': () => ({
    name: 'speeding-split',
    rows: drive(200, (i) => ({ speedMph: between(i, 60, 63) || between(i, 64, 67) ? 42 : 34 })),
    limits: [posted(35)],
    expected: [{ type: 'speeding', startsNear: at(60), absent: true }],
    noEvents: true,
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

  /** A 0.32 g acceleration the GNSS confirms (20 → 30 mph): one minor hard accel. */
  'hard-accel-confirmed': () => ({
    name: 'hard-accel-confirmed',
    rows: drive(200, (i) => ({ speedMph: i >= 100 ? 30 : 20, aLonMax: i === 100 ? 0.32 : 0.02 })),
    limits: [posted(35)],
    expected: [{ type: 'hard_accel', startsNear: at(100), tier: 'minor' }],
  }),

  /** A 0.45 g lateral peak with the course swinging 45° in a second at 30 mph: plausible, one corner. */
  'hard-corner-plausible': () => ({
    name: 'hard-corner-plausible',
    rows: drive(200, (i) => ({ speedMph: 30, course: i >= 100 ? 135 : 90, aLatMax: i === 100 ? 0.45 : 0.02 })),
    limits: [posted(35)],
    expected: [{ type: 'hard_corner', startsNear: at(100), tier: 'minor' }],
  }),

  /** The same lateral peak on a dead-straight course: the phone, not the car. */
  'hard-corner-straight': () => ({
    name: 'hard-corner-straight',
    rows: drive(200, (i) => ({ speedMph: 30, aLatMax: i === 100 ? 0.45 : 0.02 })),
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

  /** Handling for 8 s at 35 mph: one pickup of 8 s, no handling event. */
  'phone-pickup': () => ({
    name: 'phone-pickup',
    rows: drive(200, (i) => ({ handlingScore: between(i, 100, 108) ? 0.9 : 0, gravityStability: between(i, 100, 108) ? 0.6 : 0.99, locked: !between(i, 100, 108) })),
    limits: [posted(35)],
    expected: [
      { type: 'phone_pickup', startsNear: at(100), durationMin: 7, durationMax: 9, stoppedInTraffic: false },
      { type: 'phone_handling', startsNear: at(100), absent: true },
    ],
  }),

  /** Handling for 40 s: a pickup and a severe handling event of 25 s (2 units). */
  'phone-handling-long': () => ({
    name: 'phone-handling-long',
    rows: drive(240, (i) => ({ handlingScore: between(i, 100, 140) ? 0.9 : 0, gravityStability: between(i, 100, 140) ? 0.6 : 0.99 })),
    limits: [posted(35)],
    expected: [
      { type: 'phone_pickup', startsNear: at(100), durationMin: 39, durationMax: 41 },
      { type: 'phone_handling', startsNear: at(115), tier: 'severe', durationMin: 24, durationMax: 26 },
    ],
  }),

  /** A 2-s tap on a mounted, stable phone: not a pickup. */
  'phone-tap-mounted': () => ({
    name: 'phone-tap-mounted',
    rows: drive(200, (i) => ({ handlingScore: between(i, 100, 102) ? 0.8 : 0 })),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /** Handling for 10 s while stopped at a light mid-drive: a pickup, stopped in traffic. */
  'phone-stopped-in-traffic': () => ({
    name: 'phone-stopped-in-traffic',
    rows: drive(240, (i) => ({ speedMph: between(i, 90, 130) ? 0 : 35, handlingScore: between(i, 100, 110) ? 0.9 : 0, gravityStability: between(i, 100, 110) ? 0.6 : 0.99 })),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(100), stoppedInTraffic: true }],
  }),

  /** Handling before the car has ever moved (parked at the start): nothing. */
  'phone-parked-start': () => ({
    name: 'phone-parked-start',
    rows: drive(200, (i) => ({ speedMph: i < 80 ? 0 : 35, handlingScore: between(i, 40, 60) ? 0.9 : 0, gravityStability: between(i, 40, 60) ? 0.6 : 0.99 })),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(40), absent: true }],
    noEvents: true,
  }),

  /** Handling during a hands-free call: suppressed. */
  'phone-hands-free-call': () => ({
    name: 'phone-hands-free-call',
    callActive: true,
    rows: drive(200, (i) => ({ handlingScore: between(i, 100, 110) ? 0.9 : 0, gravityStability: between(i, 100, 110) ? 0.6 : 0.99 })),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /**
   * The navigation app, opened with the navigation button, in front the whole drive: unlocked,
   * screen on, RoadWise in the background, the phone steady in its mount with road shake, potholes,
   * a GPS gap and a stop: no phone use.
   */
  'phone-navigation-in-front': () => ({
    name: 'phone-navigation-in-front',
    rows: drive(300, (i) => {
      const pothole = between(i, 60, 62) || between(i, 90, 92) || between(i, 150, 152);
      return {
        ...NAVIGATION_IN_FRONT,
        speedMph: between(i, 200, 231) ? 0 : 35,
        hAcc: between(i, 120, 125) ? 40 : 5,
        handlingScore: pothole ? 0.7 : i % 7 === 0 ? 0.3 : 0.1,
        gravityStability: pothole ? 0.6 : 0.93,
      };
    }),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(40), absent: true }],
    noEvents: true,
  }),

  /** The phone lifted and handled for 10 s over the navigation app opened with the button: a pickup (motion counts there too). */
  'phone-handled-over-navigation': () => ({
    name: 'phone-handled-over-navigation',
    rows: drive(200, (i) => ({
      ...NAVIGATION_IN_FRONT,
      handlingScore: between(i, 100, 110) ? 0.9 : 0,
      gravityStability: between(i, 100, 110) ? 0.6 : 0.99,
    })),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(100), durationMin: 9, durationMax: 11 }],
  }),

  /** Android: 41 s in another app at 35 mph: one pickup from the first away row, and handling past 15 s. */
  'phone-switch-android': () => ({
    name: 'phone-switch-android',
    rows: drive(240, (i) => (between(i, 100, 141) ? OTHER_APP : ROADWISE)),
    limits: [posted(35)],
    expected: [
      { type: 'phone_pickup', startsNear: at(100), durationMin: 40, durationMax: 42 },
      { type: 'phone_handling', startsNear: at(115), tier: 'severe' },
    ],
  }),

  /** A counted switch through a 6-s GPS gap is one pickup, not two. */
  'phone-switch-gps-gap': () => ({
    name: 'phone-switch-gps-gap',
    rows: drive(240, (i) => {
      if (!between(i, 100, 160)) return ROADWISE;
      if (between(i, 120, 126)) return { ...OTHER_APP, gnssValid: false, hAcc: 9999, speedAcc: -1, course: -1, speedMph: 35, speed: -1 };
      return OTHER_APP;
    }),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(100), durationMin: 59, durationMax: 61 }],
  }),

  /** Android: RoadWise not in front while the phone is locked with its screen off: never a switch. */
  'phone-switch-locked': () => ({
    name: 'phone-switch-locked',
    rows: drive(240, (i) => (between(i, 100, 161) ? { locked: true, screenOn: false, appForeground: false } : ROADWISE)),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /** The dialer in front through a 61-s call: the call's own screen, not a switch. */
  'phone-switch-call': () => ({
    name: 'phone-switch-call',
    rows: drive(240, (i) => (between(i, 100, 161) ? { ...OTHER_APP, call: 'live' as const } : ROADWISE)),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /** Another app in front while parked before the car ever moved, kept as it pulls away: charged from the first second above 5 mph. */
  'phone-switch-parked-start': () => ({
    name: 'phone-switch-parked-start',
    rows: drive(200, (i) => ({ ...(i < 90 ? OTHER_APP : ROADWISE), speedMph: i < 60 ? 0 : 35 })),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(60), durationMin: 29, durationMax: 31, stoppedInTraffic: false }],
  }),

  /**
   * Android: three 2-s switches (each too short to count alone) with 4 s back in RoadWise between
   * them: one pickup at the third return, from the first one's start, no handling.
   */
  'phone-switch-burst': () => ({
    name: 'phone-switch-burst',
    rows: drive(240, (i) => (between(i, 100, 102) || between(i, 106, 108) || between(i, 112, 114) ? OTHER_APP : ROADWISE)),
    limits: [posted(35)],
    expected: [
      { type: 'phone_pickup', startsNear: at(100), durationMin: 14, durationMax: 14 },
      { type: 'phone_handling', startsNear: at(100), absent: true },
    ],
  }),

  /** iPhone: the side button pressed with RoadWise in front; its lock report 10 s later: not a switch. */
  'phone-switch-ios-lock': () => ({
    name: 'phone-switch-ios-lock',
    switchSignal: 'lagged',
    platform: 'ios',
    rows: drive(240, (i) => (between(i, 100, 110) ? OTHER_APP : i >= 110 && i < 200 ? IOS_LOCKED : ROADWISE)),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /** iPhone: a lock report 17 s late: never counted (an iPhone switch counts at 26 s), so no alert and nothing charged. */
  'phone-switch-ios-slow-lock': () => ({
    name: 'phone-switch-ios-slow-lock',
    switchSignal: 'lagged',
    platform: 'ios',
    rows: drive(240, (i) => (between(i, 100, 117) ? OTHER_APP : i >= 117 && i < 200 ? IOS_LOCKED : ROADWISE)),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(100), absent: true }],
    noEvents: true,
  }),

  /** iPhone: 41 s in another app: one pickup from the first away row (it counts at 26 s). */
  'phone-switch-ios': () => ({
    name: 'phone-switch-ios',
    switchSignal: 'lagged',
    platform: 'ios',
    rows: drive(240, (i) => (between(i, 100, 141) ? OTHER_APP : ROADWISE)),
    limits: [posted(35)],
    expected: [{ type: 'phone_pickup', startsNear: at(100), durationMin: 40, durationMax: 42 }],
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
