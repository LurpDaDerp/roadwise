/**
 * `get_my_summary`: the signed-in driver's profile, progress, league placement, weekly
 * challenges and achievements — the Home header, Profile card and Leagues badge all read it.
 * It refetches when a drive upload or drive action settles and after a profile edit
 * (`./invalidate.ts`).
 */
import { type UseQueryResult } from '@tanstack/react-query';

import { useServerQuery } from './useServerQuery';

export type LicenseStage = 'permit' | 'intermediate' | 'full';
export type LeagueTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
export type HeatmapVisibility = 'only_me' | 'clan' | 'friends';

export interface MySummary {
  profile: {
    user_id: string;
    username: string | null;
    license_stage: LicenseStage | null;
    units: 'mi' | 'km';
    state: string | null;
    heatmap_visibility: HeatmapVisibility;
    league_eligible: boolean;
    onboarded_at: string | null;
  };
  progress: {
    points: number;
    lifetime: number;
    level: number;
    level_floor: number;
    level_next: number | null;
    streak: number;
    at_risk: boolean;
    next_mult: number;
    freezes: number;
    clean_run: number;
    freeze_progress: number;
    phone_free_run: number;
    safety_rating: number | null;
    ranked: boolean;
    miles_30d: number;
    clean_miles_30d: number;
    /** Rating now minus the rating as of 7 days ago; null when either is unknown. */
    rating_trend: number | null;
    league_tier: LeagueTier;
  };
  league: {
    week: string;
    tier: LeagueTier;
    group_id: string | null;
    rank: number | null;
    size: number;
    ends_at: string;
  };
  not_driving_left: number;
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
