/**
 * The phone's copy of the last rewards snapshot, in `settings` under `rewards.snapshot` as
 * `{ uid, snapshot }` — one account's, never served to another (a read for another uid is null).
 * The handover wipe empties `settings`, so it never outlives the device's owner either.
 *
 * Validated on read: a snapshot written by an older build that this one cannot read is null, not
 * a half-read screen.
 */
import { z } from 'zod';

import type { SettingsRepo } from '@/data/db/settings';

import { RewardsSnapshotSchema, type RewardsSnapshot } from './api';

export const REWARDS_CACHE_KEY = 'rewards.snapshot';

const CachedSchema = z.object({ uid: z.string(), snapshot: RewardsSnapshotSchema }).strict();

export async function readCachedRewards(
  settings: Pick<SettingsRepo, 'get'>,
  uid: string
): Promise<RewardsSnapshot | null> {
  const parsed = CachedSchema.safeParse(await settings.get<unknown>(REWARDS_CACHE_KEY));
  if (!parsed.success || parsed.data.uid !== uid) return null;
  return parsed.data.snapshot;
}

export async function writeCachedRewards(
  settings: Pick<SettingsRepo, 'set'>,
  uid: string,
  snapshot: RewardsSnapshot
): Promise<void> {
  await settings.set(REWARDS_CACHE_KEY, { uid, snapshot });
}
