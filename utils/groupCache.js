// utils/groupCache.js
//
// The background location task cannot afford a Firestore read on every position fix just
// to discover which group to write to, so the user's group id is mirrored into
// AsyncStorage. This lives in its own module so that both the task (LocationService) and
// the group operations (groups.js) can use it without importing each other.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { doc, getDoc, getFirestore } from "firebase/firestore";

const GROUP_ID_STORAGE_KEY = "cachedGroupId";
const NULL_SENTINEL = "__null__";

function storageKey(uid) {
  return `${GROUP_ID_STORAGE_KEY}_${uid}`;
}

/** Cached group id, falling back to one read of the user document. */
export async function getCachedGroupId(uid) {
  if (!uid) return null;
  try {
    const stored = await AsyncStorage.getItem(storageKey(uid));
    if (stored !== null) return stored === NULL_SENTINEL ? null : stored;
  } catch {}

  try {
    const snap = await getDoc(doc(getFirestore(), "users", uid));
    const groupId = snap.exists() ? snap.data().groupId ?? null : null;
    await AsyncStorage.setItem(storageKey(uid), groupId ?? NULL_SENTINEL);
    return groupId;
  } catch (err) {
    console.warn("Could not resolve group id:", err);
    return null;
  }
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
