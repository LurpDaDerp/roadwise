import {
  DASHCAM_EVENT_TYPES,
  DASHCAM_MULT,
  MULT_CAP,
  SCORING_VERSION,
  basePenalty,
  cappedMiles,
  dashcamDrive,
  isDashcamType,
  eventPenalty,
  keepDashcamEvents,
  nextMultiplier,
  ratingPenalty,
  scoreDrive,
  speedTier,
  speedTolerance,
  type DriveEvent,
  type DriveInput,
} from '../src/drive';
import * as barrel from '../src';

let seq = 0;
const ev = (p: Partial<DriveEvent> & Pick<DriveEvent, 'type' | 'tier'>): DriveEvent => {
  seq += 1;
  return { id: `e${seq}`, startedAt: 1_000_000 + seq * 1000, durationS: 0, ...p };
};
const ctx0 = { streak: 0, safeMilesEarlierToday: 0 };
const drive = (p: Partial<DriveInput>): DriveInput => ({ miles: 10, safeMiles: 10, events: [], ...p });
const roundHalfUp = (v: number): number => Math.floor(v + 0.5);

describe('speedTolerance — T(L) for every row of the spec table', () => {
  test.each([
    [25, 2],
    [30, 2],
    [35, 3],
    [40, 4],
    [45, 4],
    [50, 5],
    [55, 6],
    [60, 7],
    [65, 8],
    [70, 8],
  ])('L=%i → T=%i', (L, T) => expect(speedTolerance(L)).toBe(T));

  test('low limits clamp up to 2 (L=20 without a zone)', () => expect(speedTolerance(20)).toBe(2));
  test('high limits clamp down to 8 (L=68: 10.5 → 11, less 2 → 9)', () => expect(speedTolerance(68)).toBe(8));
  test('school and construction zones fix T at 2', () => {
    expect(speedTolerance(20, 'school')).toBe(2);
    expect(speedTolerance(65, 'construction')).toBe(2);
    expect(speedTolerance(65, null)).toBe(8);
  });
});

