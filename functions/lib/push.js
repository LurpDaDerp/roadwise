"use strict";

// Expo push delivery.
//
// Changes from the previous inline version:
// * Tokens are read from users/{uid}/private/push (the token used to sit on the public
//   user document, where any signed-in account could read it and push to that device).
//   The legacy field is still read so devices that have not updated keep working.
// * Expo accepts at most 100 messages per request; a large group used to be sent as one
//   oversized request that Expo would reject wholesale.
// * Push receipts are inspected, and a token Expo reports as unregistered is deleted, so
//   dead tokens are not retried forever.

const admin = require("firebase-admin");

const {fetchJson} = require("./http");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_MESSAGES_PER_REQUEST = 100;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * The members of a group, taken from the group document itself.
 *
 * This used to be `users where groupId == <id>`, which required groupId to sit on the
 * publicly readable profile - and that field is the group's join code, so anyone could
 * list users, read a code and add themselves to that family. groupId is private now, so
 * membership is read from the group document, which is where the security rules read it
 * from too: one source of truth instead of two that can disagree.
 */
function memberUidsFromGroup(groupData, excludeUid) {
  const fromArray = Array.isArray(groupData && groupData.members) ? groupData.members : [];
  // Groups created before `members` existed are still described by their location map.
  const fromLocations = Object.keys((groupData && groupData.memberLocations) || {});

  const unique = new Set([...fromArray, ...fromLocations]);
  unique.delete(excludeUid);
  return Array.from(unique).filter((uid) => typeof uid === "string" && uid);
}

/** Push tokens for the given uids. */
async function tokensForUids(uids) {
  const db = admin.firestore();

  const resolved = await Promise.all(
    uids.map(async (uid) => {
      try {
        const [privateSnap, userSnap] = await Promise.all([
          db.doc(`users/${uid}/private/push`).get(),
          db.doc(`users/${uid}`).get(),
        ]);
        const token = privateSnap.exists ? privateSnap.data().token : null;
        // Devices that have not updated yet still write the legacy public field.
        const legacyToken = userSnap.exists ? userSnap.data().pushToken || null : null;
        return {uid, token: token || legacyToken};
      } catch (err) {
        console.error("Could not read push token for", uid, err);
        return {uid, token: null};
      }
    }),
  );

  return resolved.filter((entry) => Boolean(entry.token));
}

/** Push tokens for every member of a group except `excludeUid`. */
async function tokensForGroup(groupData, excludeUid) {
  return tokensForUids(memberUidsFromGroup(groupData, excludeUid));
}

async function clearToken(uid) {
  try {
    await admin.firestore().doc(`users/${uid}/private/push`).delete();
    await admin.firestore().doc(`users/${uid}`).update({
      pushToken: admin.firestore.FieldValue.delete(),
    });
  } catch (err) {
    // Missing document is the normal case here; nothing to clean up.
  }
}

async function sendExpoPush(recipients, title, body, extraData = {}) {
  if (!recipients.length) return;

  for (const batch of chunk(recipients, MAX_MESSAGES_PER_REQUEST)) {
    const messages = batch.map((r) => ({
      to: r.token,
      sound: "default",
      title,
      body,
      data: extraData,
    }));

    try {
      const res = await fetchJson(EXPO_PUSH_URL, {
        method: "POST",
        timeoutMs: 15000,
        headers: {
          "Accept": "application/json",
          "Accept-encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(messages),
      });

      if (!res.ok) {
        console.error("Expo push failed:", res.status, (res.text || "").slice(0, 300));
        continue;
      }

      const tickets = (res.body && res.body.data) || [];
      await Promise.all(
        tickets.map(async (ticket, index) => {
          if (!ticket || ticket.status !== "error") return;
          const code = ticket.details && ticket.details.error;
          console.warn("Expo push ticket error:", code, ticket.message);
          if (code === "DeviceNotRegistered") {
            await clearToken(batch[index].uid);
          }
        }),
      );
    } catch (err) {
      console.error("Expo push error:", err);
    }
  }
}

module.exports = {
  tokensForGroup,
  tokensForUids,
  memberUidsFromGroup,
  sendExpoPush,
};
