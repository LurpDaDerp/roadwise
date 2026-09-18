// utils/driveCache.js
//
// The Insights panel's data: the last 30 days of drives (a server-side range query),
// cached for 5 minutes and invalidated when a drive is finalized. This re-homes the
// AIScreen refetch logic from the backend branch, which keyed on DriveContext (removed
// by the UX rework): finalize() invalidates, focus refetches when the copy is stale.
import { getDriveMetrics } from './firestore';

const TTL_MS = 5 * 60 * 1000;
let cache = { uid: null, drives: [], at: 0 };

export function invalidateInsightsCache() {
  cache = { uid: null, drives: [], at: 0 };
}

export function insightsCacheAge(uid) {
  return cache.uid === uid && cache.at ? Date.now() - cache.at : Infinity;
}

/** Drives from the last 30 days, oldest first (see getDriveMetrics). */
export async function getInsightsDrives(uid, { force = false } = {}) {
  if (!uid) return [];
  if (!force && cache.uid === uid && Date.now() - cache.at < TTL_MS) return cache.drives;
  const drives = await getDriveMetrics(uid, 30);
  cache = { uid, drives, at: Date.now() };
  return drives;
}
