import {
  CURRENT_RULES,
  DASHCAM_EVENT_TYPES,
  DASHCAM_MULT,
  EARN_RATE_VERSION,
  LEGACY_RULES,
  MULT_CAP,
  SCORING_VERSION,
  SPEEDING_EVENT_CAP,
  SPEEDING_G,
  SPEEDING_K,
  SPEEDING_MAX_OVER_MPH,
  basePenalty,
  cappedMiles,
  dashcamDrive,
  isDashcamType,
  eventPenalty,
  keepDashcamEvents,
  legacySpeedingPenalty,
  nextMultiplier,
  phoneSpeedMult,
  ratingPenalty,
  scoreDrive,
  scoringRules,
  speedTier,
  speedTolerance,
  speedingChargedS,
  speedingCost,
  speedingPenalty,
  tooShort,
  type DriveEvent,
  type DriveInput,
} from '../src/drive';
import { SPEEDING_GRACE_S } from '../src/thresholds';
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

  test('speeding without a measured overMphS is the legacy tier price (the extension is in eventPenalty too)', () => {
    expect(basePenalty(ev({ type: 'speeding', tier: 'minor', units: 4 }))).toBe(12);
    expect(basePenalty(ev({ type: 'speeding', tier: 'minor', durationS: 30 }))).toBe(15);
  });
});

describe('phone use at speed — points only', () => {
  test('phoneSpeedMult: unknown or ≤ 25 ×1, over 25 to 45 ×1.5, over 45 ×2', () => {
    expect([phoneSpeedMult(undefined), phoneSpeedMult(null), phoneSpeedMult(Number.NaN), phoneSpeedMult(0), phoneSpeedMult(25)]).toEqual([1, 1, 1, 1, 1]);
    expect([phoneSpeedMult(25.1), phoneSpeedMult(45)]).toEqual([1.5, 1.5]);
    expect([phoneSpeedMult(45.1), phoneSpeedMult(90)]).toEqual([2, 2]);
  });

  test('a pickup reads maxSpeedMph, else speedMph: 32, 48 or 64', () => {
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', measured: { maxSpeedMph: 20 } }))).toBe(32);
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', measured: { maxSpeedMph: 30 } }))).toBe(48);
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', measured: { maxSpeedMph: 50 } }))).toBe(64);
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', measured: { speedMph: 50 } }))).toBe(64);
    // maxSpeedMph wins over the pickup speed when both are there
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', measured: { speedMph: 10, maxSpeedMph: 30 } }))).toBe(48);
  });

  test('a pickup stopped in traffic stays 16 whatever the measured speed', () => {
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', stoppedInTraffic: true, measured: { maxSpeedMph: 60 } }))).toBe(16);
  });

  test('handling is 8 per unit × the multiplier, whole numbers', () => {
    expect(basePenalty(ev({ type: 'phone_handling', tier: 'severe', units: 3, measured: { maxSpeedMph: 30 } }))).toBe(36);
    expect(basePenalty(ev({ type: 'phone_handling', tier: 'moderate', units: 1, measured: { maxSpeedMph: 70 } }))).toBe(16);
  });

  test('a missing, non-numeric or non-finite speed reads as ×1', () => {
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', measured: {} }))).toBe(32);
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', measured: { maxSpeedMph: '60' as never } }))).toBe(32);
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', measured: { maxSpeedMph: Number.POSITIVE_INFINITY } }))).toBe(32);
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', measured: null as never }))).toBe(32);
  });

  test('the rating penalty never takes the speed multiplier', () => {
    expect(ratingPenalty(ev({ type: 'phone_pickup', tier: 'severe', measured: { maxSpeedMph: 60 } }))).toBe(40);
    expect(ratingPenalty(ev({ type: 'phone_handling', tier: 'severe', units: 2, measured: { maxSpeedMph: 60 } }))).toBe(20);
  });

  test('the multiplier flows into the drive with the repeat multiplier on top', () => {
    const b = scoreDrive(
      drive({ events: [ev({ type: 'phone_pickup', tier: 'severe', measured: { maxSpeedMph: 50 } }), ev({ type: 'phone_pickup', tier: 'severe', measured: { maxSpeedMph: 30 } })] }),
      ctx0
    );
    expect(b.events.map((e) => e.penalty)).toEqual([64, 60]); // 32 × 2, then 32 × 1.5 × 1.25
    expect(b.ratingPenalty).toBe(80);
  });
});