describe('speedTier — tier boundaries for every row', () => {
  // [limit, zone, minor above, moderate above, severe above]
  test.each([
    [20, 'school', 22, 26, 31],
    [25, null, 27, 31, 36],
    [30, null, 32, 36, 41],
    [35, null, 38, 42, 47],
    [45, null, 49, 53, 58],
    [55, null, 61, 65, 70],
    [60, null, 67, 71, 76],
    [65, null, 73, 77, 82],
    [70, null, 78, 82, 87],
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

describe('basePenalty', () => {
  test.each([
    ['speeding', 'minor', 12],
    ['speeding', 'moderate', 32],
    ['speeding', 'severe', 80],
    ['hard_brake', 'minor', 8],
    ['hard_brake', 'severe', 20],
    ['hard_accel', 'minor', 12],
    ['hard_accel', 'severe', 24],
    ['hard_corner', 'minor', 8],
    ['hard_corner', 'severe', 20],
    ['phone_pickup', 'severe', 32],
    ['eyes_off', 'severe', 32],
    ['drowsy', 'severe', 40],
  ] as const)('%s %s → %i', (type, tier, points) => expect(basePenalty(ev({ type, tier }))).toBe(points));

  test('phone pickup while stopped in traffic is 16', () =>
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', stoppedInTraffic: true }))).toBe(16));

  test('phone handling is 8 per extra 15-s block', () => {
    expect(basePenalty(ev({ type: 'phone_handling', tier: 'moderate', units: 1 }))).toBe(8);
    expect(basePenalty(ev({ type: 'phone_handling', tier: 'severe', units: 3 }))).toBe(24);
  });

  test('phone handling without units counts one block', () =>
    expect(basePenalty(ev({ type: 'phone_handling', tier: 'moderate' }))).toBe(8));

  test('speeding base ignores the duration extension', () =>
    expect(basePenalty(ev({ type: 'speeding', tier: 'minor', units: 4 }))).toBe(12));
});

describe('eventPenalty', () => {
  const brake = ev({ type: 'hard_brake', tier: 'minor' });
  test('repeat multiplier: 1st ×1, 2nd ×1.25, 3rd and later ×1.5', () => {
    expect(eventPenalty(brake, 0)).toBe(8);
    expect(eventPenalty(brake, 1)).toBe(10);
    expect(eventPenalty(brake, 2)).toBe(12);
    expect(eventPenalty(brake, 7)).toBe(12);
  });

  test('speeding adds 25% of base per extra 30-s block', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 29 }), 0)).toBe(12);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 30 }), 0)).toBe(15);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'moderate', durationS: 60 }), 0)).toBe(48);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'severe', durationS: 65 }), 0)).toBe(120);
  });

  test('speeding blocks always come from durationS; a client-sent units is ignored', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 600, units: 0 }), 0)).toBe(72);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 0, units: 5 }), 0)).toBe(12);
  });

  test('blocks are capped at 1440 so a huge input stays finite', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 1e300 }), 0)).toBe(12 * (1 + 0.25 * 1440));
    expect(basePenalty(ev({ type: 'phone_handling', tier: 'severe', units: 1e12 }))).toBe(11_520);
  });

  test('school / construction zone doubles the penalty', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', zone: 'school' }), 0)).toBe(24);
    expect(eventPenalty(ev({ type: 'hard_brake', tier: 'minor', zone: 'construction' }), 1)).toBe(20);
  });

  test('ratingPenalty is the rating scale (not the points) with no multipliers', () => {
    expect(ratingPenalty(ev({ type: 'speeding', tier: 'minor', units: 3, zone: 'school' }))).toBe(15);
    expect(ratingPenalty(ev({ type: 'phone_handling', tier: 'severe', units: 3 }))).toBe(30);
  });

  test('a DashPal event adds nothing to the Safety Rating', () => {
    expect(ratingPenalty(ev({ type: 'eyes_off', tier: 'severe' }))).toBe(0);
    expect(ratingPenalty(ev({ type: 'drowsy', tier: 'severe' }))).toBe(0);
  });

  test('DashPal events take the usual repeat multiplier within their own type', () => {
    expect(eventPenalty(ev({ type: 'drowsy', tier: 'severe' }), 1)).toBe(50);
    expect(eventPenalty(ev({ type: 'eyes_off', tier: 'severe' }), 2)).toBe(48);
  });
});

describe('cappedMiles — daily cap as a rate integral', () => {
  test.each([
    [30, 0, 30],
    [40, 0, 40],
    [10, 35, 7.5], // 5 full + 5 half
    [20, 40, 10],
    [60, 40, 30], // exactly fills the half band
    [10, 100, 0],
    [10, 95, 2.5],
    [100, 20, 50], // straddles both 40 and 100: 20 + 30 + 0
    [150, 0, 70],
    [0.3, 39.9, 0.2],
    [11.8, 0, 11.8],
  ])('%f safe mi after %f earlier → %f', (safe, earlier, credited) =>
    expect(cappedMiles(safe, earlier)).toBe(credited));
});

describe('nextMultiplier', () => {
  test.each([
    [0, 1],
    [4, 1.08],
    [10, 1.2],
    [14, 1.28],
    [15, 1.3],
    [40, 1.3],
  ])('streak %i → ×%f', (streak, m) => expect(nextMultiplier(streak)).toBe(m));
});

