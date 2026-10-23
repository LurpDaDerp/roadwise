import {
  DASHCAM_EVENT_TYPES,
  SCORING_VERSION,
  SPEEDING_MAX_OVER_MPH,
  classifyDrive,
  dashcamDrive,
  isDashcamType,
  keepDashcamEvents,
  phonePickupTier,
  speedTier,
  speedTolerance,
  speedingChargedS,
  tooShort,
  type DriveEvent,
  type EventType,
} from '../src/drive';
import { PHONE_SEVERE_S } from '../src/thresholds';
import * as barrel from '../src';

let seq = 0;
const ev = (p: Partial<DriveEvent> & Pick<DriveEvent, 'type' | 'tier'>): DriveEvent => {
  seq += 1;
  return { id: `e${seq}`, startedAt: 1_000_000 + seq * 1000, durationS: 0, ...p };
};

describe('speedTolerance — T(L) for every row of the spec table', () => {
  test.each([
    [25, 3],
    [30, 3],
    [35, 4],
    [40, 5],
    [45, 5],
    [50, 6],
    [55, 7],
    [60, 8],
    [65, 9],
    [70, 9],
  ])('L=%i → T=%i', (L, T) => expect(speedTolerance(L)).toBe(T));

  test('low limits clamp up to 3 (L=20 without a zone: 2.1 → 2, less 1 → 1)', () => expect(speedTolerance(20)).toBe(3));
  test('high limits clamp down to 9 (L=68: 10.5 → 11, less 1 → 10)', () => expect(speedTolerance(68)).toBe(9));
  test('school and construction zones fix T at 2', () => {
    expect(speedTolerance(20, 'school')).toBe(2);
    expect(speedTolerance(65, 'construction')).toBe(2);
    expect(speedTolerance(65, null)).toBe(9);
  });
});

describe('speedTier — tier boundaries for every row', () => {
  // [limit, zone, minor above, moderate above, severe above]
  test.each([
    [20, 'school', 22, 26, 31],
    [25, null, 28, 32, 37],
    [30, null, 33, 37, 42],
    [35, null, 39, 43, 48],
    [45, null, 50, 54, 59],
    [55, null, 62, 66, 71],
    [60, null, 68, 72, 77],
    [65, null, 74, 78, 83],
    [70, null, 79, 83, 88],
  ] as const)('L=%i (%s): minor >%i, moderate >%i, severe >%i', (L, zone, minor, moderate, severe) => {
    expect(speedTier(minor, L, zone)).toBeNull();
    expect(speedTier(minor + 0.1, L, zone)).toBe('minor');
    expect(speedTier(moderate, L, zone)).toBe('minor');
    expect(speedTier(moderate + 0.1, L, zone)).toBe('moderate');
    expect(speedTier(severe, L, zone)).toBe('moderate');
    expect(speedTier(severe + 0.1, L, zone)).toBe('severe');
  });

  test('under the limit is not speeding', () => expect(speedTier(10, 25)).toBeNull());
});

describe('speeding: charged seconds', () => {
  test('the constants', () => {
    expect(SPEEDING_MAX_OVER_MPH).toBe(150);
    expect(Object.keys(barrel)).not.toContain('SPEEDING_GRACE_S');
  });

  test('charged seconds: every over-the-line row (no grace), never under 1', () => {
    expect(speedingChargedS(1)).toBe(1);
    expect(speedingChargedS(5)).toBe(5);
    expect(speedingChargedS(6)).toBe(6);
    expect(speedingChargedS(15)).toBe(15);
    expect(speedingChargedS(0)).toBe(1);
    expect(speedingChargedS(-3)).toBe(1);
    expect(speedingChargedS(Number.NaN)).toBe(1);
    expect(speedingChargedS(35.5)).toBe(35.5);
  });
});

describe('DashPal event types', () => {
  test('the two DashPal types, and only them', () => {
    expect(DASHCAM_EVENT_TYPES).toEqual(['eyes_off', 'drowsy']);
    expect(isDashcamType('drowsy')).toBe(true);
    expect(isDashcamType('eyes_off')).toBe(true);
    for (const t of ['speeding', 'hard_brake', 'hard_accel', 'hard_corner'] as const) expect(isDashcamType(t)).toBe(false);
  });
});

