// utils/firestore.js
//
// The single data-access layer for user documents and drive history.
//
// Design notes
// ------------
// * Every public function that existed before is still exported with the same name and
//   the same call signature. Optional arguments were added, never required ones.
// * `users/{uid}` is a PUBLIC profile document: the leaderboard and the group member list
//   read other people's copies of it. Anything private lives in `users/{uid}/private/*`,
//   which Firestore rules restrict to the owner. Trusted contacts and the Expo push token
//   used to live on the public document; they are migrated on first write (see
//   saveTrustedContacts / savePushToken).
// * Reads of the user document go through a short-lived in-process cache. A dashboard
//   visit used to issue three separate reads of the same document plus a full read of the
//   drive collection; it now issues one.
// * Nothing here reads a whole collection to answer a question that a count query or a
//   range query can answer on the server.

import {
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
  increment,
  writeBatch,
  runTransaction,
  getCountFromServer,
  deleteField,
  Timestamp,
} from "firebase/firestore";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { db } from "./firebase";

export const DRIVE_METRICS_COLLECTION = "drivemetrics";
export const MAX_USERNAME_LENGTH = 16;

// Firestore caps a batch at 500 operations.
const MAX_BATCH_OPS = 450;

/* ------------------------------------------------------------------ *
 * User document cache
 * ------------------------------------------------------------------ */

const USER_DOC_TTL_MS = 30_000;
const userDocCache = { uid: null, data: null, ts: 0 };

export function invalidateUserCache(uid) {
  if (!uid || userDocCache.uid === uid) {
    userDocCache.uid = null;
    userDocCache.data = null;
    userDocCache.ts = 0;
  }
}

function cacheUserDoc(uid, data) {
  userDocCache.uid = uid;
  userDocCache.data = data;
  userDocCache.ts = Date.now();
  return data;
}

/**
 * One read of `users/{uid}`, cached for 30 seconds.
 * Pass { force: true } straight after a write that must be reflected immediately.
 */
export async function getUserSummary(uid, { force = false } = {}) {
  if (!uid) return null;
  const now = Date.now();
  if (
    !force &&
    userDocCache.uid === uid &&
    userDocCache.data &&
    now - userDocCache.ts < USER_DOC_TTL_MS
  ) {
    return userDocCache.data;
  }

  try {
    const snap = await getDoc(doc(db, "users", uid));
    return cacheUserDoc(uid, snap.exists() ? { id: snap.id, ...snap.data() } : null);
  } catch (err) {
    console.error("Failed to load user document:", err);
    return null;
  }
}

/** Merge-write to `users/{uid}` that keeps the cache honest. */
async function writeUserDoc(uid, data) {
  await setDoc(doc(db, "users", uid), data, { merge: true });
  invalidateUserCache(uid);
}

/* ------------------------------------------------------------------ *
 * Points, username, streak
 * ------------------------------------------------------------------ */

export function getPointsStorageKey(uid) {
  return `totalPoints_${uid}`;
}

export async function getUserPoints(uid) {
  if (!uid) return 0;
  const data = await getUserSummary(uid);
  if (data) return Number(data.points) || 0;

  // First run for this account: create the profile document without clobbering anything
  // another code path may have written in the meantime.
  await writeUserDoc(uid, { points: 0, createdAt: serverTimestamp() });
  return 0;
}

export async function saveUserPoints(uid, points) {
  if (!uid) return;
  const value = Number(points);
  if (!Number.isFinite(value) || value < 0) {
    console.warn("saveUserPoints ignored a non-numeric value:", points);
    return;
  }
  await writeUserDoc(uid, { points: value });
  try {
    await AsyncStorage.setItem(getPointsStorageKey(uid), String(value));
  } catch {}
}

export async function getUsername(uid) {
  if (!uid) return "guest";
  const data = await getUserSummary(uid);
  if (data) return data.username || "guest";

  await writeUserDoc(uid, { username: uid, createdAt: serverTimestamp() });
  return "guest";
}

export async function saveUserStreak(uid, streak) {
  if (!uid) return;
  try {
    await writeUserDoc(uid, { drivingStreak: Number(streak) || 0 });
  } catch (error) {
    console.error("Failed to save user streak:", error);
  }
}

