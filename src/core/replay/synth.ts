// The synthetic traces: one deterministic builder per fixture in `src/core/__fixtures__/traces`.
//
// `scripts/make-traces.js` writes what these builders return, and `__tests__/traces.test.ts`
// asserts the files on disk are byte-for-byte what they return today — so a fixture can never
// drift from the code that claims to generate it, and nobody has to trust a hand-edited JSON blob.
//
// Two rules keep that honest:
//  1. Nothing random. Every number here is written down or derived from one that is.
//  2. Nothing imported at run time — only types, which are erased. That is what lets
//     `node --experimental-strip-types scripts/make-traces.js` require this module directly
//     (an `@scoring` or `@/` specifier would not resolve under plain Node), and it is why the
//     constants below are spelled out instead of read from `CONSTANTS`.
import type { EventCategory } from '@scoring';
import type { DriveMode, FeatureRow } from '../engine/types';
import type { Expectation, LimitEntry, Trace } from './trace';

/** Epoch ms of row 0, the same second the detector fixtures start at. */
export const T0 = 1_700_000_000_000;

/** Standard gravity, m/s²: turns the speed profile into the longitudinal g the IMU would report. */
const G = 9.80665;

/** Fixed-point rounding, so the JSON never carries 0.30000000000000004 — and never a -0. */
const round = (value: number, digits: number): number => {
  const rounded = Number(value.toFixed(digits));
  return rounded === 0 ? 0 : rounded;
};

/** m/s per mph. Spelled out here for the same reason as `G`; `traces.test.ts` pins it. */
export const MPH = 0.44704;

const mps = (mph: number): number => round(mph * MPH, 4);

/** Every trace is one 2½ minute drive at 1 Hz, but for `garage-no-fix`, which has to outlast `NO_FIX_END_S`. */
const ROWS = 150;
/** Pulling away and stopping take this long: 0.13 g, comfortably inside the harsh thresholds. */
const RAMP_S = 12;
/** m/s — 33.6 mph, under a 35 mph limit with room for the tolerance. */
const CRUISE = 15.01;
/** m/s — 35.0 mph exactly, for the traces that want the phone signals at 35. */
const CRUISE_35 = 15.65;
const LIMIT_35 = mps(35);
const LIMIT_40 = mps(40);

/** Downtown Seattle; every trace drives due east from here along a single line of latitude. */
const START_LAT = 47.6062;
const START_LNG = -122.3321;
/**
 * Metres per degree of longitude at 47.6062°N (111 320 m × cos 47.6062° ≈ 75 054), written out
 * rather than computed: `Math.cos` is not specified to the last bit, and these files have to
 * regenerate byte-for-byte on any engine.
 */
const M_PER_DEG_LNG = 75_054;

/**
 * The quiet-second defaults of `src/core/detectors/__fixtures__/rows.ts`. A trace is only a
 * regression suite if an uneventful second here looks exactly like an uneventful second there,
 * which `traces.test.ts` pins.
 */
export const ROW_DEFAULTS = {
  hAcc: 5,
  speedAcc: 0.5,
  course: 90,
  alt: 10,
  gnssValid: true,
  aLatMax: 0,
  aLatMin: 0,
  yawRateMax: 0,
  jerkMax: 0,
  gravityStability: 1,
  orientationDelta: 0,
  handlingScore: 0,
  locked: true,
  screenOn: false,
  appForeground: true,
} as const satisfies Partial<FeatureRow>;

const tsOf = (i: number): number => T0 + i * 1000;

/** `count` rows at `speed`. */
const hold = (count: number, speed: number): number[] => new Array<number>(count).fill(speed);

/** `count` rows ramping linearly from `from` (exclusive) to `to` (inclusive). */
const ramp = (from: number, to: number, count: number): number[] =>
  Array.from({ length: count }, (_, k) => round(from + ((to - from) * (k + 1)) / count, 2));

type Window = readonly [fromRow: number, toRow: number, patch: Partial<FeatureRow>];