describe('speeding cost — by amount over, compounding over time', () => {
  test('the constants', () => expect([SPEEDING_K, SPEEDING_G, SPEEDING_EVENT_CAP, SPEEDING_MAX_OVER_MPH, SPEEDING_GRACE_S]).toEqual([0.15, 0.02, 300, 150, 5]));

  test('charged seconds: durationS less the 5 grace rows, never under 1', () => {
    expect(speedingChargedS(6)).toBe(1);
    expect(speedingChargedS(15)).toBe(10);
    expect(speedingChargedS(5)).toBe(1);
    expect(speedingChargedS(0)).toBe(1);
    expect(speedingChargedS(-3)).toBe(1);
    expect(speedingChargedS(Number.NaN)).toBe(1);
    expect(speedingChargedS(35.5)).toBe(30.5);
  });

  test.each([
    [10, 30, 5], // 10 s charged at 3 mph over
    [30, 90, 18], // 30 s at 3
    [60, 180, 51], // 60 s at 3
    [30, 300, 61], // 30 s at 10
    [1, 3, 1], // 0.45 rounds to 0, floored at 1
    [120, 360, 220],
    [200, 200, 300], // capped
    [5, 12.5, 2],
  ])('%i s charged with %f mph·s over → %i', (n, over, cost) => expect(speedingCost(n, over)).toBe(cost));

  test('nothing over after the grace still costs 1', () => {
    expect(speedingCost(10, 0)).toBe(1);
    expect(speedingCost(10, -5)).toBe(1);
    expect(speedingCost(10, Number.NaN)).toBe(1);
  });

  test('overMphS is read as at most 150 mph over per charged second, and a huge n lands on the cap, never NaN or Infinity', () => {
    expect(speedingCost(10, 1e9)).toBe(speedingCost(10, 1500));
    expect(speedingCost(43_200, 43_200)).toBe(300);
    expect(speedingCost(1e300, 1e300)).toBe(300);
    expect(speedingCost(Number.NaN, 30)).toBe(speedingCost(1, 30));
    expect(speedingCost(0, 30)).toBe(speedingCost(1, 30));
  });

  test('a measured event is priced from overMphS and durationS, not its tier', () => {
    const minor = ev({ type: 'speeding', tier: 'minor', durationS: 15, measured: { overMphS: 30 } });
    const severe = ev({ type: 'speeding', tier: 'severe', durationS: 15, measured: { overMphS: 30 } });
    expect(speedingPenalty(minor)).toBe(5);
    expect(speedingPenalty(severe)).toBe(5);
    expect(basePenalty(minor)).toBe(5);
    expect(eventPenalty(minor, 0)).toBe(5);
    // the five grace rows are never charged: 35 rows over with 90 over after the grace = 30 charged at 3
    expect(speedingPenalty(ev({ type: 'speeding', tier: 'moderate', durationS: 35, measured: { overMphS: 90 } }))).toBe(18);
  });

  test('legacy: no finite overMphS → exactly the old tier price with +25% per extra 30-s block', () => {
    expect(legacySpeedingPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 29 }))).toBe(12);
    expect(speedingPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 30 }))).toBe(15);
    expect(speedingPenalty(ev({ type: 'speeding', tier: 'moderate', durationS: 60 }))).toBe(48);
    expect(speedingPenalty(ev({ type: 'speeding', tier: 'severe', durationS: 65 }))).toBe(120);
    expect(speedingPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 30, measured: {} }))).toBe(15);
    expect(speedingPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 30, measured: { overMphS: Number.NaN } }))).toBe(15);
    expect(speedingPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 30, measured: { overMphS: '9' as never } }))).toBe(15);
    expect(speedingPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 30, measured: null as never }))).toBe(15);
  });

  test('the speeding tier still sets the rating penalty', () => {
    expect(ratingPenalty(ev({ type: 'speeding', tier: 'severe', durationS: 15, measured: { overMphS: 30 } }))).toBe(100);
  });
});

