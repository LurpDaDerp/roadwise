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
  setDoc,
  updateDoc,
  arrayUnion,
  arrayRemove,
  deleteField,
  serverTimestamp,
} from "firebase/firestore";
import * as Crypto from "expo-crypto";

import { db } from "./firebase";
import { getUserSummary, invalidateUserCache } from "./firestore";
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
export function generateGroupCode() {
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

export function normalizeGroupCode(code) {
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

/** The caller's current group id, from the cached user document. */
export async function getCurrentGroupId(uid) {
  if (!uid) return null;
  const summary = await getUserSummary(uid);
  return summary?.groupId ?? null;
}

/**
 * Create a group and join it. Retries on the (vanishingly unlikely) case of a code
 * collision, which surfaces as a permission error because the rules only allow a create.
 */
export async function createGroup(uid, groupName) {
  if (!uid) throw new Error("Not signed in.");
  const name = String(groupName ?? "").trim();
  if (!name) throw new Error("Please enter a group name.");

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const groupId = generateGroupCode();
    try {
      await setDoc(doc(db, "groups", groupId), {
        groupName: name.slice(0, 40),
        createdBy: uid,
        createdAt: serverTimestamp(),
        members: [uid],
        memberLocations: { [uid]: emptyLocation() },
        savedLocations: [],
      });

      await setDoc(doc(db, "users", uid), { groupId }, { merge: true });
      invalidateUserCache(uid);
      await updateCachedGroupId(uid, groupId);
      return groupId;
    } catch (err) {
      lastError = err;
    }
  }
  console.error("Could not create group:", lastError);
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

  try {
    await updateDoc(doc(db, "groups", groupId), {
      members: arrayUnion(uid),
      [`memberLocations.${uid}`]: emptyLocation(),
    });
  } catch (err) {
    if (err?.code === "not-found" || err?.code === "permission-denied") {
      throw new Error("The group code you entered does not exist.");
    }
    throw err;
  }

  await setDoc(doc(db, "users", uid), { groupId }, { merge: true });
  invalidateUserCache(uid);
  await updateCachedGroupId(uid, groupId);
  return groupId;
}

export async function leaveGroup(uid, groupId) {
  if (!uid || !groupId) return;

  await setDoc(doc(db, "users", uid), { groupId: null }, { merge: true });
  invalidateUserCache(uid);
  await updateCachedGroupId(uid, null);

  try {
    await updateDoc(doc(db, "groups", groupId), {
      members: arrayRemove(uid),
      [`memberLocations.${uid}`]: deleteField(),
    });
  } catch (err) {
    // The profile is already detached, so the user is out of the group either way.
    console.warn("Could not remove member entry from group:", err);
  }
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
export async function updateMemberLocation(uid, groupId, { latitude, longitude, speed = 0 }) {
  if (!uid || !groupId) return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

  try {
    await updateDoc(doc(db, "groups", groupId), {
      [`memberLocations.${uid}.latitude`]: latitude,
      [`memberLocations.${uid}.longitude`]: longitude,
      [`memberLocations.${uid}.speed`]: Number.isFinite(speed) ? speed : 0,
      [`memberLocations.${uid}.updatedAt`]: new Date(),
    });
    return true;
  } catch (err) {
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