describe('scoreDrive — spec examples', () => {
  test('12 mi, 11.8 safe, 1 hard brake, streak 10 → +134', () => {
    const b = scoreDrive(
      drive({ miles: 12, safeMiles: 11.8, events: [ev({ type: 'hard_brake', tier: 'minor' })] }),
      { streak: 10, safeMilesEarlierToday: 0 }
    );
    expect(b).toMatchObject({
      scored: true,
      creditedMiles: 11.8,
      milePoints: 118,
      cleanBonus: 0,
      streakMult: 1.2,
      dashcamMult: 1,
      mult: 1.2,
      gains: 142,
      shortScale: 1,
      penalties: 8,
      net: 134,
      ratingPenalty: 10,
      activeEventCount: 1,
    });
  });

  test('the same drive as a DashPal drive: 118 × 1.50 = 177 − 8 → +169', () => {
    const b = scoreDrive(
      drive({ miles: 12, safeMiles: 11.8, dashcam: true, events: [ev({ type: 'hard_brake', tier: 'minor' })] }),
      { streak: 10, safeMilesEarlierToday: 0 }
    );
    expect(b).toMatchObject({
      milePoints: 118,
      streakMult: 1.2,
      dashcamMult: 1.25,
      mult: 1.5,
      gains: 177,
      penalties: 8,
      net: 169,
      ratingPenalty: 10,
      activeEventCount: 1,
    });
  });

  test('5 mi, 4.6 safe, 2 phone pickups, no streak → −26', () => {
    const b = scoreDrive(
      drive({
        miles: 5,
        safeMiles: 4.6,
        events: [ev({ type: 'phone_pickup', tier: 'severe' }), ev({ type: 'phone_pickup', tier: 'severe' })],
      }),
      ctx0
    );
    expect(b.gains).toBe(46);
    expect(b.events.map((e) => e.penalty)).toEqual([32, 40]);
    expect(b.penalties).toBe(72);
    expect(b.net).toBe(-26);
    expect(b.ratingPenalty).toBe(80);
  });

  test('3 mi clean, streak 4 → +59', () => {
    const b = scoreDrive(drive({ miles: 3, safeMiles: 3 }), { streak: 4, safeMilesEarlierToday: 0 });
    expect(b.cleanBonus).toBe(25);
    expect(b.streakMult).toBe(1.08);
    expect(b.mult).toBe(1.08);
    expect(b.gains).toBe(59);
    expect(b.net).toBe(59);
  });
});

