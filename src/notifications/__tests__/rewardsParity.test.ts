/**
 * The catalog stays self-contained (`zod` only, so its Deno copy needs no import rewrite), so the
 * rewards payload schemas carry their literal lists inline. This test pins each list to the
 * rewards rules in `packages/scoring` (Task 1), so a new badge, challenge, class or category
 * cannot ship on one side only.
 */
import { BADGES, CHALLENGES, GOAL_CATEGORIES, LEVELS, REWARDS } from '@scoring';

import {
  PayloadSchemas,
  REWARD_BADGE_IDS,
  REWARD_BADGE_TIERS,
  REWARD_CHALLENGE_IDS,
  REWARD_GOAL_CATEGORIES,
  REWARD_LEVEL_NAMES,
} from '../catalog';

test('goal categories equal GOAL_CATEGORIES, in tie order', () => {
  expect([...REWARD_GOAL_CATEGORIES]).toEqual([...GOAL_CATEGORIES]);
});

test('challenge ids equal CHALLENGES, in display order', () => {
  expect([...REWARD_CHALLENGE_IDS]).toEqual([...CHALLENGES].sort((a, b) => a.sort - b.sort).map((c) => c.id));
});

test('badge ids equal BADGES, in display order, and the tiers are every tier a badge uses', () => {
  expect([...REWARD_BADGE_IDS]).toEqual([...BADGES].sort((a, b) => a.sort - b.sort).map((b) => b.id));
  expect([...REWARD_BADGE_TIERS]).toEqual(['bronze', 'silver', 'gold']);
  for (const b of BADGES) expect(REWARD_BADGE_TIERS).toContain(b.tier);
});

test('class names equal LEVELS, in level order', () => {
  expect([...REWARD_LEVEL_NAMES]).toEqual(LEVELS.map((l) => l.name));
});

test('every class above Learner parses with its own name; Learner and a wrong name do not', () => {
  for (const l of LEVELS) {
    const ok = PayloadSchemas.level_up.safeParse({ kind: 'level', level: l.level, name: l.name }).success;
    expect(ok).toBe(l.level >= 2);
  }
  expect(PayloadSchemas.level_up.safeParse({ kind: 'level', level: 3, name: 'Steady' }).success).toBe(false);
});

test('every badge parses with its own tier', () => {
  for (const b of BADGES) {
    expect(PayloadSchemas.level_up.safeParse({ kind: 'badge', badgeId: b.id, tier: b.tier }).success).toBe(true);
  }
});

test('every challenge and every goal category parses with its real points', () => {
  for (const c of CHALLENGES) {
    expect(
      PayloadSchemas.goal_completed.safeParse({ kind: 'challenge', challengeId: c.id, points: c.points }).success
    ).toBe(true);
  }
  for (const category of GOAL_CATEGORIES) {
    expect(
      PayloadSchemas.goal_completed.safeParse({
        kind: 'weekly_goal',
        category,
        weekStart: '2026-09-14',
        points: REWARDS.POINTS.weeklyGoal,
        prorated: false,
      }).success
    ).toBe(true);
  }
});

test('a referral credit and every streak milestone fit their schemas', () => {
  for (const role of ['invitee', 'referrer']) {
    expect(PayloadSchemas.referral_qualified.safeParse({ role, points: REWARDS.POINTS.referral }).success).toBe(true);
  }
  for (const days of REWARDS.STREAK_MILESTONES) {
    expect(PayloadSchemas.streak_milestone.safeParse({ days, reachedOn: '2026-09-21' }).success).toBe(true);
  }
});
