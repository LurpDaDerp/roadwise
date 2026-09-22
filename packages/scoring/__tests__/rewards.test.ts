import { CONSTANTS } from '../src/constants';
import {
  BADGES,
  CHALLENGES,
  GOAL_CATEGORIES,
  LEVELS,
  REFERRAL_CODE_PATTERN,
  REWARDS,
  levelFor,
  normaliseReferralCode,
  rewardRulesJson,
} from '../src/rewards';
import * as barrel from '../src';

describe('levelFor — the class table (§R1)', () => {
  test.each([
    [0, 1, 'Learner', 'Steady', 1500, 0],
    [1499, 1, 'Learner', 'Steady', 1500, 1499 / 1500],
    [1500, 2, 'Steady', 'Smooth', 4000, 0],
    [3999, 2, 'Steady', 'Smooth', 4000, 2499 / 2500],
    [4000, 3, 'Smooth', 'Focused', 8000, 0],
    [8000, 4, 'Focused', 'Road-wise', 15000, 0],
    [15000, 5, 'Road-wise', 'Mentor', 25000, 0],
    [24999, 5, 'Road-wise', 'Mentor', 25000, 9999 / 10000],
  ])('xp %p → level %p %p', (xp, level, name, nextName, nextXp, fraction) => {
    const r = levelFor(xp);
    expect(r).toEqual({ level, name, nextName, nextXp, fraction: expect.any(Number) });
    expect(r.fraction).toBeCloseTo(fraction, 10);
  });

  test('Mentor at 25,000 and beyond: no next class, fraction 1', () => {
    expect(levelFor(25000)).toEqual({ level: 6, name: 'Mentor', nextName: null, nextXp: null, fraction: 1 });
    expect(levelFor(1e9)).toEqual({ level: 6, name: 'Mentor', nextName: null, nextXp: null, fraction: 1 });
  });

  test('negative or non-finite xp → Learner with fraction 0', () => {
    const learner = { level: 1, name: 'Learner', nextName: 'Steady', nextXp: 1500, fraction: 0 };
    expect(levelFor(-5)).toEqual(learner);
    expect(levelFor(NaN)).toEqual(learner);
    expect(levelFor(Infinity)).toEqual(learner);
    expect(levelFor(-Infinity)).toEqual(learner);
  });

  test('fraction at the midpoint of a class is 0.5', () => {
    expect(levelFor(750).fraction).toBe(0.5);
    expect(levelFor(2750).fraction).toBe(0.5);
    expect(levelFor(20000).fraction).toBe(0.5);
  });

  test('fraction always lies in [0, 1]', () => {
    for (let xp = -100; xp <= 30000; xp += 37) {
      const f = levelFor(xp).fraction;
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  test('LEVELS: six classes, ascending thresholds, levels 1–6', () => {
    expect(LEVELS.map((l) => [l.level, l.name, l.xp])).toEqual([
      [1, 'Learner', 0],
      [2, 'Steady', 1500],
      [3, 'Smooth', 4000],
      [4, 'Focused', 8000],
      [5, 'Road-wise', 15000],
      [6, 'Mentor', 25000],
    ]);
  });
});

describe('BADGES (§R7)', () => {
  test('16 unique ids, sort 1–16 in order', () => {
    expect(BADGES).toHaveLength(16);
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(16);
    expect(BADGES.map((b) => b.sort)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  test('no badge is based on distance or trip count', () => {
    for (const b of BADGES) {
      expect(b.id).not.toMatch(/mile|distance|trip/i);
      expect(b.metric).not.toMatch(/mile|distance|trip/i);
      expect(b.family).not.toMatch(/mile|distance|trip/i);
    }
  });

  test('the exact table', () => {
    expect(BADGES.map((b) => [b.id, b.family, b.tier, b.metric, b.threshold])).toEqual([
      ['safe_days_7', 'safe_days', 'bronze', 'safe_days', 7],
      ['safe_days_30', 'safe_days', 'silver', 'safe_days', 30],
      ['safe_days_100', 'safe_days', 'gold', 'safe_days', 100],
      ['phone_free_days_10', 'phone_free_days', 'bronze', 'phone_free_days', 10],
      ['phone_free_days_50', 'phone_free_days', 'silver', 'phone_free_days', 50],
      ['phone_free_days_200', 'phone_free_days', 'gold', 'phone_free_days', 200],
      ['smooth_days_7', 'smooth_days', 'bronze', 'smooth_days', 7],
      ['smooth_days_30', 'smooth_days', 'silver', 'smooth_days', 30],
      ['smooth_days_100', 'smooth_days', 'gold', 'smooth_days', 100],
      ['weekly_goals_1', 'weekly_goals', 'bronze', 'weekly_goals', 1],
      ['weekly_goals_5', 'weekly_goals', 'silver', 'weekly_goals', 5],
      ['weekly_goals_20', 'weekly_goals', 'gold', 'weekly_goals', 20],
      ['challenges_1', 'challenges', 'bronze', 'challenges', 1],
      ['challenges_3', 'challenges', 'silver', 'challenges', 3],
      ['challenges_10', 'challenges', 'gold', 'challenges', 10],
      ['referrals_1', 'referrals', 'bronze', 'referrals', 1],
    ]);
  });
});

describe('CHALLENGES (§R6)', () => {
  test('targetDays ≤ windowDays and points within 150–300', () => {
    for (const c of CHALLENGES) {
      expect(c.targetDays).toBeLessThanOrEqual(c.windowDays);
      expect(c.points).toBeGreaterThanOrEqual(150);
      expect(c.points).toBeLessThanOrEqual(300);
    }
  });

  test('the exact table', () => {
    expect(CHALLENGES).toEqual([
      { id: 'phone_down', predicate: 'phone', targetDays: 10, windowDays: 14, points: 200, sort: 1 },
      { id: 'within_limit', predicate: 'speeding', targetDays: 10, windowDays: 14, points: 200, sort: 2 },
      { id: 'smooth_ride', predicate: 'smooth', targetDays: 10, windowDays: 14, points: 150, sort: 3 },
      { id: 'safe_run', predicate: 'safe', targetDays: 7, windowDays: 10, points: 300, sort: 4 },
    ]);
  });

  test('no challenge is based on distance or trip count', () => {
    for (const c of CHALLENGES) {
      expect(c.id).not.toMatch(/mile|distance|trip/i);
      expect(c.predicate).not.toMatch(/mile|distance|trip/i);
    }
  });
});

describe('goal categories', () => {
  test('tie order: phone, speeding, braking, cornering, accel', () => {
    expect(GOAL_CATEGORIES).toEqual(['phone', 'speeding', 'braking', 'cornering', 'accel']);
  });
});

describe('REWARDS constants', () => {
  test('points, safe-day floor and shields come from CONSTANTS (one source)', () => {
    expect(REWARDS.POINTS).toBe(CONSTANTS.POINTS);
    expect(REWARDS.MIN_DRIVING_S).toBe(CONSTANTS.SAFE_DAY_MIN_DRIVING_S);
    expect(REWARDS.SAFE_AVG).toBe(CONSTANTS.SAFE_DAY_AVG);
    expect(REWARDS.SHIELD_EVERY_SAFE_DAYS).toBe(CONSTANTS.SHIELD_EVERY_SAFE_DAYS);
    expect(REWARDS.SHIELD_MAX).toBe(CONSTANTS.SHIELD_MAX);
  });

  test('the milestone, settlement and referral values', () => {
    expect(REWARDS.STREAK_MILESTONES).toEqual([7, 14, 30, 50, 100, 150, 200, 250, 300, 365]);
    expect(REWARDS).toMatchObject({
      WEEKLY_GOAL_TARGET_DAYS: 4,
      SETTLE_WALL_CLOCK_H: 2,
      SETTLE_CAP_H: 72,
      WATERMARK_ACTIVE_D: 14,
      ZONE_HOP_MIN_H: 20,
      MAX_ACTIVE_CHALLENGES: 2,
      REFERRAL: {
        QUALIFYING_DRIVES: 3,
        REDEEM_WITHIN_D: 14,
        QUALIFY_WITHIN_D: 90,
        YEARLY_CAP: 20,
        CODE_LENGTH: 8,
        CODE_ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
        REDEEM_ATTEMPTS_PER_DAY: 10,
        GLOBAL_REDEEM_PER_HOUR: 500,
      },
    });
    expect(REWARDS).not.toHaveProperty('SAFE_DAY_UPGRADE');
  });
});

describe('referral codes', () => {
  test('normaliseReferralCode upper-cases and strips spaces and dashes', () => {
    expect(normaliseReferralCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(normaliseReferralCode('ab cd\t23-4-5')).toBe('ABCD2345');
    expect(REFERRAL_CODE_PATTERN.test(normaliseReferralCode(' abcd-2345 '))).toBe(true);
  });

  test('the pattern refuses I, L, O, 0 and 1', () => {
    for (const bad of ['I', 'L', 'O', '0', '1']) {
      expect(REFERRAL_CODE_PATTERN.test(`ABCD234${bad}`)).toBe(false);
    }
  });

  test('the pattern needs exactly 8 characters of the alphabet', () => {
    expect(REFERRAL_CODE_PATTERN.test('ABCD234')).toBe(false);
    expect(REFERRAL_CODE_PATTERN.test('ABCD23456')).toBe(false);
    expect(REFERRAL_CODE_PATTERN.test('abcd2345')).toBe(false);
    expect(REFERRAL_CODE_PATTERN.test('ABCD2345')).toBe(true);
  });

  test('the pattern alphabet is REWARDS.REFERRAL.CODE_ALPHABET', () => {
    const alphabet = REWARDS.REFERRAL.CODE_ALPHABET;
    expect(alphabet).toHaveLength(31);
    for (const ch of alphabet) expect(REFERRAL_CODE_PATTERN.test(ch.repeat(8))).toBe(true);
    for (let c = 0x20; c < 0x7f; c++) {
      const ch = String.fromCharCode(c);
      if (!alphabet.includes(ch)) expect(REFERRAL_CODE_PATTERN.test(ch.repeat(8))).toBe(false);
    }
  });
});

describe('rewardRulesJson — the object public.reward_rules() returns', () => {
  test('pinned snapshot', () => {
    expect(rewardRulesJson()).toEqual({
      POINTS: { safeDay: 50, goodDay: 20, phoneFreeDay: 25, cameraDay: 10, weeklyGoal: 150, referral: 500 },
      MIN_DRIVING_S: 600,
      SAFE_AVG: 85,
      SHIELD_EVERY_SAFE_DAYS: 14,
      SHIELD_MAX: 2,
      STREAK_MILESTONES: [7, 14, 30, 50, 100, 150, 200, 250, 300, 365],
      WEEKLY_GOAL_TARGET_DAYS: 4,
      SETTLE_WALL_CLOCK_H: 2,
      SETTLE_CAP_H: 72,
      WATERMARK_ACTIVE_D: 14,
      ZONE_HOP_MIN_H: 20,
      MAX_ACTIVE_CHALLENGES: 2,
      REFERRAL: {
        QUALIFYING_DRIVES: 3,
        REDEEM_WITHIN_D: 14,
        QUALIFY_WITHIN_D: 90,
        YEARLY_CAP: 20,
        CODE_LENGTH: 8,
        CODE_ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
        REDEEM_ATTEMPTS_PER_DAY: 10,
        GLOBAL_REDEEM_PER_HOUR: 500,
      },
      GOAL_CATEGORIES: ['phone', 'speeding', 'braking', 'cornering', 'accel'],
      LEVELS: [
        { level: 1, name: 'Learner', xp: 0 },
        { level: 2, name: 'Steady', xp: 1500 },
        { level: 3, name: 'Smooth', xp: 4000 },
        { level: 4, name: 'Focused', xp: 8000 },
        { level: 5, name: 'Road-wise', xp: 15000 },
        { level: 6, name: 'Mentor', xp: 25000 },
      ],
    });
  });

  test('survives a JSON round trip unchanged (what jsonb returns)', () => {
    const j = rewardRulesJson();
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });

  test('returns a fresh copy each call (callers cannot mutate the rules)', () => {
    const a = rewardRulesJson() as { STREAK_MILESTONES: number[] };
    a.STREAK_MILESTONES.push(999);
    expect(REWARDS.STREAK_MILESTONES).not.toContain(999);
    expect((rewardRulesJson() as { STREAK_MILESTONES: number[] }).STREAK_MILESTONES).not.toContain(999);
  });
});

test('the package barrel exports the rewards rules', () => {
  expect(barrel.REWARDS).toBe(REWARDS);
  expect(barrel.levelFor).toBe(levelFor);
  expect(barrel.rewardRulesJson).toBe(rewardRulesJson);
});