/** Per-row overrides: every half-open `[fromRow, toRow)` window covering the row, applied in order. */
const windows =
  (...list: readonly Window[]) =>
  (i: number): Partial<FeatureRow> =>
    list.reduce<Partial<FeatureRow>>(
      (patch, [from, to, over]) => (i >= from && i < to ? { ...patch, ...over } : patch),
      {}
    );

const NO_OVERRIDES = (): Partial<FeatureRow> => ({});

/**
 * One row of the drive. The longitudinal g is the speed profile's own acceleration, so the IMU and
 * the GNSS agree unless a window deliberately makes them disagree.
 */
function makeRow(
  i: number,
  speed: number,
  lng: number,
  aLon: number,
  over: Partial<FeatureRow>
): FeatureRow {
  const base: FeatureRow = {
    ts: tsOf(i),
    lat: START_LAT,
    lng,
    hAcc: ROW_DEFAULTS.hAcc,
    speed,
    speedAcc: ROW_DEFAULTS.speedAcc,
    course: ROW_DEFAULTS.course,
    alt: ROW_DEFAULTS.alt,
    gnssValid: ROW_DEFAULTS.gnssValid,
    aLonMax: Math.max(aLon, 0),
    aLonMin: Math.min(aLon, 0),
    aLatMax: ROW_DEFAULTS.aLatMax,
    aLatMin: ROW_DEFAULTS.aLatMin,
    yawRateMax: ROW_DEFAULTS.yawRateMax,
    jerkMax: ROW_DEFAULTS.jerkMax,
    gravityStability: ROW_DEFAULTS.gravityStability,
    orientationDelta: ROW_DEFAULTS.orientationDelta,
    handlingScore: ROW_DEFAULTS.handlingScore,
    locked: ROW_DEFAULTS.locked,
    screenOn: ROW_DEFAULTS.screenOn,
    appForeground: ROW_DEFAULTS.appForeground,
  };
  // Spreading an override of an existing key keeps the key order, which keeps the JSON stable.
  return { ...base, ...over };
}

/** Turn a speed profile into rows, integrating the position eastward one second at a time. */
function rowsFrom(
  speeds: readonly number[],
  over: (i: number) => Partial<FeatureRow> = NO_OVERRIDES
): FeatureRow[] {
  const rows: FeatureRow[] = [];
  let lng = START_LNG;
  let previous = 0; // every trace starts at rest
  for (const [i, speed] of speeds.entries()) {
    rows.push(makeRow(i, speed, round(lng, 7), round((speed - previous) / G, 4), over(i)));
    lng += speed / M_PER_DEG_LNG;
    previous = speed;
  }
  return rows;
}

const posted = (limitMps: number): LimitEntry => ({
  fromTs: T0,
  limitMps,
  source: 'posted',
  matchConfidence: 1,
  parallelRoads: false,
});

const CATEGORIES: readonly EventCategory[] = [
  'phone',
  'speeding',
  'braking',
  'accel',
  'cornering',
  'focus',
];

/**
 * "Nothing else scored": an `absent` expectation for every category the trace is not about. This
 * is what turns a trace from "the event I wanted turned up" into a regression test.
 */
const absentExcept = (...scored: readonly EventCategory[]): Expectation[] =>
  CATEGORIES.filter((category) => !scored.includes(category)).map((category) => ({
    category,
    startsNear: tsOf(ROWS / 2),
    absent: true,
  }));

interface TraceParts {
  name: string;
  mode: DriveMode;
  speeds: readonly number[];
  over?: (i: number) => Partial<FeatureRow>;
  limits: LimitEntry[];
  expected: Expectation[];
  noEvents?: true;
  night?: boolean;
  precipitation?: boolean;
  lockSignal?: 'reliable' | 'lagged' | 'unreliable';
}

const makeTrace = (parts: TraceParts): Trace => ({
  name: parts.name,
  mode: parts.mode,
  night: parts.night ?? false,
  precipitation: parts.precipitation ?? false,
  // Omitted rather than written as `reliable`, so the M1 fixtures stay byte-for-byte as they were.
  ...(parts.lockSignal ? { lockSignal: parts.lockSignal } : {}),
  // Omitted rather than written as `false`: the schema takes the flag or nothing.
  ...(parts.noEvents ? { noEvents: parts.noEvents } : {}),
  limits: parts.limits,
  expected: parts.expected,
  rows: rowsFrom(parts.speeds, parts.over),
});

