/**
 * The monthly Wrapped (`supabase/migrations/0038_wrapped.sql`): the archive of past months
 * (`list_my_wrapped`), one month's story (`get_my_wrapped`), a shared copy (`get_shared_wrapped`),
 * and making or stopping a share link (`create_wrapped_share`, `delete_wrapped_share`).
 *
 * A month is a calendar month of the drives' local days, `YYYY-MM`. Only past months with 3 or more
 * scored drives have one. A past month's numbers change only when an old drive moves (rare), so
 * every read here is served from cache for `SERVER_SLOW_STALE_MS`.
 */
import { type UseQueryResult } from '@tanstack/react-query';

import { callRpc } from './rpc';
import { SERVER_SLOW_STALE_MS, useServerQuery } from './useServerQuery';
import { MONTH_RE, SHARE_ID_RE } from './wrappedIds';

export type StyleId = 'lead_footed' | 'jumpy' | 'phone_happy' | 'bumpy' | 'rising' | 'spotless' | 'steady' | 'smooth' | 'focused' | 'easygoing';
export type PatternId = 'road_tripper' | 'commuter' | 'early_bird' | 'weekend_cruiser' | 'city_hopper' | 'cruiser';

export interface Archetype {
  style: StyleId;
  pattern: PatternId;
}

export type CategoryId = 'speed' | 'braking' | 'acceleration' | 'turning' | 'phone' | 'attention';
/** The 90-day category scores at month end, whole numbers; null when unranked (phone: not tracked; attention: no DashPal miles). */
export type WrappedCategories = Record<CategoryId, number | null>;

/** "Better than x% of drivers" (miles: "More miles than x%"), 10 to 100; null when hidden (under 25 drivers that month, or under 10). */
export interface WrappedPercentiles {
  miles: number | null;
  avgScore: number | null;
  cleanShare: number | null;
  hardPer100: number | null;
  speedingPer100: number | null;
  pickupsPer100: number | null;
}
export type PercentileKey = keyof WrappedPercentiles;

/** The numbers both the own story and a shared copy hold. Miles and rates to 1 decimal place. */
export interface WrappedCore {
  month: string;
  drives: number;
  miles: number;
  durationS: number;
  avgDriveMiles: number;
  longestDriveMiles: number;
  /** The mean of the month's drive scores, whole; null when none had a score. */
  avgScore: number | null;
  /** The Safety Rating at local midnight on the 1st (null when unranked then). */
  ratingStart: number | null;
  /** The same at the 1st of the next month. */
  ratingEnd: number | null;
  ratingChange: number | null;
  cleanDrives: number;
  /** 0 to 1. */
  cleanShare: number;
  longestCleanDriveMiles: number | null;
  hardPer100: number;
  speedingPer100: number;
  pickupsPer100: number;
  categories: WrappedCategories;
  /** Never attention. */
  bestCategory: Exclude<CategoryId, 'attention'> | null;
  /** ISO weekday, 1 = Monday. */
  busiestWeekday: number;
  /** Achievement ids unlocked in the month, oldest first. */
  badges: string[];
  archetype: Archetype;
  percentiles: WrappedPercentiles;
}

/** `get_my_wrapped`: the core plus what stays the driver's own (time band, the splits, goals). */
export interface MyWrapped extends WrappedCore {
  /** 0, 3, 6, … 21: the busiest 3-hour band's first hour. */
  busiestBandStartHour: number;
  weekdayDrives: number;
  weekendDrives: number;
  earlyShare: number;
  rushShare: number;
  goalsCompleted: number;
}

/** `get_shared_wrapped`: the frozen public copy, with whose it is. */
export interface SharedWrapped extends WrappedCore {
  id: string;
  /** The signed-in driver's own share. */
  mine: boolean;
  /** The owner's current username. */
  username: string | null;
  badgesCount: number;
}

/** One line of the archive (`list_my_wrapped`), newest first. */
export interface WrappedArchiveEntry {
  month: string;
  drives: number;
  miles: number;
  archetype: Archetype;
}

export { MONTH_RE, SHARE_ID_RE };

export function useWrappedArchive(opts: { enabled?: boolean } = {}): UseQueryResult<WrappedArchiveEntry[]> {
  return useServerQuery<WrappedArchiveEntry[]>(['wrapped', 'list'], 'list_my_wrapped', undefined, { enabled: opts.enabled ?? true, staleMs: SERVER_SLOW_STALE_MS });
}

/** One month's story; never asked for a malformed month (null data). */
export function useMyWrapped(month: string): UseQueryResult<MyWrapped | null> {
  return useServerQuery<MyWrapped | null>(['wrapped', 'month', month], 'get_my_wrapped', { p_month: month }, { enabled: MONTH_RE.test(month), staleMs: SERVER_SLOW_STALE_MS });
}

/** A shared copy by its id; never asked for a malformed id. */
export function useSharedWrapped(id: string): UseQueryResult<SharedWrapped | null> {
  return useServerQuery<SharedWrapped | null>(['wrapped', 'shared', id], 'get_shared_wrapped', { p_id: id }, { enabled: SHARE_ID_RE.test(id), staleMs: SERVER_SLOW_STALE_MS });
}

/** Makes (or refreshes) the month's one share link and answers its id. */
export async function createWrappedShare(month: string): Promise<string> {
  const id = await callRpc<string>('create_wrapped_share', { p_month: month });
  if (typeof id !== 'string' || !SHARE_ID_RE.test(id)) throw new Error('bad share id');
  return id;
}

/** Stops sharing the month: its link then reads as not available. True when there was a share. */
export async function deleteWrappedShare(month: string): Promise<boolean> {
  return (await callRpc<boolean>('delete_wrapped_share', { p_month: month })) === true;
}
