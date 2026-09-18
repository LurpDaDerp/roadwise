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
const userDocCache = { uid: null, data: null, ts: 0, exists: false };

// A read can end three ways, and conflating them causes real damage: "the document is not
// there" justifies creating a profile and caching 0 points, "the read failed" (offline,
// expired token, a rules denial) justifies neither. Callers that write anything as a
// result of a read must use readUserSummary and check `status`.
const READ_OK = "ok";
const READ_MISSING = "missing";
const READ_ERROR = "error";

export function invalidateUserCache(uid) {
  if (!uid || userDocCache.uid === uid) {
    userDocCache.uid = null;
    userDocCache.data = null;
    userDocCache.ts = 0;
    userDocCache.exists = false;
  }
}

function cacheUserDoc(uid, data, exists) {
  userDocCache.uid = uid;
  userDocCache.data = data;
  userDocCache.exists = exists;
  userDocCache.ts = Date.now();
}

/**
 * One read of `users/{uid}`, cached for 30 seconds.
 * Returns { status, data }. Only successful reads are cached - a failure never evicts or
 * overwrites a good cached value.
 */
export async function readUserSummary(uid, { force = false } = {}) {
  if (!uid) return { status: READ_MISSING, data: null };

  const now = Date.now();
  if (!force && userDocCache.uid === uid && now - userDocCache.ts < USER_DOC_TTL_MS) {
    return {
      status: userDocCache.exists ? READ_OK : READ_MISSING,
      data: userDocCache.data,
    };
  }

  try {
    const snap = await getDoc(doc(db, "users", uid));
    const exists = snap.exists();
    const data = exists ? { id: snap.id, ...snap.data() } : null;
    cacheUserDoc(uid, data, exists);
    return { status: exists ? READ_OK : READ_MISSING, data };
  } catch (err) {
    console.error("Failed to load user document:", err);
    // Serve a still-valid cached copy rather than pretending the account is empty.
    if (userDocCache.uid === uid && userDocCache.exists) {
      return { status: READ_OK, data: userDocCache.data, stale: true };
    }
    return { status: READ_ERROR, data: null, error: err };
  }
}

/**
 * Convenience wrapper: the document, or null if it is missing OR unreadable.
 * Use readUserSummary instead anywhere the difference can cause a write.
 */
export async function getUserSummary(uid, options) {
  const { data } = await readUserSummary(uid, options);
  return data;
}

/** Merge-write to `users/{uid}` that keeps the cache honest. */
async function writeUserDoc(uid, data) {
  await setDoc(doc(db, "users", uid), data, { merge: true });
  invalidateUserCache(uid);
}

/* ------------------------------------------------------------------ *
 * Points, username, streak
 * ------------------------------------------------------------------ */

function getPointsStorageKey(uid) {
  return `totalPoints_${uid}`;
}

/**
 * The local points cache is a display convenience, and points only ever go up, so a read
 * that comes back lower than what is cached is either stale or wrong. Never lower it.
 */
async function cachePointsIfHigher(uid, points) {
  if (!uid || !Number.isFinite(points)) return;
  try {
    const key = getPointsStorageKey(uid);
    const stored = await AsyncStorage.getItem(key);
    const previous = stored === null ? -1 : parseInt(stored, 10);
    if (!Number.isFinite(previous) || points >= previous) {
      await AsyncStorage.setItem(key, String(points));
    }
  } catch {}
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

function normalizeUsername(username) {
  return String(username ?? "").trim();
}

function usernameKey(username) {
  return normalizeUsername(username).toLowerCase();
}

export function validateUsername(username) {
  const trimmed = normalizeUsername(username);
  if (!trimmed) return "Username cannot be empty.";
  if (trimmed.length > MAX_USERNAME_LENGTH) {
    return `Username cannot be longer than ${MAX_USERNAME_LENGTH} characters.`;
  }
  // The lowercased name becomes a Firestore document id, so it must start with an
  // alphanumeric and contain at least one. That rules out "." and ".." (which are not
  // legal document ids at all) and all-punctuation names, which would otherwise fail
  // deep inside claimUsername - after the auth account had already been created.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed)) {
    return "Usernames must start with a letter or number, and can only use letters, numbers, dots, dashes and underscores.";
  }
  if (trimmed.includes("/")) {
    return "Usernames cannot contain a slash.";
  }
  return null;
}

/** True when `username` can safely be used as a `usernames/{id}` document id. */
function isValidUsernameKey(username) {
  const key = usernameKey(username);
  if (!key || key.length > MAX_USERNAME_LENGTH) return false;
  if (key === "." || key === "..") return false;
  if (key.includes("/")) return false;
  return /^[a-z0-9][a-z0-9_.-]*$/.test(key);
}