describe('scoreDrive — DashPal', () => {
  test('the two DashPal types, and only them', () => {
    expect(DASHCAM_EVENT_TYPES).toEqual(['eyes_off', 'drowsy']);
    expect(isDashcamType('drowsy')).toBe(true);
    expect(isDashcamType('eyes_off')).toBe(true);
    expect(isDashcamType('phone_pickup')).toBe(false);
    expect([DASHCAM_MULT, MULT_CAP]).toEqual([1.25, 1.5]);
  });

  test('a drowsy on a clean 5 mi drive keeps the clean bonus and adds 0 to the rating, but costs its points', () => {
    const b = scoreDrive(drive({ miles: 5, safeMiles: 5, events: [ev({ type: 'drowsy', tier: 'severe' })] }), ctx0);
    expect(b).toMatchObject({ cleanBonus: 25, gains: 75, penalties: 40, net: 35, ratingPenalty: 0, activeEventCount: 0 });
    expect(b.events.map((e) => e.penalty)).toEqual([40]);
  });

  test('DashPal events are left out of activeEventCount but phone events still break clean', () => {
    const b = scoreDrive(
      drive({ miles: 5, safeMiles: 5, events: [ev({ type: 'eyes_off', tier: 'severe' }), ev({ type: 'hard_brake', tier: 'minor' })] }),
      ctx0
    );
    expect(b).toMatchObject({ cleanBonus: 0, penalties: 40, ratingPenalty: 10, activeEventCount: 1 });
  });

  test('two drowsy events: 40 + 50 (the repeat multiplier per type), scaled on a short drive', () => {
    const two = [ev({ type: 'drowsy', tier: 'severe' }), ev({ type: 'drowsy', tier: 'severe' })];
    expect(scoreDrive(drive({ events: two }), ctx0).events.map((e) => e.penalty)).toEqual([40, 50]);
    // shortScale 0.5 + 1.5/6 = 0.75: 30
    expect(scoreDrive(drive({ miles: 1.5, safeMiles: 1.5, events: [ev({ type: 'drowsy', tier: 'severe' })] }), ctx0).penalties).toBe(30);
  });

  test('the DashPal multiplier stacks on the streak: 1.02 × 1.25 = 1.275', () => {
    const b = scoreDrive(drive({ miles: 10, safeMiles: 10, dashcam: true }), { streak: 1, safeMilesEarlierToday: 0 });
    expect([b.streakMult, b.dashcamMult, b.mult]).toEqual([1.02, 1.25, 1.275]);
    expect(b.gains).toBe(159); // (100 + 25) × 1.275 = 159.375
  });

  test('together they cap at ×1.50', () => {
    const b = scoreDrive(drive({ miles: 10, safeMiles: 10, dashcam: true }), { streak: 30, safeMilesEarlierToday: 0 });
    expect([b.streakMult, b.dashcamMult, b.mult]).toEqual([1.3, 1.25, 1.5]);
    expect(b.gains).toBe(188); // 125 × 1.5 = 187.5
  });

  test('the multiplier never scales penalties', () => {
    const events = [ev({ type: 'drowsy', tier: 'severe' })];
    const on = scoreDrive(drive({ dashcam: true, events }), ctx0);
    const off = scoreDrive(drive({ dashcam: false, events }), ctx0);
    expect(on.penalties).toBe(off.penalties);
    expect(on.gains).toBe(roundHalfUp(off.gains * 1.25));
  });

  test('absent dashcam reads as off', () => {
    const b = scoreDrive(drive({}), { streak: 4, safeMilesEarlierToday: 0 });
    expect([b.dashcamMult, b.mult]).toEqual([1, 1.08]);
  });

  test('a too-short drive still carries the multipliers', () => {
    const b = scoreDrive(drive({ miles: 0.2, safeMiles: 0.2, dashcam: true }), { streak: 10, safeMilesEarlierToday: 0 });
    expect(b).toMatchObject({ scored: false, streakMult: 1.2, dashcamMult: 1.25, mult: 1.5, gains: 0 });
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

describe('scoreDrive — rules', () => {
  test('repeat index counts prior active events of the same type by startedAt', () => {
    const late = ev({ type: 'hard_brake', tier: 'minor', startedAt: 3000 });
    const accel = ev({ type: 'hard_accel', tier: 'minor', startedAt: 2000 });
    const early = ev({ type: 'hard_brake', tier: 'minor', startedAt: 1000 });
    const b = scoreDrive(drive({ events: [late, accel, early] }), ctx0);
    expect(b.events).toEqual([
      { id: early.id, penalty: 8 },
      { id: accel.id, penalty: 12 },
      { id: late.id, penalty: 10 }, // 8 × 1.25
    ]);
  });

  test('three pickups cost 32 + 40 + 48', () => {
    const events = [1, 2, 3].map(() => ev({ type: 'phone_pickup', tier: 'severe' }));
    expect(scoreDrive(drive({ events }), ctx0).penalties).toBe(120);
  });

  test('pickup stopped in traffic costs 16', () => {
    const b = scoreDrive(drive({ events: [ev({ type: 'phone_pickup', tier: 'severe', stoppedInTraffic: true })] }), ctx0);
    expect(b.penalties).toBe(16);
  });

  test('speeding +25% per 30-s block and zone ×2 flow into the drive', () => {
    const b = scoreDrive(
      drive({ events: [ev({ type: 'speeding', tier: 'moderate', durationS: 45, zone: 'school' })] }),
      ctx0
    );
    expect(b.penalties).toBe(80); // 32 × 1.25 × 2
    expect(b.ratingPenalty).toBe(40);
  });

  test('removed events are excluded from penalties, rating, repeat index and the clean check', () => {
    const removed = ev({ type: 'phone_pickup', tier: 'severe', status: 'removed' });
    const kept = ev({ type: 'phone_pickup', tier: 'severe', status: 'active' });
    const b = scoreDrive(drive({ events: [removed, kept] }), ctx0);
    expect(b.events).toEqual([{ id: kept.id, penalty: 32 }]);
    expect(b.ratingPenalty).toBe(40);
    expect(b.activeEventCount).toBe(1);

    const onlyRemoved = scoreDrive(drive({ miles: 5, safeMiles: 5, events: [removed] }), ctx0);
    expect(onlyRemoved.cleanBonus).toBe(25);
    expect(onlyRemoved.activeEventCount).toBe(0);
    expect(onlyRemoved.net).toBe(75);
  });

  test('short-drive scale softens penalties under 3 mi', () => {
    const b = scoreDrive(
      drive({ miles: 1, safeMiles: 0.9, events: [ev({ type: 'phone_pickup', tier: 'severe' })] }),
      ctx0
    );
    expect(b.shortScale).toBeCloseTo(0.6667, 4);
    expect(b.penalties).toBe(21); // round(32 × 0.6667)
    expect(scoreDrive(drive({ miles: 3, safeMiles: 3 }), ctx0).shortScale).toBe(1);
    expect(scoreDrive(drive({ miles: 0.5, safeMiles: 0.5 }), ctx0).shortScale).toBeCloseTo(0.5833, 4);
  });

  test('drives under 0.5 mi are not scored and score all zeros', () => {
    const b = scoreDrive(
      drive({ miles: 0.49, safeMiles: 0.49, events: [ev({ type: 'hard_brake', tier: 'severe' })] }),
      { streak: 10, safeMilesEarlierToday: 0 }
    );
    expect(b).toMatchObject({
      scored: false,
      reason: 'too_short',
      safeMiles: 0,
      creditedMiles: 0,
      milePoints: 0,
      cleanBonus: 0,
      gains: 0,
      events: [],
      penalties: 0,
      net: 0,
      ratingPenalty: 0,
      activeEventCount: 0,
    });
    expect(scoreDrive(drive({ miles: 0.5, safeMiles: 0.5 }), ctx0).scored).toBe(true);
  });

  test('clean bonus only from 2 mi with zero active events', () => {
    expect(scoreDrive(drive({ miles: 1.99, safeMiles: 1.99 }), ctx0).cleanBonus).toBe(0);
    expect(scoreDrive(drive({ miles: 2, safeMiles: 2 }), ctx0).cleanBonus).toBe(25);
    expect(
      scoreDrive(drive({ miles: 5, safeMiles: 5, events: [ev({ type: 'hard_corner', tier: 'minor' })] }), ctx0).cleanBonus
    ).toBe(0);
  });

  test('daily cap: a drive straddling 40 and 100 earns 20 full + 30 half miles', () => {
    const b = scoreDrive(drive({ miles: 100, safeMiles: 100 }), { streak: 0, safeMilesEarlierToday: 20 });
    expect(b.safeMiles).toBe(100);
    expect(b.creditedMiles).toBe(50);
    expect(b.milePoints).toBe(500);
  });

  test('daily cap exhausted: no miles credited and no clean bonus either', () => {
    const b = scoreDrive(drive({ miles: 10, safeMiles: 10 }), { streak: 0, safeMilesEarlierToday: 120 });
    expect(b.creditedMiles).toBe(0);
    expect(b.cleanBonus).toBe(0);
    expect(b.gains).toBe(0);
  });

  test('a partly capped clean drive still earns the clean bonus', () => {
    const b = scoreDrive(drive({ miles: 10, safeMiles: 10 }), { streak: 0, safeMilesEarlierToday: 95 });
    expect(b.creditedMiles).toBe(2.5);
    expect(b.cleanBonus).toBe(25);
    expect(b.gains).toBe(50);
  });

  test('loopRepeat halves credited miles after the cap and forfeits the clean bonus', () => {
    const b = scoreDrive(drive({ miles: 10, safeMiles: 10, loopRepeat: true }), { streak: 0, safeMilesEarlierToday: 35 });
    expect(b.creditedMiles).toBe(3.75); // (5 + 2.5) × 0.5
    expect(b.cleanBonus).toBe(0);
    expect(b.gains).toBe(38); // 37.5 rounds half up
  });

  test('multiplier caps at 1.30 and only scales gains', () => {
    const b = scoreDrive(
      drive({ miles: 10, safeMiles: 9, events: [ev({ type: 'hard_brake', tier: 'severe' })] }),
      { streak: 30, safeMilesEarlierToday: 0 }
    );
    expect(b.streakMult).toBe(1.3);
    expect(b.gains).toBe(117);
    expect(b.penalties).toBe(20);
    expect(b.net).toBe(97);
  });

  test('safeMiles is clamped into [0, miles]', () => {
    expect(scoreDrive(drive({ miles: 5, safeMiles: 9 }), ctx0).safeMiles).toBe(5);
    expect(scoreDrive(drive({ miles: 5, safeMiles: -1 }), ctx0).safeMiles).toBe(0);
  });

  test('is deterministic and does not mutate its input', () => {
    const events = [ev({ type: 'hard_brake', tier: 'minor', startedAt: 9 }), ev({ type: 'hard_brake', tier: 'minor', startedAt: 1 })];
    const input = drive({ events });
    const snapshot = JSON.parse(JSON.stringify(input));
    expect(scoreDrive(input, ctx0)).toEqual(scoreDrive(input, ctx0));
    expect(input).toEqual(snapshot);
  });
});

test('SCORING_VERSION is 5 and the barrel exports the API', () => {
  expect(SCORING_VERSION).toBe(5);
  expect(barrel.scoreDrive).toBe(scoreDrive);
  expect(barrel.dashcamDrive).toBe(dashcamDrive);
  expect(barrel.SCORING_VERSION).toBe(5);
});

describe('keepDashcamEvents — the DashPal limits re-applied over the whole drive', () => {
  const MIN = 60_000;
  const t = (m: number): number => 1_800_000_000_000 + m * MIN;
  const dc = (id: string, type: 'drowsy' | 'eyes_off', m: number, speedMph: unknown = 30, status?: 'active' | 'removed') => ({
    id,
    type,
    startedAt: t(m),
    status,
    measured: speedMph === null ? { source: 'dashcam' } : { source: 'dashcam', speedMph },
  });
  const phone = (id: string, m: number) => ({ id, type: 'phone_pickup' as const, startedAt: t(m), measured: {} });
  const ids = (list: readonly { id: string }[]): string[] => list.map((e) => e.id);

  test('the barrel exports it', () => {
    expect(barrel.keepDashcamEvents).toBe(keepDashcamEvents);
  });

  test('an upload alone: under 10 mph, a missing, non-numeric or non-finite speed are dropped; exactly 10 mph is kept; phone events pass untouched', () => {
    const up = [dc('a', 'drowsy', 1, 9.99), dc('b', 'drowsy', 20, null), dc('s', 'drowsy', 30, '30'), dc('c', 'eyes_off', 3, Number.NaN), dc('d', 'drowsy', 40, 10), phone('p', 2), { ...phone('q', 3), measured: {} }];
    expect(ids(keepDashcamEvents(up))).toEqual(['d', 'p', 'q']);
  });

  test('at most one drowsy per 10 min and one eyes_off per 5 min, the earliest kept, in input order', () => {
    const up = [dc('late', 'drowsy', 9.99), dc('first', 'drowsy', 0), dc('ten', 'drowsy', 10), dc('e1', 'eyes_off', 1), dc('e2', 'eyes_off', 5.9), dc('e3', 'eyes_off', 6)];
    expect(ids(keepDashcamEvents(up))).toEqual(['first', 'ten', 'e1', 'e3']);
    // the same start: the lower id is kept
    expect(ids(keepDashcamEvents([dc('y', 'drowsy', 0), dc('x', 'drowsy', 0)]))).toEqual(['x']);
  });

  test('a merge: stored events stand and anchor the limits; a removed stored one anchors nothing; the gap is checked both ways', () => {
    const stored = [dc('s1', 'drowsy', 0), dc('s2', 'eyes_off', 2), dc('gone', 'drowsy', 30, 30, 'removed'), phone('sp', 1)];
    const up = [dc('u1', 'drowsy', 9), dc('u2', 'drowsy', 10), dc('u3', 'eyes_off', 6.9), dc('u4', 'eyes_off', 7), dc('u5', 'drowsy', 31), phone('up', 8)];
    expect(ids(keepDashcamEvents(up, stored))).toEqual(['u2', 'u4', 'u5', 'up']);
    // a stored event later than an upload still blocks it
    expect(ids(keepDashcamEvents([dc('early', 'drowsy', 50)], [dc('s', 'drowsy', 55)]))).toEqual([]);
    expect(keepDashcamEvents([], stored)).toEqual([]);
  });

  test('pure: the inputs are not mutated', () => {
    const up = [dc('b', 'drowsy', 5), dc('a', 'drowsy', 0)];
    const copy = JSON.parse(JSON.stringify(up));
    keepDashcamEvents(up);
    expect(up).toEqual(copy);
  });
});
