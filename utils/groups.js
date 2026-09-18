// utils/groups.js
//
// Every write to `groups/{groupId}` goes through this module.
//
// Before, group handling was spread across LocationScreen, DriveScreen and LocationService,
// each with its own idea of the shape of the document - and creating a group never actually
// created the document, so the group name the user typed was silently dropped and the
// document only sprang into existence when the background location task merged a member
// location into it.
//
// The document now has an explicit shape:
//   groups/{groupId} = {
//     groupName: string,
//     createdBy: uid,
//     createdAt: timestamp,
//     members: [uid, ...],              // membership, used by security rules
//     memberLocations: { uid: { latitude, longitude, speed, updatedAt, emergency } },
//     savedLocations: [{ name, address, createdBy }],
//   }
//
// `members` is what Firestore rules check, so a group is only readable by the people in it.
// Legacy groups that predate this field stay readable because the rules also accept a uid
// that appears in `memberLocations`.

import {
  doc,
  getDoc,
  updateDoc,
  writeBatch,
  arrayUnion,
  arrayRemove,
  deleteField,
  serverTimestamp,
} from "firebase/firestore";
import * as Crypto from "expo-crypto";

import { db } from "./firebase";
import {
  getGroupIdForUser,
  privateInfoRef,
  clearLegacyPublicGroupId,
} from "./firestore";
import { updateCachedGroupId } from "./groupCache";

// Ambiguous characters (0/O, 1/I) are left out so a code can be read aloud and typed back.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

/**
 * Math.random() is not a suitable source for something that is the only thing standing
 * between a stranger and a family's live location, and its previous form
 * (`Math.random().toString(36).substring(2, 8)`) could also return fewer than six
 * characters. This uses the platform CSPRNG over a 32 character alphabet: 32^8 codes.
 */
function generateGroupCode() {
  let bytes;
  try {
    bytes = Crypto.getRandomBytes(CODE_LENGTH);
  } catch (err) {
    // Should not happen on a device, but a weak code beats no code at all.
    console.warn("CSPRNG unavailable, falling back to Math.random for the group code:", err);
    bytes = Array.from({ length: CODE_LENGTH }, () => Math.floor(Math.random() * 256));
  }

  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function normalizeGroupCode(code) {
  return String(code ?? "").trim().toUpperCase();
}

function emptyLocation() {
  return {
    latitude: null,
    longitude: null,
    speed: 0,
    updatedAt: new Date(),
    emergency: false,
  };
}

/**
 * The caller's current group id, from their private profile document.
 * Returns undefined when the lookup failed - see utils/groupCache.js.
 */
export async function getCurrentGroupId(uid) {
  if (!uid) return null;
  return getGroupIdForUser(uid);
}

/**
 * Create a group and join it. Retries on the (vanishingly unlikely) case of a code
 * collision, which surfaces as a permission error because the rules only allow a create.
 */
export async function createGroup(uid, groupName) {
  if (!uid) throw new Error("Not signed in.");
  const name = String(groupName ?? "").trim();
  if (!name) throw new Error("Please enter a group name.");

  // The group document and the owner's private profile pointer are written in ONE batch.
  // The previous version wrapped both in a retry loop, so a failing profile write sent the
  // loop round again with a fresh code and left up to five orphan groups behind. A batch
  // is atomic: a failed attempt writes nothing at all, so retrying leaves no debris.
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const groupId = generateGroupCode();
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, "groups", groupId), {
        groupName: name.slice(0, 40),
        createdBy: uid,
        createdAt: serverTimestamp(),
        members: [uid],
        memberLocations: { [uid]: emptyLocation() },
        savedLocations: [],
      });
      batch.set(
        privateInfoRef(uid),
        { groupId, updatedAt: serverTimestamp() },
        { merge: true }
      );
      await batch.commit();

      await updateCachedGroupId(uid, groupId);
      clearLegacyPublicGroupId(uid);
      return groupId;
    } catch (err) {
      lastError = err;
      // A code collision is the only reason another code would help. Anything else -
      // offline, denied - fails identically five times over, so say so instead.
      if (err?.code !== "permission-denied" && err?.code !== "already-exists") {
        console.error("Could not create group:", err);
        throw new Error(
          err?.code === "unavailable" ?
            "You appear to be offline. Please try again when you have a connection." :
            "Could not create the group. Please try again."
        );
      }
    }
  }

  console.error("Could not create group after retries:", lastError);
  throw new Error("Could not create the group. Please try again.");
}

/**
 * Join an existing group by code.
 *
 * There is deliberately no read of the group before the write. A non-member cannot read a
 * group - that is the whole point of the new rules - so membership is established by an
 * update that the rules allow only when it adds the caller and touches nothing else.
 * A missing document comes back as `not-found`, a malformed attempt as `permission-denied`;
 * both mean "bad code" to the user.
 */