describe('eventPenalty', () => {
  const brake = ev({ type: 'hard_brake', tier: 'minor' });
  test('repeat multiplier: 1st ×1, 2nd ×1.25, 3rd and later ×1.5', () => {
    expect(eventPenalty(brake, 0)).toBe(8);
    expect(eventPenalty(brake, 1)).toBe(10);
    expect(eventPenalty(brake, 2)).toBe(12);
    expect(eventPenalty(brake, 7)).toBe(12);
  });

  test('legacy speeding adds 25% of base per extra 30-s block', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 29 }), 0)).toBe(12);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 30 }), 0)).toBe(15);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'moderate', durationS: 60 }), 0)).toBe(48);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'severe', durationS: 65 }), 0)).toBe(120);
  });

  test('legacy speeding blocks always come from durationS; a client-sent units is ignored', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 600, units: 0 }), 0)).toBe(72);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 0, units: 5 }), 0)).toBe(12);
  });

  test('blocks are capped at 1440 so a huge input stays finite', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 1e300 }), 0)).toBe(12 * (1 + 0.25 * 1440));
    expect(basePenalty(ev({ type: 'phone_handling', tier: 'severe', units: 1e12 }))).toBe(11_520);
  });

  test('a measured speeding event takes the repeat multiplier on its cost', () => {
    const e = ev({ type: 'speeding', tier: 'minor', durationS: 35, measured: { overMphS: 300 } }); // 61
    expect(eventPenalty(e, 0)).toBe(61);
    expect(eventPenalty(e, 1)).toBe(76.25);
    expect(eventPenalty(e, 2)).toBe(91.5);
  });

  test('school / construction zone doubles the penalty', () => {
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', zone: 'school' }), 0)).toBe(24);
    expect(eventPenalty(ev({ type: 'speeding', tier: 'minor', durationS: 15, zone: 'school', measured: { overMphS: 30 } }), 0)).toBe(10);
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

describe('scoreDrive — spec examples (20 a safe mile, +50 clean)', () => {
  test('12 mi, 11.8 safe, 1 hard brake, streak 10 → +275', () => {
    const b = scoreDrive(
      drive({ miles: 12, safeMiles: 11.8, events: [ev({ type: 'hard_brake', tier: 'minor' })] }),
      { streak: 10, safeMilesEarlierToday: 0 }
    );
    expect(b).toMatchObject({
      scored: true,
      creditedMiles: 11.8,
      milePoints: 236,
      pointsPerMile: 20,
      cleanBonus: 0,
      streakMult: 1.2,
      dashcamMult: 1,
      mult: 1.2,
      gains: 283, // 283.2
      shortScale: 1,
      penalties: 8,
      net: 275,
      ratingPenalty: 10,
      activeEventCount: 1,
    });
  });

  test('the same drive as a DashPal drive: 236 × 1.50 = 354 − 8 → +346', () => {
    const b = scoreDrive(
      drive({ miles: 12, safeMiles: 11.8, dashcam: true, events: [ev({ type: 'hard_brake', tier: 'minor' })] }),
      { streak: 10, safeMilesEarlierToday: 0 }
    );
    expect(b).toMatchObject({
      milePoints: 236,
      streakMult: 1.2,
      dashcamMult: 1.25,
      mult: 1.5,
      gains: 354,
      penalties: 8,
      net: 346,
      ratingPenalty: 10,
      activeEventCount: 1,
    });
  });

  test('5 mi, 4.6 safe, 2 phone pickups, no streak → +20 (penalties keep their scale)', () => {
    const b = scoreDrive(
      drive({
        miles: 5,
        safeMiles: 4.6,
        events: [ev({ type: 'phone_pickup', tier: 'severe' }), ev({ type: 'phone_pickup', tier: 'severe' })],
      }),
      ctx0
    );
    expect(b.gains).toBe(92);
    expect(b.events.map((e) => e.penalty)).toEqual([32, 40]);
    expect(b.penalties).toBe(72);
    expect(b.net).toBe(20);
    expect(b.ratingPenalty).toBe(80);
  });

  test('3 mi clean, streak 4 → +119', () => {
    const b = scoreDrive(drive({ miles: 3, safeMiles: 3 }), { streak: 4, safeMilesEarlierToday: 0 });
    expect(b.cleanBonus).toBe(50);
    expect(b.streakMult).toBe(1.08);
    expect(b.mult).toBe(1.08);
    expect(b.gains).toBe(119); // (60 + 50) × 1.08 = 118.8
    expect(b.net).toBe(119);
  });

  test('every breakdown records the rate it paid, a too-short one included', () => {
    expect(scoreDrive(drive({}), ctx0).pointsPerMile).toBe(20);
    expect(scoreDrive(drive({ miles: 0.1, safeMiles: 0.1 }), ctx0).pointsPerMile).toBe(20);
  });
});

describe('scoreDrive — a drive first scored before version 6 keeps its own rules when re-scored', () => {
  test('scoringRules: under 6 legacy (10 a mile, 25 bonus, no phone speed multiplier); 6, later, absent or unreadable current', () => {
    expect([LEGACY_RULES, CURRENT_RULES]).toEqual([
      { pointsPerMile: 10, cleanBonus: 25, phoneSpeed: false },
      { pointsPerMile: 20, cleanBonus: 50, phoneSpeed: true },
    ]);
    expect(EARN_RATE_VERSION).toBe(6);
    expect([3, 4, 5, 5.5].map(scoringRules)).toEqual([LEGACY_RULES, LEGACY_RULES, LEGACY_RULES, LEGACY_RULES]);
    expect([6, 7, undefined, null, Number.NaN, Number.POSITIVE_INFINITY].map(scoringRules)).toEqual([
      CURRENT_RULES,
      CURRENT_RULES,
      CURRENT_RULES,
      CURRENT_RULES,
      CURRENT_RULES,
      CURRENT_RULES,
    ]);
  });

  test('basePenalty and eventPenalty under LEGACY_RULES skip the phone speed multiplier, nothing else', () => {
    const pickup = ev({ type: 'phone_pickup', tier: 'severe', measured: { speedMph: 50 } });
    const handling = ev({ type: 'phone_handling', tier: 'severe', units: 3, measured: { maxSpeedMph: 70 } });
    expect([basePenalty(pickup), basePenalty(pickup, LEGACY_RULES)]).toEqual([64, 32]);
    expect([basePenalty(handling), basePenalty(handling, LEGACY_RULES)]).toEqual([48, 24]);
    expect(eventPenalty(pickup, 1, LEGACY_RULES)).toBe(40); // 32 × 1.25
    expect(basePenalty(ev({ type: 'phone_pickup', tier: 'severe', stoppedInTraffic: true, measured: { speedMph: 50 } }), LEGACY_RULES)).toBe(16);
    expect(basePenalty(ev({ type: 'hard_brake', tier: 'severe' }), LEGACY_RULES)).toBe(20);
    expect(basePenalty(ev({ type: 'speeding', tier: 'moderate', durationS: 60 }), LEGACY_RULES)).toBe(48);
    expect(basePenalty(ev({ type: 'speeding', tier: 'minor', durationS: 35, measured: { overMphS: 90 } }), LEGACY_RULES)).toBe(18);
  });

  test('a v5 drive re-scores at 10 a mile with a 25 bonus and reports that rate', () => {
    const v5 = scoreDrive(drive({ miles: 12, safeMiles: 11.8, scoringVersion: 5 }), { streak: 10, safeMilesEarlierToday: 0 });
    expect(v5).toMatchObject({ scored: true, milePoints: 118, pointsPerMile: 10, cleanBonus: 25, gains: 172, net: 172 }); // (118 + 25) × 1.2
    const v6 = scoreDrive(drive({ miles: 12, safeMiles: 11.8, scoringVersion: 6 }), { streak: 10, safeMilesEarlierToday: 0 });
    expect(v6).toMatchObject({ milePoints: 236, pointsPerMile: 20, cleanBonus: 50, gains: 343 });
    expect(scoreDrive(drive({ miles: 0.1, safeMiles: 0.1, scoringVersion: 5 }), ctx0).pointsPerMile).toBe(10);
  });

  test('a dispute on a v5 drive: the delta is the removed event’s penalty plus the 25 bonus a now-clean drive earns, never the new rate', () => {
    const brake = ev({ type: 'hard_brake', tier: 'minor' });
    const stored = scoreDrive(drive({ miles: 40, safeMiles: 40, scoringVersion: 5, events: [brake] }), ctx0);
    expect(stored).toMatchObject({ gains: 400, penalties: 8, net: 392 }); // what version 5 stored
    const rescored = scoreDrive(drive({ miles: 40, safeMiles: 40, scoringVersion: 5, events: [{ ...brake, status: 'removed' }] }), ctx0);
    expect(rescored).toMatchObject({ gains: 425, cleanBonus: 25, penalties: 0, net: 425 });
    expect(rescored.net - stored.net).toBe(stored.penalties + 25); // the brake back, and the clean bonus the drive now earns
    // without the version the same re-score would pay the new rate out as a windfall
    expect(scoreDrive(drive({ miles: 40, safeMiles: 40, events: [{ ...brake, status: 'removed' }] }), ctx0).net).toBe(850);
  });

  test('a dispute on a v5 drive never lowers the net through the phone speed multiplier (no credited miles, pickup at 50 mph)', () => {
    const brake = ev({ type: 'hard_brake', tier: 'minor' });
    const pickup = ev({ type: 'phone_pickup', tier: 'severe', measured: { speedMph: 50 } });
    const ctx = { streak: 0, safeMilesEarlierToday: 100 }; // the daily cap is used up
    const stored = scoreDrive(drive({ miles: 5, safeMiles: 5, scoringVersion: 5, events: [brake, pickup] }), ctx);
    expect(stored).toMatchObject({ creditedMiles: 0, gains: 0, penalties: 40, net: -40 });
    const rescored = scoreDrive(drive({ miles: 5, safeMiles: 5, scoringVersion: 5, events: [{ ...brake, status: 'removed' }, pickup] }), ctx);
    expect(rescored).toMatchObject({ penalties: 32, net: -32 });
    expect(rescored.net - stored.net).toBe(8);
    expect(scoreDrive(drive({ miles: 5, safeMiles: 5, scoringVersion: 6, events: [{ ...brake, status: 'removed' }, pickup] }), ctx).net).toBe(-64);
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
    expect(b).toMatchObject({ cleanBonus: 50, gains: 150, penalties: 40, net: 110, ratingPenalty: 0, activeEventCount: 0 });
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
    expect(b.gains).toBe(319); // (200 + 50) × 1.275 = 318.75
  });

  test('together they cap at ×1.50', () => {
    const b = scoreDrive(drive({ miles: 10, safeMiles: 10, dashcam: true }), { streak: 30, safeMilesEarlierToday: 0 });
    expect([b.streakMult, b.dashcamMult, b.mult]).toEqual([1.3, 1.25, 1.5]);
    expect(b.gains).toBe(375); // 250 × 1.5
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

  test('legacy speeding +25% per 30-s block and zone ×2 flow into the drive', () => {
    const b = scoreDrive(
      drive({ events: [ev({ type: 'speeding', tier: 'moderate', durationS: 45, zone: 'school' })] }),
      ctx0
    );
    expect(b.penalties).toBe(80); // 32 × 1.25 × 2
    expect(b.ratingPenalty).toBe(40);
  });

  test('measured speeding: the cost × repeat × zone, then the short-drive scale, rounded per event', () => {
    const first = ev({ type: 'speeding', tier: 'minor', durationS: 35, measured: { overMphS: 90 } }); // 18
    const second = ev({ type: 'speeding', tier: 'moderate', durationS: 35, zone: 'construction', measured: { overMphS: 300 } }); // 61 × 1.25 × 2
    const b = scoreDrive(drive({ events: [first, second] }), ctx0);
    expect(b.events.map((e) => e.penalty)).toEqual([18, 153]); // 152.5 rounds half up
    expect(b.ratingPenalty).toBe(55);
    // 1.5 mi: shortScale 0.75
    expect(scoreDrive(drive({ miles: 1.5, safeMiles: 1.5, events: [first] }), ctx0).events.map((e) => e.penalty)).toEqual([14]); // 13.5 → 14
  });

  test('a drive mixing legacy and measured speeding events prices each its own way', () => {
    const old = ev({ type: 'speeding', tier: 'severe', durationS: 65 }); // 120
    const measured = ev({ type: 'speeding', tier: 'severe', durationS: 15, measured: { overMphS: 30 } }); // 5 × 1.25
    const b = scoreDrive(drive({ events: [old, measured] }), ctx0);
    expect(b.events.map((e) => e.penalty)).toEqual([120, 6]); // 6.25 → 6
  });

  test('removed events are excluded from penalties, rating, repeat index and the clean check', () => {
    const removed = ev({ type: 'phone_pickup', tier: 'severe', status: 'removed' });
    const kept = ev({ type: 'phone_pickup', tier: 'severe', status: 'active' });
    const b = scoreDrive(drive({ events: [removed, kept] }), ctx0);
    expect(b.events).toEqual([{ id: kept.id, penalty: 32 }]);
    expect(b.ratingPenalty).toBe(40);
    expect(b.activeEventCount).toBe(1);

    const onlyRemoved = scoreDrive(drive({ miles: 5, safeMiles: 5, events: [removed] }), ctx0);
    expect(onlyRemoved.cleanBonus).toBe(50);
    expect(onlyRemoved.activeEventCount).toBe(0);
    expect(onlyRemoved.net).toBe(150);
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

  test('a drive under 0.5 mi AND under 2 min is not scored and scores all zeros', () => {
    const b = scoreDrive(
      drive({ miles: 0.49, safeMiles: 0.49, durationS: 119, events: [ev({ type: 'hard_brake', tier: 'severe' })] }),
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
  });

  test('either 0.5 mi or 2 min makes a drive a scored drive', () => {
    expect(scoreDrive(drive({ miles: 0.5, safeMiles: 0.5, durationS: 0 }), ctx0).scored).toBe(true);
    expect(scoreDrive(drive({ miles: 0.5, safeMiles: 0.5 }), ctx0).scored).toBe(true);
    const slow = scoreDrive(drive({ miles: 0.3, safeMiles: 0.3, durationS: 120, events: [ev({ type: 'hard_brake', tier: 'minor' })] }), ctx0);
    expect(slow.scored).toBe(true);
    expect(slow.reason).toBeUndefined();
    expect(slow.milePoints).toBe(6);
    expect(slow.shortScale).toBeCloseTo(0.55, 6);
    expect(slow.penalties).toBe(4); // 8 × 0.55 = 4.4
    expect(scoreDrive(drive({ miles: 0, safeMiles: 0, durationS: 600 }), ctx0).scored).toBe(true);
  });

  test('a missing or unreadable duration reads as 0, so the miles-only rule stands', () => {
    expect(tooShort(0.49, undefined)).toBe(true);
    expect(tooShort(0.49, Number.NaN)).toBe(true);
    expect(tooShort(0.49, 119.9)).toBe(true);
    expect(tooShort(0.49, 120)).toBe(false);
    expect(tooShort(0.5, undefined)).toBe(false);
    expect(tooShort(Number.NaN, 0)).toBe(true);
    expect(scoreDrive(drive({ miles: 0.2, safeMiles: 0.2 }), ctx0).scored).toBe(false);
  });

  test('clean bonus only from 2 mi with zero active events', () => {
    expect(scoreDrive(drive({ miles: 1.99, safeMiles: 1.99 }), ctx0).cleanBonus).toBe(0);
    expect(scoreDrive(drive({ miles: 2, safeMiles: 2 }), ctx0).cleanBonus).toBe(50);
    expect(
      scoreDrive(drive({ miles: 5, safeMiles: 5, events: [ev({ type: 'hard_corner', tier: 'minor' })] }), ctx0).cleanBonus
    ).toBe(0);
  });

  test('daily cap: a drive straddling 40 and 100 earns 20 full + 30 half miles', () => {
    const b = scoreDrive(drive({ miles: 100, safeMiles: 100 }), { streak: 0, safeMilesEarlierToday: 20 });
    expect(b.safeMiles).toBe(100);
    expect(b.creditedMiles).toBe(50);
    expect(b.milePoints).toBe(1000);
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
    expect(b.cleanBonus).toBe(50);
    expect(b.gains).toBe(100);
  });

  test('loopRepeat halves credited miles after the cap and forfeits the clean bonus', () => {
    const b = scoreDrive(drive({ miles: 10, safeMiles: 10, loopRepeat: true }), { streak: 0, safeMilesEarlierToday: 35 });
    expect(b.creditedMiles).toBe(3.75); // (5 + 2.5) × 0.5
    expect(b.cleanBonus).toBe(0);
    expect(b.gains).toBe(75);
  });

  test('multiplier caps at 1.30 and only scales gains', () => {
    const b = scoreDrive(
      drive({ miles: 10, safeMiles: 9, events: [ev({ type: 'hard_brake', tier: 'severe' })] }),
      { streak: 30, safeMilesEarlierToday: 0 }
    );
    expect(b.streakMult).toBe(1.3);
    expect(b.gains).toBe(234);
    expect(b.penalties).toBe(20);
    expect(b.net).toBe(214);
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

test('SCORING_VERSION is 6 and the barrel exports the API', () => {
  expect(SCORING_VERSION).toBe(6);
  expect(barrel.scoreDrive).toBe(scoreDrive);
  expect(barrel.dashcamDrive).toBe(dashcamDrive);
  expect(barrel.speedingCost).toBe(speedingCost);
  expect(barrel.phoneSpeedMult).toBe(phoneSpeedMult);
  expect(barrel.tooShort).toBe(tooShort);
  expect(barrel.scoringRules).toBe(scoringRules);
  expect([barrel.POINTS_PER_MILE, barrel.CLEAN_BONUS]).toEqual([20, 50]);
  expect([barrel.LEGACY_POINTS_PER_MILE, barrel.LEGACY_CLEAN_BONUS, barrel.EARN_RATE_VERSION]).toEqual([10, 25, 6]);
  expect(barrel.SCORING_VERSION).toBe(6);
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