/**
 * Cheap pre-flight check. Callable while signed out, which is what the sign-up form needs.
 * The authoritative check is claimUsername(), which is transactional.
 */
export async function isUsernameAvailable(username, { forUid = null } = {}) {
  const key = usernameKey(username);
  if (!key || !isValidUsernameKey(username)) return false;
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
  if (!key || !isValidUsernameKey(trimmed)) return false;

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

  const { status, data: existing } = await readUserSummary(uid, { force: true });

  // A failed read must not lead to provisioning: writing the defaults over a real account
  // would try to reset its points (the rules would refuse, leaving a confusing error).
  if (status === READ_ERROR) return null;

  // Fully provisioned already (a returning Google sign-in) - nothing to do.
  if (existing && existing.username && typeof existing.points === "number") return existing;

  const profile = {
    points: existing?.points ?? 0,
    drivingStreak: existing?.drivingStreak ?? 0,
    totalDrives: existing?.totalDrives ?? 0,
    photoURL: existing?.photoURL ?? user.photoURL ?? null,
    // groupId is NOT written here: it lives in users/{uid}/private/info and the rules
    // refuse any write that puts it back on the public profile (legacyOnlyRemoved).
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
  const cleaned = (user.displayName || user.email?.split("@")[0] || "driver")
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 10);
  const base = /^[A-Za-z0-9]/.test(cleaned) ? cleaned : "driver";
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

/** The owner-only profile document, exposed so group writes can batch against it. */
export function privateInfoRef(uid) {
  return privateDoc(uid, "info");
}

/**
 * The group id is the group's join code, and the group document id is that same code.
 * While it sat on the publicly readable profile, anyone could list users, read a code and
 * use the join rule to insert themselves into that family. It lives in the owner-only
 * private document now.
 *
 * Returns the id, or `undefined` when the read FAILED (offline, expired token, denial).
 * `null` means a confirmed "not in a group" - callers must not treat the two the same.
 */
export async function getGroupIdForUser(uid) {
  if (!uid) return null;
  try {
    const snap = await getDoc(privateDoc(uid, "info"));
    if (snap.exists()) {
      const value = snap.data().groupId;
      if (typeof value === "string" && value) return value;
      if (value === null) return null;
    }
  } catch (err) {
    console.warn("Could not read private profile info:", err);
    return undefined;
  }

  // Accounts that have not been migrated yet still carry it on the public profile.
  const { status, data } = await readUserSummary(uid);
  if (status === READ_ERROR) return undefined;
  const legacy = data?.groupId;
  return typeof legacy === "string" && legacy ? legacy : null;
}

/**
 * Remove the legacy public `groupId` field if this account still carries one.
 *
 * The migration script clears these in bulk, but an un-migrated account that joins or
 * leaves a group would otherwise keep a stale public copy of its join code - which is the
 * exact thing that made group codes enumerable. Best effort: the group membership write
 * is what matters and has already committed by the time this runs.
 */
export async function clearLegacyPublicGroupId(uid) {
  if (!uid) return;
  try {
    const { status, data } = await readUserSummary(uid);
    if (status !== READ_OK || !data || data.groupId === undefined) return;
    await updateDoc(doc(db, "users", uid), { groupId: deleteField() });
    invalidateUserCache(uid);
  } catch (err) {
    console.warn("Could not remove the legacy public groupId:", err);
  }
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

// The pre-migration public `pushToken` field is removed at most once per app run: it is gone
// after the first save, and the check used to cost a user-document read on every call.
const legacyPushFieldChecked = new Set();

export async function savePushToken(uid, token, platform = null) {
  if (!uid || !token) return;
  try {
    await setDoc(
      privateDoc(uid, "push"),
      { token, platform, updatedAt: serverTimestamp() },
      { merge: true }
    );
    if (!legacyPushFieldChecked.has(uid)) {
      legacyPushFieldChecked.add(uid);
      const summary = await getUserSummary(uid);
      if (summary && summary.pushToken !== undefined) {
        await updateDoc(doc(db, "users", uid), { pushToken: deleteField() });
        invalidateUserCache(uid);
      }
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
// Three count queries, run on EVERY Drives-tab focus and every Rewards-tab focus. The numbers
// only move when a drive is finalized, which already invalidates this cache, so tab-flipping
// costs nothing.
const DRIVE_COUNTS_TTL_MS = 5 * 60 * 1000;
let driveCountsCache = { uid: null, value: null, at: 0 };

export function invalidateDriveCounts() {
  driveCountsCache = { uid: null, value: null, at: 0 };
}

export async function getDriveCounts(uid, { force = false } = {}) {
  if (!uid) return { total: 0, distracted: 0, focused: 0 };
  if (!force && driveCountsCache.uid === uid && driveCountsCache.value
      && Date.now() - driveCountsCache.at < DRIVE_COUNTS_TTL_MS) {
    return driveCountsCache.value;
  }
  try {
    const ref = driveMetricsRef(uid);
    // `distracted` is a COUNT on records written by this build, but older records stored a
    // boolean. Firestore compares across types by type order, so `> 0` misses `true`
    // entirely; both shapes are counted and the totals added.
    const [totalSnap, numericSnap, booleanSnap] = await Promise.all([
      getCountFromServer(ref),
      getCountFromServer(query(ref, where("distracted", ">", 0))),
      getCountFromServer(query(ref, where("distracted", "==", true))),
    ]);
    const total = totalSnap.data().count;
    const distracted = numericSnap.data().count + booleanSnap.data().count;
    const value = {
      total,
      distracted: Math.min(total, distracted),
      focused: Math.max(0, total - distracted),
    };
    driveCountsCache = { uid, value, at: Date.now() };
    return value;
  } catch (error) {
    console.error("Failed to count drive history:", error);
    // A stale copy is better than three zeros on a flaky connection.
    if (driveCountsCache.uid === uid && driveCountsCache.value) return driveCountsCache.value;
    return { total: 0, distracted: 0, focused: 0 };
  }
}

/* ------------------------------------------------------------------ *
 * Drive finalization
 * ------------------------------------------------------------------ */

const PENDING_DRIVES_KEY = "pendingDriveFinalizations";
const MAX_PENDING_DRIVES = 25;

/**
 * How long a drive commit may take before it is treated as "did not get through".
 *
 * The Firestore web SDK accepts a write while offline and resolves `commit()` only when the
 * SERVER acknowledges it - which, with no signal, is never. Without a bound, ending a drive hung
 * on "Saving your drive…" with the end button disabled and the back gesture suppressed, the retry
 * queue (which only ever sees rejections) never engaged, and a force-quit lost the write with the
 * default in-memory cache. Eight seconds is far longer than a healthy commit and short enough
 * that the driver is not left staring at a spinner.
 */
const DRIVE_COMMIT_TIMEOUT_MS = 8000;
const SUMMARY_READ_TIMEOUT_MS = 5000;

/** Rejects with a recognisable error when `promise` has not settled within `ms`. */
function withDeadline(promise, ms, label) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms} ms`);
      err.code = "deadline-exceeded";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function pendingDrivesKey(uid) {
  return `${PENDING_DRIVES_KEY}_${uid}`;
}

async function readPendingDrives(uid) {
  try {
    const raw = await AsyncStorage.getItem(pendingDrivesKey(uid));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writePendingDrives(uid, list) {
  try {
    await AsyncStorage.setItem(
      pendingDrivesKey(uid),
      JSON.stringify(list.slice(-MAX_PENDING_DRIVES))
    );
  } catch (err) {
    console.error("Could not persist the pending drive queue:", err);
  }
}

/** How many finished drives are waiting to reach the server. */
export async function getPendingDriveCount(uid) {
  if (!uid) return 0;
  return (await readPendingDrives(uid)).length;
}

async function queuePendingDrive(uid, entry) {
  const list = await readPendingDrives(uid);
  if (list.some((item) => item.driveId === entry.driveId)) return;
  list.push(entry);
  await writePendingDrives(uid, list);
}

function driveProfileUpdate(pointsEarned, wasDistracted) {
  return {
    points: increment(Number(pointsEarned) || 0),
    drivingStreak: wasDistracted ? 0 : increment(1),
    totalDrives: increment(1),
    lastDriveAt: serverTimestamp(),
    isDriving: false,
  };
}

/** The fast path: one atomic batch, bounded so a dead network cannot hang the drive screen. */
async function commitDriveBatch(uid, { driveId, metrics, pointsEarned, wasDistracted }) {
  const driveRef = doc(db, "users", uid, DRIVE_METRICS_COLLECTION, driveId);
  const userRef = doc(db, "users", uid);

  const batch = writeBatch(db);
  batch.set(driveRef, { ...metrics, timestamp: serverTimestamp() });
  batch.set(userRef, driveProfileUpdate(pointsEarned, wasDistracted), { merge: true });

  await withDeadline(batch.commit(), DRIVE_COMMIT_TIMEOUT_MS, "drive commit");
  invalidateUserCache(uid);
}

/**
 * The RETRY path: the existence check and the profile increments in ONE transaction.
 *
 * A queued drive may have been committed after all - the original `commit()` hit the deadline
 * above but the SDK delivered it later. A `getDoc` cannot decide that safely: offline it answers
 * from the local cache, which already has the pending write applied, so the entry would be
 * dropped from the queue and the drive lost. A transaction always talks to the server, so it
 * either proves the record is there (and re-applies nothing) or writes it exactly once.
 *
 * @returns {boolean} true when the record is on the server after this call.
 */
async function commitDriveTransaction(uid, { driveId, metrics, pointsEarned, wasDistracted }) {
  const driveRef = doc(db, "users", uid, DRIVE_METRICS_COLLECTION, driveId);
  const userRef = doc(db, "users", uid);

  await withDeadline(
    runTransaction(db, async (tx) => {
      const existing = await tx.get(driveRef);
      if (existing.exists()) return;                       // already landed: no double credit
      tx.set(driveRef, { ...metrics, timestamp: serverTimestamp() });
      tx.set(userRef, driveProfileUpdate(pointsEarned, wasDistracted), { merge: true });
    }),
    DRIVE_COMMIT_TIMEOUT_MS,
    "drive retry"
  );
  invalidateUserCache(uid);
  return true;
}

/**
 * The single write path used when a drive ends.
 *
 * Previously this was four independent round trips (save metrics, read the user document,
 * write the streak, and later a points write from the dashboard). Any of them could land
 * without the others, the streak read/modify/write raced with itself, and points only
 * reached the server if the user happened to open the dashboard afterwards. It is one
 * atomic batch with server-side increments now, so a killed app cannot lose or duplicate
 * one half of it.
 *
 * If the commit fails - no signal at the end of a drive is the common case - the drive is
 * queued in AsyncStorage under a client-chosen document id and retried on the next app
 * launch and the next drive start. The document id is chosen up front so a retry after a
 * lost response overwrites the same record instead of creating a second one, and the
 * retry checks for it before re-applying the profile increments.
 *
 * Returns { driveId, totalPoints, streak, queued }.
 */
export async function finalizeDriveWrite(uid, { metrics, pointsEarned = 0, wasDistracted = false }) {
  if (!uid) return null;

  const driveId = doc(driveMetricsRef(uid)).id;
  const entry = {
    driveId,
    metrics,
    pointsEarned: Number(pointsEarned) || 0,
    wasDistracted: Boolean(wasDistracted),
    queuedAt: Date.now(),
  };

  try {
    await commitDriveBatch(uid, entry);
  } catch (err) {
    // A deadline is the offline case, not a bug: queue it and let the summary say
    // "saved on this device". The write may still land later; the retry path is a
    // transaction precisely so that a late arrival cannot become double credit.
    console.error("Drive finalization failed; queued for retry:", err);
    await queuePendingDrive(uid, entry);
    return { driveId, totalPoints: null, streak: null, queued: true };
  }

  // Bounded for the same reason as the commit: the summary screen waits on this.
  let status = READ_ERROR;
  let data = null;
  try {
    ({ status, data } = await withDeadline(
      readUserSummary(uid, { force: true }),
      SUMMARY_READ_TIMEOUT_MS,
      "post-drive profile read"
    ));
  } catch (err) {
    status = READ_ERROR;
    data = null;
  }
  const total = status === READ_OK ? Number(data?.points) || 0 : null;
  if (total !== null) await cachePointsIfHigher(uid, total);

  return {
    driveId,
    totalPoints: total,
    streak: data?.drivingStreak ?? null,
    queued: false,
  };
}

/**
 * Retry every queued drive. Safe to call on every launch and every drive start: a drive
 * whose record already exists on the server is dropped from the queue without re-applying
 * its points, so a lost response cannot become double credit.
 *
 * Returns { flushed, remaining }.
 */
export async function flushPendingDriveWrites(uid) {
  if (!uid) return { flushed: 0, remaining: 0 };

  const pending = await readPendingDrives(uid);
  if (pending.length === 0) return { flushed: 0, remaining: 0 };

  const remaining = [];
  let flushed = 0;

  for (const entry of pending) {
    try {
      // One transaction does the existence check and the write, so a record that landed after
      // its original commit timed out is recognised on the SERVER rather than in a local cache
      // that already shows the pending write.
      await commitDriveTransaction(uid, entry);
      flushed++;
    } catch (err) {
      console.warn("Could not flush a pending drive; will retry later:", err);
      remaining.push(entry);
    }
  }

  await writePendingDrives(uid, remaining);
  return { flushed, remaining: remaining.length };
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