export async function joinGroup(uid, code) {
  if (!uid) throw new Error("Not signed in.");
  const groupId = normalizeGroupCode(code);
  if (!groupId) throw new Error("Please enter a group code.");

  // Membership and the profile pointer commit together, so there is no window in which
  // the user is a member of a group their own app does not know about, or the reverse.
  // A missing document fails the batch as not-found and a malformed attempt as
  // permission-denied; both mean "bad code" to the user, and neither writes anything.
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "groups", groupId), {
      members: arrayUnion(uid),
      [`memberLocations.${uid}`]: emptyLocation(),
    });
    batch.set(
      privateInfoRef(uid),
      { groupId, updatedAt: serverTimestamp() },
      { merge: true }
    );
    await batch.commit();
  } catch (err) {
    if (err?.code === "not-found" || err?.code === "permission-denied") {
      throw new Error("The group code you entered does not exist.");
    }
    throw err;
  }

  await updateCachedGroupId(uid, groupId);
  clearLegacyPublicGroupId(uid);
  return groupId;
}

export async function leaveGroup(uid, groupId) {
  if (!uid || !groupId) return;

  // Both halves or neither. Detaching the profile first and only warning if the group
  // write failed (as this used to) left the user still broadcasting to, and still being
  // alerted by, a group the app believed they had left.
  const batch = writeBatch(db);
  batch.update(doc(db, "groups", groupId), {
    members: arrayRemove(uid),
    [`memberLocations.${uid}`]: deleteField(),
  });
  batch.set(
    privateInfoRef(uid),
    { groupId: null, updatedAt: serverTimestamp() },
    { merge: true }
  );
  await batch.commit();

  await updateCachedGroupId(uid, null);
  clearLegacyPublicGroupId(uid);
}

export async function getGroup(groupId) {
  if (!groupId) return null;
  const snap = await getDoc(doc(db, "groups", groupId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getGroupName(groupId) {
  if (!groupId) return null;
  try {
    const group = await getGroup(groupId);
    return group?.groupName ?? null;
  } catch {
    return null;
  }
}

/**
 * Write one member's position. Only the caller's own key is ever touched, and `emergency`
 * is deliberately absent: an app restart used to clear an active emergency because the
 * startup location push wrote `emergency: false` alongside the coordinates.
 */
/** A Firestore rules rejection, whatever shape the SDK reports it in. */
function isPermissionDenied(err) {
  const code = err && (err.code || err.name);
  if (typeof code === 'string' && code.includes('permission-denied')) return true;
  const message = err && err.message ? String(err.message).toLowerCase() : '';
  return message.includes('permission') || message.includes('insufficient permissions');
}

export async function updateMemberLocation(uid, groupId, { latitude, longitude, speed = 0 }) {
  if (!uid || !groupId) return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

  const speedValue = Number.isFinite(speed) ? speed : 0;
  try {
    await updateDoc(doc(db, "groups", groupId), {
      [`memberLocations.${uid}.latitude`]: latitude,
      [`memberLocations.${uid}.longitude`]: longitude,
      [`memberLocations.${uid}.speed`]: speedValue,
      [`memberLocations.${uid}.updatedAt`]: new Date(),
    });
    return true;
  } catch (err) {
    // The rules check `hasOnly` on the RESULTING memberLocations.{uid} map, and a dotted-field
    // update can only add or overwrite keys - it can never remove one. So a single stray key
    // (an old client, a partial write) locks this member out of location sharing permanently,
    // because every future dotted update still produces a map with the extra key in it.
    // Rewriting the whole object with exactly the five allowed keys clears it in one write.
    if (isPermissionDenied(err)) {
      try {
        const snapshot = await getDoc(doc(db, "groups", groupId));
        const previous = snapshot.exists() ? snapshot.data()?.memberLocations?.[uid] : null;
        await updateDoc(doc(db, "groups", groupId), {
          [`memberLocations.${uid}`]: {
            latitude,
            longitude,
            speed: speedValue,
            updatedAt: new Date(),
            emergency: Boolean(previous?.emergency),
          },
        });
        return true;
      } catch (retryErr) {
        console.error("Error rewriting member location after a rejected update:", retryErr);
        return false;
      }
    }
    console.error("Error updating member location:", err);
    return false;
  }
}

/** Raise or clear this member's emergency flag, optionally pinning the position. */
export async function setEmergency(uid, groupId, active, coords = null) {
  if (!uid || !groupId) return false;

  const payload = { [`memberLocations.${uid}.emergency`]: Boolean(active) };
  if (coords && Number.isFinite(coords.latitude) && Number.isFinite(coords.longitude)) {
    payload[`memberLocations.${uid}.latitude`] = coords.latitude;
    payload[`memberLocations.${uid}.longitude`] = coords.longitude;
    payload[`memberLocations.${uid}.speed`] = Number.isFinite(coords.speed) ? coords.speed : 0;
    payload[`memberLocations.${uid}.updatedAt`] = new Date();
  }

  try {
    await updateDoc(doc(db, "groups", groupId), payload);
    return true;
  } catch (err) {
    console.error("Error updating emergency state:", err);
    return false;
  }
}

export async function addSavedLocation(groupId, location) {
  if (!groupId) return;
  await updateDoc(doc(db, "groups", groupId), { savedLocations: arrayUnion(location) });
}

export async function removeSavedLocation(groupId, location) {
  if (!groupId) return;
  await updateDoc(doc(db, "groups", groupId), { savedLocations: arrayRemove(location) });
}