/**
 * Locally cached point total, used by screens that only need a number to render.
 * Falls back to the server value and repairs the cache when it is missing or stale.
 */
export async function getCachedTotalPoints(uid) {
  if (!uid) return 0;
  try {
    const stored = await AsyncStorage.getItem(getPointsStorageKey(uid));
    if (stored !== null) {
      const parsed = parseInt(stored, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch {}

  const data = await getUserSummary(uid);
  const points = Number(data?.points) || 0;
  try {
    await AsyncStorage.setItem(getPointsStorageKey(uid), String(points));
  } catch {}
  return points;
}

/* ------------------------------------------------------------------ *
 * Usernames
 *
 * `usernames/{lowercase}` is a claim registry. It exists because uniqueness cannot be
 * enforced by reading the `users` collection: that read is not allowed while signed out
 * (which is exactly when sign-up needs it) and a read-then-write check races with a second
 * signup of the same name. A claim document makes the check atomic and public-readable
 * without exposing anything else.
 * ------------------------------------------------------------------ */

export function normalizeUsername(username) {
  return String(username ?? "").trim();
}

export function usernameKey(username) {
  return normalizeUsername(username).toLowerCase();
}

export function validateUsername(username) {
  const trimmed = normalizeUsername(username);
  if (!trimmed) return "Username cannot be empty.";
  if (trimmed.length > MAX_USERNAME_LENGTH) {
    return `Username cannot be longer than ${MAX_USERNAME_LENGTH} characters.`;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return "Usernames can only use letters, numbers, dots, dashes and underscores.";
  }
  return null;
}

/**
 * Cheap pre-flight check. Callable while signed out, which is what the sign-up form needs.
 * The authoritative check is claimUsername(), which is transactional.
 */
export async function isUsernameAvailable(username, { forUid = null } = {}) {
  const key = usernameKey(username);
  if (!key) return false;
  try {
    const snap = await getDoc(doc(db, "usernames", key));
    if (!snap.exists()) return true;
    return forUid ? snap.data().uid === forUid : false;
  } catch (err) {
    console.error("Username availability check failed:", err);
    // Fail closed: claimUsername() is still authoritative, so a false negative here only
    // costs the user a retry, whereas a false positive would hand out a duplicate name.
    return false;
  }
}

/**
 * Atomically claim `username` for `uid`, releasing any name the user previously held.
 * Returns true on success, false if the name is taken by somebody else.
 */
export async function claimUsername(uid, username) {
  if (!uid) return false;
  const trimmed = normalizeUsername(username);
  const key = usernameKey(trimmed);
  if (!key) return false;

  const userRef = doc(db, "users", uid);
  const claimRef = doc(db, "usernames", key);

  try {
    const previousKey = await runTransaction(db, async (tx) => {
      const claimSnap = await tx.get(claimRef);
      if (claimSnap.exists() && claimSnap.data().uid !== uid) {
        throw new Error("username-taken");
      }

      const userSnap = await tx.get(userRef);
      const oldKey = userSnap.exists() ? userSnap.data().usernameLower ?? null : null;

      tx.set(claimRef, { uid, username: trimmed, createdAt: serverTimestamp() });
      tx.set(
        userRef,
        { username: trimmed, usernameLower: key },
        { merge: true }
      );
      return oldKey && oldKey !== key ? oldKey : null;
    });

    // Releasing the old claim is a separate write on purpose: a transaction cannot read a
    // document it did not read first, and a leaked claim is recoverable, a lost one is not.
    if (previousKey) {
      try {
        await deleteDoc(doc(db, "usernames", previousKey));
      } catch (err) {
        console.warn("Could not release previous username claim:", err);
      }
    }

    invalidateUserCache(uid);
    return true;
  } catch (err) {
    if (err?.message === "username-taken") return false;
    console.error("Failed to claim username:", err);
    throw err;
  }
}

/** Create the profile document for a brand new account (email or Google sign-in). */
export async function ensureUserProfile(user, { username = null } = {}) {
  if (!user?.uid) return null;
  const uid = user.uid;

  const existing = await getUserSummary(uid, { force: true });
  // Fully provisioned already (a returning Google sign-in) - nothing to do.
  if (existing && existing.username && typeof existing.points === "number") return existing;

  const profile = {
    points: existing?.points ?? 0,
    drivingStreak: existing?.drivingStreak ?? 0,
    totalDrives: existing?.totalDrives ?? 0,
    photoURL: existing?.photoURL ?? user.photoURL ?? null,
    groupId: existing?.groupId ?? null,
    isDriving: false,
    createdAt: existing?.createdAt ?? serverTimestamp(),
  };
  await writeUserDoc(uid, profile);

  if (user.email) {
    await savePrivateInfo(uid, { email: user.email });
  }

  const desired = normalizeUsername(username) || existing?.username || (await suggestUsername(user));
  const alreadyClaimed = existing?.usernameLower === usernameKey(desired);
  if (desired && !alreadyClaimed) {
    const claimed = await claimUsername(uid, desired);
    if (!claimed) {
      // Extremely unlikely collision on a derived name; fall back to something unique.
      await claimUsername(uid, `${desired.slice(0, 10)}${uid.slice(0, 5)}`);
    }
  }

  return getUserSummary(uid, { force: true });
}

async function suggestUsername(user) {
  const base =
    (user.displayName || user.email?.split("@")[0] || "driver")
      .replace(/[^A-Za-z0-9_.-]/g, "")
      .slice(0, 10) || "driver";
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = attempt === 0 ? base : `${base}${Math.floor(Math.random() * 10000)}`;
    if (await isUsernameAvailable(candidate, { forUid: user.uid })) return candidate;
  }
  return `${base}${user.uid.slice(0, 6)}`;
}

/* ------------------------------------------------------------------ *
 * Private per-user data (never readable by other signed-in users)
 * ------------------------------------------------------------------ */

function privateDoc(uid, name) {
  return doc(db, "users", uid, "private", name);
}

export async function savePrivateInfo(uid, info) {
  if (!uid) return;
  try {
    await setDoc(privateDoc(uid, "info"), { ...info, updatedAt: serverTimestamp() }, { merge: true });
  } catch (err) {
    console.error("Failed to save private profile info:", err);
  }
}

export async function saveTrustedContacts(uid, contacts) {
  if (!uid) return;
  const list = Array.isArray(contacts) ? contacts : [];
  try {
    await setDoc(
      privateDoc(uid, "contacts"),
      { contacts: list, updatedAt: serverTimestamp() },
      { merge: true }
    );
    // Contacts are third-party phone numbers. Remove the legacy public copy if it is
    // still there so it stops being readable by every signed-in account.
    const summary = await getUserSummary(uid);
    if (summary && summary.trustedContacts !== undefined) {
      await updateDoc(doc(db, "users", uid), { trustedContacts: deleteField() });
      invalidateUserCache(uid);
    }
  } catch (error) {
    console.error("Error saving trusted contacts:", error);
  }
}

export async function getTrustedContacts(uid) {
  if (!uid) return [];
  try {
    const snap = await getDoc(privateDoc(uid, "contacts"));
    if (snap.exists()) {
      const list = snap.data().contacts;
      if (Array.isArray(list)) return list;
    }
    // Legacy location, kept readable until the user next edits their contacts.
    const summary = await getUserSummary(uid);
    return Array.isArray(summary?.trustedContacts) ? summary.trustedContacts : [];
  } catch (error) {
    console.error("Error loading trusted contacts:", error);
    return [];
  }
}

export async function savePushToken(uid, token, platform = null) {
  if (!uid || !token) return;
  try {
    await setDoc(
      privateDoc(uid, "push"),
      { token, platform, updatedAt: serverTimestamp() },
      { merge: true }
    );
    const summary = await getUserSummary(uid);
    if (summary && summary.pushToken !== undefined) {
      await updateDoc(doc(db, "users", uid), { pushToken: deleteField() });
      invalidateUserCache(uid);
    }
  } catch (err) {
    console.error("Error saving push token:", err);
  }
}

/* ------------------------------------------------------------------ *
 * Drive history
 * ------------------------------------------------------------------ */

function driveMetricsRef(uid) {
  return collection(db, "users", uid, DRIVE_METRICS_COLLECTION);
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function mapDrive(docSnap) {
  const data = docSnap.data();
  return {
    id: docSnap.id,
    ...data,
    timestamp: toDate(data.timestamp) ?? new Date(),
  };
}

/**
 * Total number of drives.
 * Prefers the `totalDrives` counter maintained by finalizeDriveWrite (zero extra reads,
 * it rides along on the user document the caller already needed). Falls back to a server
 * count query - which reads one index entry, not one document per drive - and backfills
 * the counter so the fallback is only ever taken once per account.
 */
export async function getTotalDrivesNumber(uid) {
  if (!uid) return 0;

  try {
    const summary = await getUserSummary(uid);
    if (summary && Number.isFinite(summary.totalDrives)) {
      return summary.totalDrives;
    }

    const snapshot = await getCountFromServer(driveMetricsRef(uid));
    const count = snapshot.data().count;

    if (summary) {
      try {
        await writeUserDoc(uid, { totalDrives: count });
      } catch {}
    }
    return count;
  } catch (error) {
    console.error("Failed to count drives:", error);
    return 0;
  }
}

/** Newest-first drive history. `pageSize` is optional and unbounded when omitted. */
export async function getUserDrives(uid, { pageSize = null, cursor = null } = {}) {
  if (!uid) return [];
  try {
    const constraints = [orderBy("timestamp", "desc")];
    if (cursor) constraints.push(startAfter(cursor));
    if (pageSize) constraints.push(limit(pageSize));

    const snapshot = await getDocs(query(driveMetricsRef(uid), ...constraints));
    return snapshot.docs.map(mapDrive);
  } catch (error) {
    console.error("Failed to load drives:", error);
    return [];
  }
}

/**
 * One page of drive history plus the cursor needed for the next page.
 * Returns { drives, cursor, hasMore } - pass `cursor` straight back in.
 */
export async function getDriveHistoryPage(uid, { pageSize = 20, cursor = null } = {}) {
  if (!uid) return { drives: [], cursor: null, hasMore: false };
  try {
    const constraints = [orderBy("timestamp", "desc")];
    if (cursor) constraints.push(startAfter(cursor));
    // One extra document tells us whether another page exists without a second query.
    constraints.push(limit(pageSize + 1));

    const snapshot = await getDocs(query(driveMetricsRef(uid), ...constraints));
    const docs = snapshot.docs;
    const hasMore = docs.length > pageSize;
    const page = hasMore ? docs.slice(0, pageSize) : docs;

    return {
      drives: page.map(mapDrive),
      cursor: page.length ? page[page.length - 1] : cursor,
      hasMore,
    };
  } catch (error) {
    console.error("Failed to load drive history page:", error);
    return { drives: [], cursor: null, hasMore: false };
  }
}

/**
 * Drive totals for the history summary, answered by count queries so the screen never has
 * to hold every drive in memory to show three numbers.
 */
export async function getDriveCounts(uid) {
  if (!uid) return { total: 0, distracted: 0, focused: 0 };
  try {
    const ref = driveMetricsRef(uid);
    const [totalSnap, distractedSnap] = await Promise.all([
      getCountFromServer(ref),
      getCountFromServer(query(ref, where("distracted", ">", 0))),
    ]);
    const total = totalSnap.data().count;
    const distracted = distractedSnap.data().count;
    return { total, distracted, focused: Math.max(0, total - distracted) };
  } catch (error) {
    console.error("Failed to count drive history:", error);
    return { total: 0, distracted: 0, focused: 0 };
  }
}

export async function saveDriveMetrics(uid, metrics) {
  if (!uid) return null;

  const payload = { ...metrics, timestamp: serverTimestamp() };

  try {
    const ref = await addDoc(driveMetricsRef(uid), payload);
    await writeUserDoc(uid, { totalDrives: increment(1), lastDriveAt: serverTimestamp() });
    return ref.id;
  } catch (err) {
    try {
      // The profile document has to exist before a subcollection write is allowed by rules.
      await writeUserDoc(uid, { createdAt: serverTimestamp() });
      const ref = await addDoc(driveMetricsRef(uid), payload);
      await writeUserDoc(uid, { totalDrives: increment(1), lastDriveAt: serverTimestamp() });
      return ref.id;
    } catch (retryErr) {
      console.error("Failed to save drive metrics (after init):", retryErr);
      return null;
    }
  }
}

/**
 * The single write path used when a drive ends.
 *
 * Previously this was four independent round trips (save metrics, read the user document,
 * write the streak, and later a points write from the dashboard). Any of them could land
 * without the others, the streak read/modify/write raced with itself, and points only
 * reached the server if the user happened to open the dashboard afterwards. It is now one
 * atomic batch with server-side increments, so a killed app cannot lose or duplicate it.
 */
export async function finalizeDriveWrite(uid, { metrics, pointsEarned = 0, wasDistracted = false }) {
  if (!uid) return null;

  const points = Number(pointsEarned) || 0;
  const driveRef = doc(driveMetricsRef(uid));
  const userRef = doc(db, "users", uid);

  const batch = writeBatch(db);
  batch.set(driveRef, { ...metrics, timestamp: serverTimestamp() });
  batch.set(
    userRef,
    {
      points: increment(points),
      drivingStreak: wasDistracted ? 0 : increment(1),
      totalDrives: increment(1),
      lastDriveAt: serverTimestamp(),
      isDriving: false,
    },
    { merge: true }
  );

  await batch.commit();
  invalidateUserCache(uid);

  const summary = await getUserSummary(uid, { force: true });
  const total = Number(summary?.points) || 0;
  try {
    await AsyncStorage.setItem(getPointsStorageKey(uid), String(total));
  } catch {}

  return { driveId: driveRef.id, totalPoints: total, streak: summary?.drivingStreak ?? 0 };
}

/**
 * Drives from the last `daysBack` days, oldest first.
 * The date filter runs on the server; this used to download the whole collection and throw
 * most of it away on the device.
 */
export async function getDriveMetrics(uid, daysBack = 30) {
  if (!uid) return [];
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    cutoff.setHours(0, 0, 0, 0);

    const snapshot = await getDocs(
      query(
        driveMetricsRef(uid),
        where("timestamp", ">=", Timestamp.fromDate(cutoff)),
        orderBy("timestamp", "asc")
      )
    );
    return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  } catch (err) {
    console.error("Failed to fetch drive metrics:", err);
    return [];
  }
}

/** Every drive. `maxDrives` caps an otherwise unbounded read. */
export async function getAllDriveMetrics(uid, { maxDrives = null } = {}) {
  if (!uid) return [];
  try {
    const constraints = [orderBy("timestamp", "desc")];
    if (maxDrives) constraints.push(limit(maxDrives));
    const snapshot = await getDocs(query(driveMetricsRef(uid), ...constraints));
    return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  } catch (err) {
    console.error("Failed to fetch all drive metrics:", err);
    return [];
  }
}

/** Delete every drive, in batches instead of one round trip per document. */
export async function clearUserDrives(uid) {
  if (!uid) return;
  try {
    for (;;) {
      const snapshot = await getDocs(query(driveMetricsRef(uid), limit(MAX_BATCH_OPS)));
      if (snapshot.empty) break;

      const batch = writeBatch(db);
      snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();

      if (snapshot.size < MAX_BATCH_OPS) break;
    }
    await writeUserDoc(uid, { totalDrives: 0 });
  } catch (error) {
    console.error("Error clearing user drives:", error);
  }
}

/* ------------------------------------------------------------------ *
 * Drive state flag
 * ------------------------------------------------------------------ */

export const startDriving = async (userId) => {
  if (!userId) return;
  try {
    await writeUserDoc(userId, { isDriving: true });
  } catch (error) {
    console.error("Error setting isDriving to true:", error);
  }
};

export const stopDriving = async (userId) => {
  if (!userId) return;
  try {
    await writeUserDoc(userId, { isDriving: false });
  } catch (error) {
    console.error("Error setting isDriving to false:", error);
  }
};
