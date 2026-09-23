import type { Href } from 'expo-router';

/**
 * Where the rewards screens live. Casts: typed routes are generated at `expo start`, and several of
 * these routes belong to other M5 tasks (the goal and challenges to Task 9, the invite to Task 12,
 * the share composer to Task 13), so they may not exist in this checkout yet.
 */
export const REWARDS_HREF = '/rewards' as Href;
export const GOAL_HREF = '/rewards/goal' as Href;
export const CHALLENGES_HREF = '/rewards/challenges' as Href;
/** Task 9's challenge detail, keyed by the challenge's def id (one active enrolment per def). */
export const challengeHref = (defId: string) => `/rewards/challenges/${encodeURIComponent(defId)}` as Href;
export const BADGES_HREF = '/rewards/badges' as Href;
export const badgeHref = (badgeId: string) => `/rewards/badges/${encodeURIComponent(badgeId)}` as Href;
export const INVITE_HREF = '/rewards/invite' as Href;
/** Task 13's composer, for an earned badge only. */
export const shareBadgeHref = (badgeId: string) =>
  `/rewards/share?kind=badge&badgeId=${encodeURIComponent(badgeId)}` as Href;
