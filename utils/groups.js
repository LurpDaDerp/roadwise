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
import { getGroupIdForUser, setGroupIdForUser } from "./firestore";
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

  // Only the CREATE is retried. The previous version wrapped the group create and the
  // profile write in one try, so a failing profile write sent the loop round again and
  // left behind up to five orphan groups the user was a member of and could not see.
  let createdGroupId = null;
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
      createdGroupId = groupId;
      break;
    } catch (err) {
      lastError = err;
      // A collision is the only reason to try another code. Anything else - denied,
      // offline - will fail identically five times over, so say so instead.
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

  if (!createdGroupId) {
    console.error("Could not create group after retries:", lastError);
    throw new Error("Could not create the group. Please try again.");
  }

  // Written once, after the group exists. If this fails the group is still there and the
  // user can retry by joining it with its own code, which the alert tells them.
  try {
    await setGroupIdForUser(uid, createdGroupId);
  } catch (err) {
    console.error("Group created but the profile could not be updated:", err);
    await updateCachedGroupId(uid, createdGroupId);
    throw new Error(
      `Your group was created (code ${createdGroupId}) but could not be linked to your ` +
        "profile. Join it with that code to finish."
    );
  }

  await updateCachedGroupId(uid, createdGroupId);
  return createdGroupId;
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

  // Ordering matters: membership on the group document is what the rules and the push
  // fan-out read, so it is written first. If the profile write then fails the user is
  // already a member and simply retrying the same code succeeds - the join write is
  // idempotent (arrayUnion of a uid already present is a no-op).
  await setGroupIdForUser(uid, groupId);
  await updateCachedGroupId(uid, groupId);
  return groupId;
}

export async function leaveGroup(uid, groupId) {
  if (!uid || !groupId) return;

  // The group document is the source of truth for membership: it is what the rules check
  // and what the emergency push fan-out reads. Detaching the profile first (as this used
  // to) and only warning if the group write failed left the user still receiving and
  // still broadcasting to a group the app believed they had left.
  await updateDoc(doc(db, "groups", groupId), {
    members: arrayRemove(uid),
    [`memberLocations.${uid}`]: deleteField(),
  });

  await setGroupIdForUser(uid, null);
  await updateCachedGroupId(uid, null);
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
