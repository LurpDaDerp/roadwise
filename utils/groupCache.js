// utils/groupCache.js
//
// The background location task cannot afford a Firestore read on every position fix just
// to discover which group to write to, so the user's group id is mirrored into
// AsyncStorage. This lives in its own module so that both the task (LocationService) and
// the group operations (groups.js) can use it without importing each other.
//
// Three-valued on purpose:
//   string     - in this group
//   null       - confirmed NOT in a group
//   undefined  - could not find out (offline, expired token, rules denial)
//
// Collapsing the last two into null is what made the background task unregister itself:
// a single failed read in the background looked exactly like "the user left their group".
// Only a confirmed null is cached, and only a confirmed null stops tracking.

import AsyncStorage from "@react-native-async-storage/async-storage";

import { getGroupIdForUser } from "./firestore";

const GROUP_ID_STORAGE_KEY = "cachedGroupId";
const NULL_SENTINEL = "__null__";

function storageKey(uid) {
  return `${GROUP_ID_STORAGE_KEY}_${uid}`;
}

/**
 * Cached group id, falling back to one read of the owner's private profile document.
 * Returns a string, null (confirmed no group), or undefined (lookup failed).
 */
export async function getCachedGroupId(uid) {
  if (!uid) return null;

  try {
    const stored = await AsyncStorage.getItem(storageKey(uid));
    if (stored !== null) return stored === NULL_SENTINEL ? null : stored;
  } catch {
    // Storage is unavailable; fall through to the network read.
  }

  const groupId = await getGroupIdForUser(uid);
  if (groupId === undefined) return undefined;

  // Only a successful read is written back, so a transient failure cannot poison the
  // cache with a "no group" answer that then persists across launches.
  try {
    await AsyncStorage.setItem(storageKey(uid), groupId ?? NULL_SENTINEL);
  } catch {}

  return groupId;
}

export async function updateCachedGroupId(uid, groupId) {
  if (!uid) return;
  try {
    await AsyncStorage.setItem(storageKey(uid), groupId ?? NULL_SENTINEL);
  } catch {}
}

export async function clearCachedGroupId(uid) {
  if (!uid) return;
  try {
    await AsyncStorage.removeItem(storageKey(uid));
  } catch {}
}
