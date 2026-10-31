/**
 * `get_my_summary`: the signed-in driver's profile (with what they share with friends), Safety
 * Rating, the "Wasn't driving" marks left this month, this week's goals and the achievements
 * unlocked. Home, Profile, Analytics and Settings read it. (A server in the transition still sends a
 * few keys older builds read, such as `progress.points`; they are not part of this shape.)
 * It refetches when a drive upload or drive action settles and after a profile edit
 * (`./invalidate.ts`).
 */
import { type UseQueryResult } from '@tanstack/react-query';

import { useServerQuery } from './useServerQuery';

/** Who sees the driver's heat map. */
export type HeatmapVisibility = 'only_me' | 'friends';

export interface MySummary {
  profile: {
    user_id: string;
    username: string | null;
    units: 'mi' | 'km';
    state: string | null;
    heatmap_visibility: HeatmapVisibility;
    onboarded_at: string | null;
    /** Friends see the Safety Rating (on unless turned off). */
    share_rating: boolean;
    /** Friends see the category scores. */
    share_categories: boolean;
    /** Friends see the achievements. */
    share_achievements: boolean;
    /** Friends see the drives, distance and events (and the 90-day distance on the friends board). */
    share_stats: boolean;
  };
  progress: {
    /** The 90-day Safety Rating; null before the first scored drive. */
    safety_rating: number | null;
    /** 10 mi or more in the last 90 days. */
    ranked: boolean;
    /** Miles driven in the last 90 days (the way to a rating). */
    miles_90d: number;
    /** Rating now minus the rating as of 7 days ago; null when either is unknown. */
    rating_trend: number | null;
  };
  /** "Wasn't driving" marks left this month. */
  not_driving_left: number;
  /** This week's goals, with a check mark when done. */
  challenges: {
    id: string;
    slot: number;
    title: string;
    description: string;
    target: number;
    progress: number;
    completed: boolean;
  }[];
  /** Unlocked achievement ids, oldest first. */
  achievements: string[];
}

export function useMySummary(opts: { enabled?: boolean } = {}): UseQueryResult<MySummary> {
  return useServerQuery<MySummary>(['summary'], 'get_my_summary', undefined, opts);
}
