// utils/driveCache.js
//
// The Insights panel's data: the last 30 days of drives (a server-side range query),
// cached for 5 minutes and invalidated when a drive is finalized. This re-homes the
// AIScreen refetch logic from the backend branch, which keyed on a drive-completed context flag (removed
// by the UX rework): finalize() invalidates, focus refetches when the copy is stale.
import { getAllDriveMetrics, getDriveMetrics } from './firestore';

const TTL_MS = 5 * 60 * 1000;
let cache = { uid: null, drives: [], at: 0 };
// The Rewards tab reads the newest 200 drive documents on every focus to recompute badges;
// they only change when a drive is finalized, which invalidates both caches.
let badgeCache = { uid: null, drives: [], at: 0 };

export function invalidateInsightsCache() {
  cache = { uid: null, drives: [], at: 0 };
  badgeCache = { uid: null, drives: [], at: 0 };
}

/** The newest `maxDrives` drives for the badge rules, cached for 5 minutes. */
export async function getBadgeDrives(uid, { maxDrives = 200, force = false } = {}) {
  if (!uid) return [];
  if (!force && badgeCache.uid === uid && Date.now() - badgeCache.at < TTL_MS) return badgeCache.drives;
  const drives = await getAllDriveMetrics(uid, { maxDrives });
  badgeCache = { uid, drives, at: Date.now() };
  return drives;
}

/** Drives from the last 30 days, oldest first (see getDriveMetrics). */
export async function getInsightsDrives(uid, { force = false } = {}) {
  if (!uid) return [];
  if (!force && cache.uid === uid && Date.now() - cache.at < TTL_MS) return cache.drives;
  const drives = await getDriveMetrics(uid, 30);
  cache = { uid, drives, at: Date.now() };
  return drives;
}