/** Pull away, cruise, stop: the drive every trace that does not need its own profile rides on. */
const COMMUTE = [
  ...ramp(0, CRUISE, RAMP_S),
  ...hold(ROWS - 2 * RAMP_S, CRUISE),
  ...ramp(CRUISE, 0, RAMP_S),
];

/** The row each trace's interesting stretch starts on, so the expectation reads next to the cause. */
const EVENT_ROW = 60;
/** `garage-no-fix`: the first row without a fix, and how many follow (eleven minutes). */
export const GARAGE_ROW = 52;
const GARAGE_ROWS = 660;

export const TRACE_BUILDERS: Record<string, () => Trace> = {
  /**
   * A drive with nothing in it. `noEvents` is the real assertion — not one event of any status,
   * so a new false positive that only ever reaches `possible` fails here too. The `absent`
   * expectations stay as the per-category reading of the same fact.
   */
  'clean-commute': () =>
    makeTrace({
      name: 'clean-commute',
      mode: 'mounted',
      speeds: COMMUTE,
      limits: [posted(LIMIT_35)],
      noEvents: true,
      expected: absentExcept(),
    }),

  /**
   * 12 mph over a 35 for 45 s, then back under. Rows 34-78 are above limit + tolerance: the two
   * rows of the pull-away that cross it, 41 seconds at 21.01 m/s, and the two of the pull-back.
   */
  'speeding-corrected': () =>
    makeTrace({
      name: 'speeding-corrected',
      mode: 'mounted',
      speeds: [
        ...ramp(0, CRUISE, RAMP_S), // 0-11
        ...hold(20, CRUISE), // 12-31
        ...ramp(CRUISE, 21.01, 5), // 32-36, over from row 34
        ...hold(40, 21.01), // 37-76
        ...ramp(21.01, CRUISE, 5), // 77-81, back under at row 79
        ...hold(56, CRUISE), // 82-137
        ...ramp(CRUISE, 0, RAMP_S), // 138-149
      ],
      limits: [posted(LIMIT_35)],
      expected: [
        {
          category: 'speeding',
          startsNear: tsOf(34),
          qMin: 0.8,
          durationMin: 43,
          durationMax: 47,
          status: 'scored',
        },
        ...absentExcept('speeding'),
      ],
    }),

  /**
   * One 0.42 g brake the GNSS confirms: the second before it the car is doing 13 m/s and the
   * braking second 8.88 — a 4.12 m/s drop, which is that same 0.42 g. Mounted and steady, so q is
   * the full 0.95, and the rows either side stay inside the 0.30 g threshold.
   */
  'hard-brake-agreeing': () =>
    makeTrace({
      name: 'hard-brake-agreeing',
      mode: 'mounted',
      speeds: [
        ...ramp(0, CRUISE, RAMP_S), // 0-11
        ...hold(48, CRUISE), // 12-59
        13.0, // 60: -0.21 g, easing off
        8.88, // 61: -0.42 g, the brake
        7.0, // 62: -0.19 g
        6.0, // 63: -0.10 g
        ...hold(4, 6.0), // 64-67
        ...ramp(6.0, CRUISE, RAMP_S), // 68-79
        ...hold(58, CRUISE), // 80-137
        ...ramp(CRUISE, 0, RAMP_S), // 138-149
      ],
      over: windows([61, 62, { aLonMin: -0.42 }]),
      limits: [posted(LIMIT_35)],
      expected: [
        {
          category: 'braking',
          startsNear: tsOf(61),
          qMin: 0.85,
          durationMin: 1,
          durationMax: 1,
          status: 'scored',
        },
        ...absentExcept('braking'),
      ],
    }),

  /**
   * The phone slides off the seat: a 0.5 g reading with an orientation spike and no deceleration
   * in the GNSS at all. The detector still logs it, but at q 0.3 — possible, never scored.
   */
  'phone-slide-false-positive': () =>
    makeTrace({
      name: 'phone-slide-false-positive',
      mode: 'pocket',
      speeds: COMMUTE,
      over: windows(
        [
          EVENT_ROW,
          EVENT_ROW + 1,
          {
            aLonMin: -0.5,
            aLatMax: 0.2,
            orientationDelta: 1.2,
            gravityStability: 0.35,
            handlingScore: 0.3,
          },
        ],
        [EVENT_ROW + 1, EVENT_ROW + 3, { orientationDelta: 0.8, gravityStability: 0.5 }]
      ),
      limits: [posted(LIMIT_35)],
      expected: [
        { category: 'braking', startsNear: tsOf(EVENT_ROW), qMax: 0.3, status: 'possible' },
        ...absentExcept(),
      ],
    }),

  /** The phone is picked up and unlocked for eight seconds at 35 mph: q 0.9, and alertable. */
  'phone-pickup': () =>
    makeTrace({
      name: 'phone-pickup',
      mode: 'mounted',
      speeds: [
        ...ramp(0, CRUISE_35, RAMP_S),
        ...hold(ROWS - 2 * RAMP_S, CRUISE_35),
        ...ramp(CRUISE_35, 0, RAMP_S),
      ],
      over: windows(
        [
          EVENT_ROW,
          EVENT_ROW + 8,
          {
            handlingScore: 0.85,
            locked: false,
            screenOn: true,
            orientationDelta: 0.5,
            gravityStability: 0.55,
          },
        ],
        // Put down, screen still lit: two quiet seconds close the episode without extending it.
        [EVENT_ROW + 8, EVENT_ROW + 15, { locked: false, screenOn: true }]
      ),
      limits: [posted(LIMIT_40)],
      expected: [
        {
          category: 'phone',
          startsNear: tsOf(EVENT_ROW),
          qMin: 0.9,
          durationMin: 8,
          durationMax: 8,
          status: 'scored',
        },
        ...absentExcept('phone'),
      ],
    }),

  /**
   * The same handling, unlocked, at a red light. Below the lockout speed it is logged as possible
   * at speed 0 and never scored — the whole point of the stopped phase.
   */
  'stopped-phone-use': () =>
    makeTrace({
      name: 'stopped-phone-use',
      mode: 'mounted',
      speeds: [
        ...ramp(0, CRUISE, RAMP_S), // 0-11
        ...hold(36, CRUISE), // 12-47
        ...ramp(CRUISE, 0, RAMP_S), // 48-59, stopped from row 59
        ...hold(30, 0), // 60-89
        ...ramp(0, CRUISE, RAMP_S), // 90-101
        ...hold(36, CRUISE), // 102-137
        ...ramp(CRUISE, 0, RAMP_S), // 138-149
      ],
      over: windows([
        62,
        75,
        {
          handlingScore: 0.85,
          locked: false,
          screenOn: true,
          orientationDelta: 0.45,
          gravityStability: 0.5,
        },
      ]),
      limits: [posted(LIMIT_35)],
      expected: [
        // Logged for the summary, at the confidence of unlocked handling — but never scored.
        {
          category: 'phone',
          startsNear: tsOf(62),
          qMax: 0.9,
          durationMin: 13,
          durationMax: 13,
          status: 'possible',
        },
        ...absentExcept(),
      ],
    }),

  /** RoadWise pushed to the background for 20 s on a mount, while moving: a phone event at 0.9. */
  'mounted-app-switch': () =>
    makeTrace({
      name: 'mounted-app-switch',
      mode: 'mounted',
      speeds: COMMUTE,
      over: windows([
        EVENT_ROW,
        EVENT_ROW + 20,
        { appForeground: false, locked: false, screenOn: true },
      ]),
      limits: [posted(LIMIT_35)],
      expected: [
        {
          category: 'phone',
          startsNear: tsOf(EVENT_ROW),
          qMin: 0.9,
          durationMin: 20,
          durationMax: 20,
          status: 'scored',
        },
        ...absentExcept('phone'),
      ],
    }),

  /**
   * SR8: a pocket drive, the phone locked in a pocket, and at 33.6 mph RoadWise is opened on an
   * unlocked screen for six seconds. Opening it is the phone use — one second of it, at the
   * app-switch confidence 0.9 from the OS — and nothing else happens. Mounted, the same rows are
   * a driver glancing at the HUD they chose to mount, and are nothing (`traces.test.ts`).
   */
  'pocket-open-moving': () =>
    makeTrace({
      name: 'pocket-open-moving',
      mode: 'pocket',
      speeds: COMMUTE,
      over: windows([EVENT_ROW, EVENT_ROW + 6, { locked: false, screenOn: true }]),
      limits: [posted(LIMIT_35)],
      expected: [
        {
          category: 'phone',
          startsNear: tsOf(EVENT_ROW),
          toleranceS: 0,
          qMin: 0.9,
          durationMin: 1,
          durationMax: 1,
          status: 'scored',
        },
        ...absentExcept('phone'),
      ],
    }),

  /**
   * A mounted drive where the phone is locked for a minute at speed: RoadWise is backgrounded
   * because the phone is locked, not because another app is open. A locked phone is never phone
   * use (plan rev1 I11) — not one event of any status.
   */
  'mounted-locked': () =>
    makeTrace({
      name: 'mounted-locked',
      mode: 'mounted',
      speeds: COMMUTE,
      over: windows([40, 100, { appForeground: false, locked: true, screenOn: false }]),
      limits: [posted(LIMIT_35)],
      noEvents: true,
      expected: absentExcept(),
    }),

  /**
   * Into an underground garage: the fix goes at walking pace on the ramp (row 52), the car parks,
   * and the phone lies still with no fix for eleven minutes. No speed ever says "stopped", so the
   * stationary auto-end never runs; the no-fix end does, ten minutes into the fix-less stillness
   * (`traces.test.ts` replays it through the engine). The detectors see nothing at all.
   */
  'garage-no-fix': () =>
    makeTrace({
      name: 'garage-no-fix',
      mode: 'mounted',
      speeds: [
        ...ramp(0, CRUISE, RAMP_S), // 0-11
        ...hold(30, CRUISE), // 12-41
        ...ramp(CRUISE, 3, 10), // 42-51, down the ramp
        ...hold(GARAGE_ROWS, 0), // 52-711: no fix; 0 only keeps the position where it was lost
      ],
      over: windows([
        GARAGE_ROW,
        GARAGE_ROW + GARAGE_ROWS,
        { speed: -1, gnssValid: false, aLonMax: 0, aLonMin: 0 },
      ]),
      limits: [posted(LIMIT_35)],
      noEvents: true,
      expected: absentExcept(),
    }),
};

/**
 * The exact bytes of a fixture: one row per line, so a 150-second drive stays readable and a diff
 * shows the seconds that changed. `JSON.stringify` preserves insertion order, and every builder
 * writes its keys in the same order, so this is stable across runs.
 */
export function serializeTrace(trace: Trace): string {
  const block = (key: string, items: readonly unknown[]): string =>
    items.length === 0
      ? `  "${key}": []`
      : [
          `  "${key}": [`,
          items.map((item) => `    ${JSON.stringify(item)}`).join(',\n'),
          '  ]',
        ].join('\n');
  const members = [
    `  "name": ${JSON.stringify(trace.name)}`,
    `  "mode": ${JSON.stringify(trace.mode)}`,
    `  "night": ${JSON.stringify(trace.night)}`,
    `  "precipitation": ${JSON.stringify(trace.precipitation)}`,
    ...(trace.lockSignal ? [`  "lockSignal": ${JSON.stringify(trace.lockSignal)}`] : []),
    ...(trace.noEvents ? ['  "noEvents": true'] : []),
    block('limits', trace.limits),
    block('expected', trace.expected),
    block('rows', trace.rows),
  ];
  return `{\n${members.join(',\n')}\n}\n`;
}
