/**
 * Server rows as PostgREST renders them (the selected columns only), and a snapshot built from
 * them. The defs come from `packages/scoring` so they match migration 0010's seed.
 */
import { BADGES, CHALLENGES, levelFor } from '@scoring';

import type {
  BadgeDef,
  ChallengeDef,
  DayPredicates,
  EarnedBadge,
  Enrolment,
  Progress,
  RewardDay,
  RewardsSnapshot,
  WeeklyGoal,
} from '../api';

export const UID = '00000000-0000-4000-8000-00000000000a';
export const OTHER_UID = '00000000-0000-4000-8000-00000000000b';
/** 2026-09-23 12:00 UTC, a Wednesday. */
export const NOW = Date.parse('2026-09-23T12:00:00Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

let seq = 0;
export const nextUuid = (): string => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`;

/**
 * A progress row. `level` follows `xp` through the class table unless the caller sets it, as the
 * server keeps them (final review m1: screens print the stored level, so a fixture must be coherent).
 */
export function progressRow(over: Partial<Progress> = {}): Progress {
  const xp = over.xp ?? 1250;
  return {
    user_id: UID,
    points: 1250,
    xp: 1250,
    level: levelFor(xp).level,
    streak_days: 6,
    best_streak: 9,
    safe_days: 12,
    phone_free_days: 8,
    smooth_days: 5,
    goals_achieved: 1,
    challenges_completed: 0,
    referrals_rewarded: 0,
    shields: 0,
    next_focus: null,
    settled_through: '2026-09-21',
    streak_started: '2026-09-15',
    rewards_start: null,
    created_at: iso(NOW - 30 * 86_400_000),
    updated_at: iso(NOW - 3_600_000),
    ...over,
  };
}

export const passAll = (): DayPredicates => ({
  phone: 'pass',
  speeding: 'pass',
  braking: 'pass',
  accel: 'pass',
  cornering: 'pass',
  smooth: 'pass',
  safe: 'pass',
});

export function rewardDayRow(day: string, over: Partial<RewardDay> = {}): RewardDay {
  return {
    user_id: UID,
    day,
    outcome: 'safe',
    outcome_reason: 'safe',
    tier: 'safe',
    phone_free: true,
    camera: false,
    predicates: passAll(),
    points: 75,
    streak_after: 6,
    wall_close: `${day}T09:00:00+00:00`,
    settled_at: `${day}T09:05:00+00:00`,
    source_updated_at: `${day}T04:00:00+00:00`,
    created_at: `${day}T09:05:00+00:00`,
    updated_at: `${day}T09:05:00+00:00`,
    ...over,
  };
}

export function goalRow(weekStart: string, over: Partial<WeeklyGoal> = {}): WeeklyGoal {
  return {
    user_id: UID,
    week_start: weekStart,
    category: 'phone',
    source: 'weakest',
    target_days: 4,
    pass_days: 1,
    fail_days: 0,
    state: 'active',
    prorated: false,
    closed_at: null,
    created_at: `${weekStart}T08:00:00+00:00`,
    updated_at: `${weekStart}T08:00:00+00:00`,
    ...over,
  };
}

export function badgeRow(badgeId: string, over: Partial<EarnedBadge> = {}): EarnedBadge {
  return { user_id: UID, badge_id: badgeId, earned_at: iso(NOW - 86_400_000), created_at: iso(NOW - 86_400_000), ...over };
}

export function enrolmentRow(defId: string, over: Partial<Enrolment> = {}): Enrolment {
  return {
    id: nextUuid(),
    user_id: UID,
    def_id: defId,
    start_day: '2026-09-20',
    state: 'active',
    pass_days: 2,
    fail_days: 1,
    completed_at: null,
    ended_at: null,
    created_at: iso(NOW - 3 * 86_400_000),
    updated_at: iso(NOW - 86_400_000),
    ...over,
  };
}

export const badgeDefRows = (): BadgeDef[] =>
  BADGES.map((b) => ({ id: b.id, family: b.family, tier: b.tier, metric: b.metric, threshold: b.threshold, sort: b.sort }));

export const challengeDefRows = (): ChallengeDef[] =>
  CHALLENGES.map((c) => ({
    id: c.id,
    predicate: c.predicate,
    target_days: c.targetDays,
    window_days: c.windowDays,
    points: c.points,
    sort: c.sort,
    active: true,
  }));

export function snapshot(over: Partial<RewardsSnapshot> = {}): RewardsSnapshot {
  return {
    progress: progressRow(),
    currentGoal: goalRow('2026-09-21'),
    lastGoal: goalRow('2026-09-14', { state: 'achieved', pass_days: 4, closed_at: iso(NOW - 2 * 86_400_000) }),
    days: [rewardDayRow('2026-09-22'), rewardDayRow('2026-09-21', { streak_after: 5 })],
    badges: [badgeRow('safe_days_7')],
    badgeDefs: badgeDefRows(),
    challenges: [enrolmentRow('phone_down')],
    challengeDefs: challengeDefRows(),
    fetchedAt: NOW,
    ...over,
  };
}
