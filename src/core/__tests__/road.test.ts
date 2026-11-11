import { HARD_ACCEL_G, HARD_BRAKE_G, HARD_CORNER_G, speedTier, speedingLine } from '@scoring';
import { roundTo } from '@scoring/num';

import {
  HARD_LINES_DRY_G,
  HARD_LINES_SNOW_G,
  HARD_LINES_WET_G,
  ROAD_GRIPS,
  SIGHT_CAPS_MPH,
  SPEED_FACTOR_PCT,
  hardLines,
  isRoadGrip,
  isSightCap,
  judgedLimitMph,
  roadStricter,
  sameRoad,
  tighterCap,
  worseGrip,
  type HardEventType,
  type RoadGrip,
  type RoadStamp,
} from '@/core/road';

const TYPES: HardEventType[] = ['hard_brake', 'hard_accel', 'hard_corner'];

describe('judgedLimitMph — min(posted × grip factor, sight cap)', () => {
  test('no road state is the posted limit itself', () => {
    for (const limit of [5, 12, 25, 35, 45, 55, 65, 70, 85, 37.5, 0, Number.NaN]) {
      expect(Object.is(judgedLimitMph(limit), limit)).toBe(true);
      expect(Object.is(judgedLimitMph(limit, null), limit)).toBe(true);
      expect(Object.is(judgedLimitMph(limit, {}), limit)).toBe(true);
    }
  });

  test('the factors are 90, 85, 80 and 70 %', () => {
    expect(SPEED_FACTOR_PCT).toEqual({ wet: 90, water: 85, snow: 80, ice: 70 });
    expect(judgedLimitMph(40, { g: 'wet' })).toBe(36);
    expect(judgedLimitMph(40, { g: 'water' })).toBe(34);
    expect(judgedLimitMph(40, { g: 'snow' })).toBe(32);
    expect(judgedLimitMph(40, { g: 'ice' })).toBe(28);
  });

  // Design table 3.3: the speeding line at the judged limit, 1 dp.
  test.each<[RoadGrip | 'dry', number[]]>([
    ['dry', [28.2, 39.8, 51.4, 63.0, 74.6]],
    ['wet', [25.3, 35.7, 46.2, 56.6, 67.1]],
    ['water', [23.9, 33.7, 43.6, 53.4, 63.3]],
    ['snow', [22.4, 31.7, 41.0, 50.2, 59.5]],
    ['ice', [19.5, 27.6, 35.7, 43.9, 52.0]],
  ])('%s: the line at 25, 35, 45, 55 and 65', (grip, lines) => {
    const road: RoadStamp | undefined = grip === 'dry' ? undefined : { g: grip };
    const got = [25, 35, 45, 55, 65].map((limit) => roundTo(speedingLine(judgedLimitMph(limit, road)), 1));
    expect(got).toEqual(lines);
  });

  test('on a wet road the line sits at or just over the posted limit, never under it', () => {
    for (let limit = 25; limit <= 85; limit += 5) {
      const line = speedingLine(judgedLimitMph(limit, { g: 'wet' }));
      expect(line).toBeGreaterThanOrEqual(limit);
      expect(line).toBeLessThan(limit + 3);
    }
  });

  test('a cap at or above the limit changes nothing', () => {
    for (const cap of SIGHT_CAPS_MPH) {
      expect(judgedLimitMph(25, { cap })).toBe(25);
      expect(judgedLimitMph(cap, { cap })).toBe(cap);
    }
    expect(judgedLimitMph(65, { cap: 65 })).toBe(65);
    expect(judgedLimitMph(30, { g: 'wet', cap: 35 })).toBe(27);
  });

  test('a cap under the limit caps it: 55 → 63.0, 45 → 51.4, 35 → 39.8, 65 only above 65', () => {
    expect(roundTo(speedingLine(judgedLimitMph(65, { cap: 55 })), 1)).toBe(63.0);
    expect(roundTo(speedingLine(judgedLimitMph(70, { cap: 55 })), 1)).toBe(63.0);
    expect(roundTo(speedingLine(judgedLimitMph(65, { cap: 45 })), 1)).toBe(51.4);
    expect(roundTo(speedingLine(judgedLimitMph(65, { cap: 35 })), 1)).toBe(39.8);
    expect(judgedLimitMph(65, { cap: 65 })).toBe(65);
    expect(judgedLimitMph(75, { cap: 65 })).toBe(65);
  });

  test('grip and cap together take the smaller of the two', () => {
    // 65 × 0.80 = 52 is under the 55 cap: the factor wins.
    expect(judgedLimitMph(65, { g: 'snow', cap: 55 })).toBe(52);
    // 65 × 0.90 = 58.5 is over the 55 cap: the cap wins.
    expect(judgedLimitMph(65, { g: 'wet', cap: 55 })).toBe(55);
    // 45 × 0.70 = 31.5 is under the 35 cap.
    expect(judgedLimitMph(45, { g: 'ice', cap: 35 })).toBe(31.5);
    // 55 × 0.85 = 46.75 is over the 45 cap.
    expect(judgedLimitMph(55, { g: 'water', cap: 45 })).toBe(45);
  });

  test('an unknown grip or cap (a stored row read back) is ignored', () => {
    const odd = { g: 'slush', cap: 40 } as unknown as RoadStamp;
    expect(judgedLimitMph(45, odd)).toBe(45);
    expect(judgedLimitMph(45, { g: 'wet', cap: 40 } as unknown as RoadStamp)).toBe(40.5);
  });

  test('the tier runs on the judged limit', () => {
    // Dry 45: line 51.4, so 50 is not speeding; wet 45: line 46.18, so 50 is minor.
    expect(speedTier(50, judgedLimitMph(45))).toBeNull();
    expect(speedTier(50, judgedLimitMph(45, { g: 'wet' }))).toBe('minor');
  });
});

