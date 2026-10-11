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
    [25, 3],
    [30, 4],
    [35, 5],
    [45, 6],
    [55, 8],
    [60, 9],
    [65, 10],
    [70, 10],
  ])('L=%i → T=%i', (L, T) => expect(speedTolerance(L)).toBe(T));

  test('low limits clamp up to 3 (L=20 without a zone)', () => expect(speedTolerance(20)).toBe(3));
  test('a .5 result rounds up (L=28 → 3.5 → 4)', () => expect(speedTolerance(28)).toBe(4));
  test('school and construction zones fix T at 3', () => {
    expect(speedTolerance(20, 'school')).toBe(3);
    expect(speedTolerance(65, 'construction')).toBe(3);
    expect(speedTolerance(65, null)).toBe(10);
  });
});

describe('speedTier — tier boundaries for every row', () => {
  // [limit, zone, minor above, moderate above, severe above]
  test.each([
    [20, 'school', 23, 28, 33],
    [25, null, 28, 33, 38],
    [30, null, 34, 39, 44],
    [35, null, 40, 45, 50],
    [45, null, 51, 56, 61],
    [55, null, 63, 68, 73],
    [60, null, 69, 74, 79],
    [65, null, 75, 80, 85],
    [70, null, 80, 85, 90],
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
    ['speeding', 'minor', 15],
    ['speeding', 'moderate', 40],
    ['speeding', 'severe', 100],
    ['hard_brake', 'minor', 10],
    ['hard_brake', 'severe', 25],
    ['hard_accel', 'minor', 15],
    ['hard_accel', 'severe', 30],
    ['hard_corner', 'minor', 10],
    ['hard_corner', 'severe', 25],
    ['phone_pickup', 'severe', 40],
    ['eyes_off', 'severe', 40],
    ['drowsy', 'severe', 50],
  ] as const)('%s %s → %i', (type, tier, points) => expect(basePenalty(ev({ type, tier }))).toBe(points));

  test('phone pickup while stopped in traffic is 20', () =>
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', stoppedInTraffic: true }))).toBe(20));

  test('phone handling is 10 per extra 15-s block', () => {
    expect(basePenalty(ev({ type: 'phone_handling', tier: 'moderate', units: 1 }))).toBe(10);
    expect(basePenalty(ev({ type: 'phone_handling', tier: 'severe', units: 3 }))).toBe(30);
  });

  test('phone handling without units counts one block', () =>
    expect(basePenalty(ev({ type: 'phone_handling', tier: 'moderate' }))).toBe(10));

  test('speeding base ignores the duration extension', () =>
    expect(basePenalty(ev({ type: 'speeding', tier: 'minor', units: 4 }))).toBe(15));
});

describe('eventPenalty', () => {
  const brake = ev({ type: 'hard_brake', tier: 'minor' });
  test('repeat multiplier: 1st ×1, 2nd ×1.25, 3rd and later ×1.5', () => {
    expect(eventPenalty(brake, 0)).toBe(10);
    expect(eventPenalty(brake, 1)).toBe(12.5);
    expect(eventPenalty(brake, 2)).toBe(15);
    expect(eventPenalty(brake, 7)).toBe(15);
  });

  test('speeding adds 25% of base per extra 30-s block', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 29 }), 0)).toBe(15);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 30 }), 0)).toBe(18.75);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'moderate', durationS: 60 }), 0)).toBe(60);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'severe', durationS: 65 }), 0)).toBe(150);
  });

  test('speeding blocks always come from durationS; a client-sent units is ignored', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 600, units: 0 }), 0)).toBe(90);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 0, units: 5 }), 0)).toBe(15);
  });

  test('blocks are capped at 1440 so a huge input stays finite', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 1e300 }), 0)).toBe(15 * (1 + 0.25 * 1440));
    expect(basePenalty(ev({ type: 'phone_handling', tier: 'severe', units: 1e12 }))).toBe(14_400);
  });

  test('school / construction zone doubles the penalty', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', zone: 'school' }), 0)).toBe(30);
    expect(eventPenalty(ev({ type: 'hard_brake', tier: 'minor', zone: 'construction' }), 1)).toBe(25);
  });

  test('ratingPenalty is the base penalty with no multipliers', () => {
    expect(ratingPenalty(ev({ type: 'speeding', tier: 'minor', units: 3, zone: 'school' }))).toBe(15);
    expect(ratingPenalty(ev({ type: 'phone_handling', tier: 'severe', units: 3 }))).toBe(30);
  });

  test('a DashPal event adds nothing to the Safety Rating', () => {
    expect(ratingPenalty(ev({ type: 'eyes_off', tier: 'severe' }))).toBe(0);
    expect(ratingPenalty(ev({ type: 'drowsy', tier: 'severe' }))).toBe(0);
  });

  test('DashPal events take the usual repeat multiplier within their own type', () => {
    expect(eventPenalty(ev({ type: 'drowsy', tier: 'severe' }), 1)).toBe(62.5);
    expect(eventPenalty(ev({ type: 'eyes_off', tier: 'severe' }), 2)).toBe(60);
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
  test('12 mi, 11.8 safe, 1 hard brake, streak 10 → +132', () => {
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
      penalties: 10,
      net: 132,
      ratingPenalty: 10,
      activeEventCount: 1,
    });
  });

  test('the same drive as a DashPal drive: 118 × 1.50 = 177 − 10 → +167', () => {
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
      penalties: 10,
      net: 167,
      ratingPenalty: 10,
      activeEventCount: 1,
    });
  });

  test('5 mi, 4.6 safe, 2 phone pickups, no streak → −44', () => {
    const b = scoreDrive(
      drive({
        miles: 5,
        safeMiles: 4.6,
        events: [ev({ type: 'phone_pickup', tier: 'severe' }), ev({ type: 'phone_pickup', tier: 'severe' })],
      }),
      ctx0
    );
    expect(b.gains).toBe(46);
    expect(b.events.map((e) => e.penalty)).toEqual([40, 50]);
    expect(b.penalties).toBe(90);
    expect(b.net).toBe(-44);
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
    expect(b).toMatchObject({ cleanBonus: 25, gains: 75, penalties: 50, net: 25, ratingPenalty: 0, activeEventCount: 0 });
    expect(b.events.map((e) => e.penalty)).toEqual([50]);
  });

  test('DashPal events are left out of activeEventCount but phone events still break clean', () => {
    const b = scoreDrive(
      drive({ miles: 5, safeMiles: 5, events: [ev({ type: 'eyes_off', tier: 'severe' }), ev({ type: 'hard_brake', tier: 'minor' })] }),
      ctx0
    );
    expect(b).toMatchObject({ cleanBonus: 0, penalties: 50, ratingPenalty: 10, activeEventCount: 1 });
  });

  test('two drowsy events: 50 + 62.5 → 63 (the repeat multiplier per type), scaled on a short drive', () => {
    const two = [ev({ type: 'drowsy', tier: 'severe' }), ev({ type: 'drowsy', tier: 'severe' })];
    expect(scoreDrive(drive({ events: two }), ctx0).events.map((e) => e.penalty)).toEqual([50, 63]);
    // shortScale 0.5 + 1.5/6 = 0.75: 37.5 → 38
    expect(scoreDrive(drive({ miles: 1.5, safeMiles: 1.5, events: [ev({ type: 'drowsy', tier: 'severe' })] }), ctx0).penalties).toBe(38);
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
      { id: early.id, penalty: 10 },
      { id: accel.id, penalty: 15 },
      { id: late.id, penalty: 13 }, // 12.5 rounds half up
    ]);
  });

  test('three pickups cost 40 + 50 + 60', () => {
    const events = [1, 2, 3].map(() => ev({ type: 'phone_pickup', tier: 'severe' }));
    expect(scoreDrive(drive({ events }), ctx0).penalties).toBe(150);
  });

  test('pickup stopped in traffic costs 20', () => {
    const b = scoreDrive(drive({ events: [ev({ type: 'phone_pickup', tier: 'severe', stoppedInTraffic: true })] }), ctx0);
    expect(b.penalties).toBe(20);
  });

  test('speeding +25% per 30-s block and zone ×2 flow into the drive', () => {
    const b = scoreDrive(
      drive({ events: [ev({ type: 'speeding', tier: 'moderate', durationS: 45, zone: 'school' })] }),
      ctx0
    );
    expect(b.penalties).toBe(100); // 40 × 1.25 × 2
    expect(b.ratingPenalty).toBe(40);
  });

  test('removed events are excluded from penalties, rating, repeat index and the clean check', () => {
    const removed = ev({ type: 'phone_pickup', tier: 'severe', status: 'removed' });
    const kept = ev({ type: 'phone_pickup', tier: 'severe', status: 'active' });
    const b = scoreDrive(drive({ events: [removed, kept] }), ctx0);
    expect(b.events).toEqual([{ id: kept.id, penalty: 40 }]);
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
    expect(b.penalties).toBe(27); // round(40 × 0.6667)
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
    expect(b.penalties).toBe(25);
    expect(b.net).toBe(92);
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

test('SCORING_VERSION is 4 and the barrel exports the API', () => {
  expect(SCORING_VERSION).toBe(4);
  expect(barrel.scoreDrive).toBe(scoreDrive);
  expect(barrel.dashcamDrive).toBe(dashcamDrive);
  expect(barrel.SCORING_VERSION).toBe(4);
});
