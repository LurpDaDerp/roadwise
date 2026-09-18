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

/** Push tokens for every member of a group except `excludeUid`. */
async function tokensForGroup(groupId, excludeUid) {
  const db = admin.firestore();
  const userDocs = await db.collection("users").where("groupId", "==", groupId).get();

  const recipients = [];
  userDocs.forEach((doc) => {
    if (doc.id === excludeUid) return;
    recipients.push({uid: doc.id, legacyToken: doc.data().pushToken || null});
  });

  const resolved = await Promise.all(
    recipients.map(async ({uid, legacyToken}) => {
      try {
        const snap = await db.doc(`users/${uid}/private/push`).get();
        const token = snap.exists ? snap.data().token : null;
        return {uid, token: token || legacyToken};
      } catch (err) {
        console.error("Could not read push token for", uid, err);
        return {uid, token: legacyToken};
      }
    }),
  );

  return resolved.filter((entry) => Boolean(entry.token));
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

module.exports = {tokensForGroup, sendExpoPush};