describe('hardLines — grip only, minor and severe alike', () => {
  test('the dry lines are the normal lines, the same objects', () => {
    expect(hardLines('hard_brake')).toBe(HARD_BRAKE_G);
    expect(hardLines('hard_accel', null)).toBe(HARD_ACCEL_G);
    expect(hardLines('hard_corner', undefined)).toBe(HARD_CORNER_G);
    expect(HARD_LINES_DRY_G).toEqual({ hard_brake: HARD_BRAKE_G, hard_accel: HARD_ACCEL_G, hard_corner: HARD_CORNER_G });
  });

  test.each<[RoadGrip | 'dry', [number, number, number], [number, number, number]]>([
    ['dry', [0.36, 0.4, 0.48], [0.55, 0.6, 0.7]],
    ['wet', [0.32, 0.36, 0.43], [0.5, 0.54, 0.63]],
    ['water', [0.32, 0.36, 0.43], [0.5, 0.54, 0.63]],
    ['snow', [0.29, 0.32, 0.38], [0.44, 0.48, 0.56]],
    ['ice', [0.29, 0.32, 0.38], [0.44, 0.48, 0.56]],
  ])('%s: brake, start, turn minor and severe', (grip, minor, severe) => {
    const g = grip === 'dry' ? undefined : grip;
    expect(TYPES.map((t) => hardLines(t, g).minor)).toEqual(minor);
    expect(TYPES.map((t) => hardLines(t, g).severe)).toEqual(severe);
  });

  test('the tightened lines are the dry lines × 0.90 and × 0.80, to 2 dp', () => {
    for (const t of TYPES) {
      for (const tier of ['minor', 'severe'] as const) {
        expect(HARD_LINES_WET_G[t][tier]).toBe(roundTo(HARD_LINES_DRY_G[t][tier] * 0.9, 2));
        expect(HARD_LINES_SNOW_G[t][tier]).toBe(roundTo(HARD_LINES_DRY_G[t][tier] * 0.8, 2));
      }
    }
  });

  test('an unknown grip is a dry road', () => {
    expect(hardLines('hard_brake', 'slush' as unknown as RoadGrip)).toBe(HARD_BRAKE_G);
  });
});

describe('stamp helpers', () => {
  test('guards', () => {
    for (const g of ROAD_GRIPS) expect(isRoadGrip(g)).toBe(true);
    for (const c of SIGHT_CAPS_MPH) expect(isSightCap(c)).toBe(true);
    for (const v of [undefined, null, '', 'dry', 'Wet', 40, '35']) {
      expect(isRoadGrip(v)).toBe(false);
      expect(isSightCap(v)).toBe(false);
    }
  });

  test('worseGrip and tighterCap', () => {
    expect(worseGrip(undefined, null)).toBeUndefined();
    expect(worseGrip('wet', undefined)).toBe('wet');
    expect(worseGrip('water', 'wet')).toBe('water');
    expect(worseGrip('snow', 'ice')).toBe('ice');
    expect(tighterCap(undefined, null)).toBeUndefined();
    expect(tighterCap(65, undefined)).toBe(65);
    expect(tighterCap(55, 35)).toBe(35);
  });

  test('roadStricter and sameRoad', () => {
    expect(roadStricter({ g: 'wet' }, null)).toBe(true);
    expect(roadStricter({ cap: 65 }, {})).toBe(true);
    expect(roadStricter({ g: 'wet' }, { g: 'wet' })).toBe(false);
    expect(roadStricter({ g: 'wet' }, { g: 'snow' })).toBe(false);
    expect(roadStricter({ g: 'wet', cap: 45 }, { g: 'snow', cap: 55 })).toBe(true);
    expect(roadStricter(undefined, undefined)).toBe(false);
    expect(sameRoad(null, {})).toBe(true);
    expect(sameRoad({ g: 'ice', cap: 35 }, { cap: 35, g: 'ice' })).toBe(true);
    expect(sameRoad({ g: 'ice' }, { g: 'snow' })).toBe(false);
    expect(sameRoad({ cap: 55 }, {})).toBe(false);
  });
});