describe('dashcamDrive — synced, ≥ 60 s moving, ≥ 80 % covered', () => {
  test.each([
    [{ movingS: 600, coveredS: 480, synced: true }, true],
    [{ movingS: 600, coveredS: 479, synced: true }, false],
    [{ movingS: 600, coveredS: 600, synced: false }, false],
    [{ movingS: 60, coveredS: 48, synced: true }, true],
    [{ movingS: 59, coveredS: 59, synced: true }, false],
    [{ movingS: 0, coveredS: 0, synced: true }, false],
    [{ movingS: 100.9, coveredS: 80.2, synced: true }, true], // whole seconds: 100 and 80
    [{ movingS: Number.NaN, coveredS: 100, synced: true }, false],
  ])('%j → %s', (d, on) => expect(dashcamDrive(d)).toBe(on));

  test('nothing reported is not a DashPal drive', () => {
    expect(dashcamDrive(null)).toBe(false);
    expect(dashcamDrive(undefined)).toBe(false);
  });
});

describe('tooShort: under 0.5 mi AND under 2 min', () => {
  test('either 0.5 mi or 2 min makes a drive long enough', () => {
    expect(tooShort(0.49, 119)).toBe(true);
    expect(tooShort(0.5, 0)).toBe(false);
    expect(tooShort(0.3, 120)).toBe(false);
    expect(tooShort(0, 600)).toBe(false);
  });

  test('a missing or unreadable duration reads as 0, so the miles-only rule stands', () => {
    expect(tooShort(0.49, undefined)).toBe(true);
    expect(tooShort(0.49, Number.NaN)).toBe(true);
    expect(tooShort(0.49, 119.9)).toBe(true);
    expect(tooShort(0.49, 120)).toBe(false);
    expect(tooShort(0.5, undefined)).toBe(false);
    expect(tooShort(Number.NaN, 0)).toBe(true);
  });
});

describe('classifyDrive: scored, reason and the events that break clean', () => {
  test('a long enough drive scores, with no reason', () => {
    expect(classifyDrive({ miles: 6, durationS: 900, events: [] })).toEqual({ scored: true, reason: null, activeEventCount: 0 });
  });

  test('too short both ways: under 0.5 mi and under 2 min', () => {
    expect(classifyDrive({ miles: 0.49, durationS: 119, events: [] })).toEqual({ scored: false, reason: 'too_short', activeEventCount: 0 });
    expect(classifyDrive({ miles: 0.49, events: [] }).scored).toBe(false);
    expect(classifyDrive({ miles: 0.5, durationS: 0, events: [] }).scored).toBe(true);
    expect(classifyDrive({ miles: 0.3, durationS: 120, events: [] }).scored).toBe(true);
  });

  test('every active phone-detected event counts, a phone pickup included; DashPal events never break clean', () => {
    const events = [
      ev({ type: 'hard_brake', tier: 'minor' }),
      ev({ type: 'speeding', tier: 'severe' }),
      ev({ type: 'phone_pickup', tier: 'moderate', durationS: 6 }),
      ev({ type: 'drowsy', tier: 'severe' }),
      ev({ type: 'eyes_off', tier: 'severe' }),
    ];
    expect(classifyDrive({ miles: 5, durationS: 600, events })).toEqual({ scored: true, reason: null, activeEventCount: 3 });
    expect(classifyDrive({ miles: 5, durationS: 600, events: events.slice(3) }).activeEventCount).toBe(0);
    expect(classifyDrive({ miles: 5, durationS: 600, events: events.slice(2, 3) }).activeEventCount).toBe(1);
  });

  test('removed (disputed) events are ignored', () => {
    const events = [ev({ type: 'hard_corner', tier: 'severe', status: 'removed' }), ev({ type: 'hard_accel', tier: 'minor', status: 'active' })];
    expect(classifyDrive({ miles: 5, durationS: 600, events }).activeEventCount).toBe(1);
    expect(classifyDrive({ miles: 5, durationS: 600, events: events.slice(0, 1) }).activeEventCount).toBe(0);
  });

  test('a too-short drive still counts its events (clean = scored && none)', () => {
    const c = classifyDrive({ miles: 0.2, durationS: 60, events: [ev({ type: 'hard_brake', tier: 'severe' })] });
    expect(c).toEqual({ scored: false, reason: 'too_short', activeEventCount: 1 });
  });

  test('reads only type and status, and does not mutate its input', () => {
    const events: { type: EventType; status?: 'active' | 'removed' }[] = [{ type: 'hard_brake' }, { type: 'speeding', status: 'removed' }];
    const copy = JSON.parse(JSON.stringify(events));
    expect(classifyDrive({ miles: 1, events }).activeEventCount).toBe(1);
    expect(events).toEqual(copy);
  });
});

describe('phonePickupTier: moderate up to 15 s in hand, severe beyond', () => {
  test.each([
    [1, 'moderate'],
    [14, 'moderate'],
    [15, 'moderate'],
    [16, 'severe'],
    [240, 'severe'],
  ] as const)('%f s in hand is %s', (s, tier) => expect(phonePickupTier(s)).toBe(tier));
  test('reads PHONE_SEVERE_S', () => {
    expect(PHONE_SEVERE_S).toBe(15);
    expect(phonePickupTier(PHONE_SEVERE_S)).toBe('moderate');
    expect(phonePickupTier(PHONE_SEVERE_S + 0.5)).toBe('severe');
  });
});

describe('keepDashcamEvents passes a phone pickup untouched', () => {
  test('a pickup is never dropped by the DashPal limits', () => {
    const pickup = ev({ type: 'phone_pickup', tier: 'severe', durationS: 20, measured: { speedMph: 4, maxSpeedMph: 31.5 } });
    expect(keepDashcamEvents([pickup])).toEqual([pickup]);
  });
});

test('SCORING_VERSION is 9 and the barrel exports the API, and nothing about points', () => {
  expect(SCORING_VERSION).toBe(9);
  expect(barrel.SCORING_VERSION).toBe(9);
  expect(barrel.phonePickupTier).toBe(phonePickupTier);
  expect(barrel.classifyDrive).toBe(classifyDrive);
  expect(barrel.dashcamDrive).toBe(dashcamDrive);
  expect(barrel.tooShort).toBe(tooShort);
  expect(barrel.speedingChargedS).toBe(speedingChargedS);
  const names = Object.keys(barrel);
  for (const gone of [
    'scoreDrive',
    'basePenalty',
    'eventPenalty',
    'speedingCost',
    'speedingPenalty',
    'legacySpeedingPenalty',
    'phoneSpeedMult',
    'cappedMiles',
    'nextMultiplier',
    'scoringRules',
    'BASE_PENALTY',
    'RATING_PENALTY',
    'POINTS_PER_MILE',
    'CLEAN_BONUS',
    'ratingPenalty',
    'attentionPenalty',
    'applyStreak',
    'levelForPoints',
  ]) {
    expect(names).not.toContain(gone);
  }
});

describe('keepDashcamEvents: the DashPal speed gate re-applied', () => {
  const MIN = 60_000;
  const t = (m: number): number => 1_800_000_000_000 + m * MIN;
  const dc = (id: string, type: 'drowsy' | 'eyes_off', m: number, speedMph: unknown = 30, status?: 'active' | 'removed') => ({
    id,
    type,
    startedAt: t(m),
    status,
    measured: speedMph === null ? { source: 'dashcam' } : { source: 'dashcam', speedMph },
  });
  const own = (id: string, m: number) => ({ id, type: 'hard_brake' as const, startedAt: t(m), measured: {} });
  const ids = (list: readonly { id: string }[]): string[] => list.map((e) => e.id);

  test('the barrel exports it', () => {
    expect(barrel.keepDashcamEvents).toBe(keepDashcamEvents);
  });

  test('an upload alone: under 10 mph, a missing, non-numeric or non-finite speed are dropped; exactly 10 mph is kept; events of other types pass untouched', () => {
    const up = [dc('a', 'drowsy', 1, 9.99), dc('b', 'drowsy', 20, null), dc('s', 'drowsy', 30, '30'), dc('c', 'eyes_off', 3, Number.NaN), dc('d', 'drowsy', 40, 10), own('p', 2), { ...own('q', 3), measured: {} }];
    expect(ids(keepDashcamEvents(up))).toEqual(['d', 'p', 'q']);
  });

  test('every episode at 10 mph or more counts, however close to the last of its kind, in input order', () => {
    const up = [dc('late', 'drowsy', 9.99), dc('first', 'drowsy', 0), dc('ten', 'drowsy', 10), dc('e1', 'eyes_off', 1), dc('e2', 'eyes_off', 5.9), dc('e3', 'eyes_off', 6)];
    expect(ids(keepDashcamEvents(up))).toEqual(['late', 'first', 'ten', 'e1', 'e2', 'e3']);
    expect(ids(keepDashcamEvents([dc('y', 'drowsy', 0), dc('x', 'drowsy', 0)]))).toEqual(['y', 'x']);
    // a start that is not a number is dropped
    expect(keepDashcamEvents([{ ...dc('n', 'drowsy', 0), startedAt: Number.NaN }])).toEqual([]);
  });

  test('pure: the inputs are not mutated', () => {
    const up = [dc('b', 'drowsy', 5), dc('a', 'drowsy', 0)];
    const copy = JSON.parse(JSON.stringify(up));
    keepDashcamEvents(up);
    expect(up).toEqual(copy);
  });
});
