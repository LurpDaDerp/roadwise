"use strict";

// RoadCash Cloud Functions.
//
// Three responsibilities, one file each under lib/:
//   * proxying the paid upstream APIs (OpenAI, HERE) so their keys never ship in the app
//   * pushing emergency alerts to the rest of a group
//   * keeping both of those from being used as an open, unmetered relay
//
// Every callable is authenticated, validates its input, and consumes a per-user daily
// allowance before it spends money upstream.

const {setGlobalOptions} = require("firebase-functions/v2/options");
const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const admin = require("firebase-admin");

const limits = require("./lib/limits");
const here = require("./lib/here");
const openai = require("./lib/openai");
const push = require("./lib/push");
const {
  requireAuth,
  requireObject,
  requireCoordinates,
  requireQueryString,
} = require("./lib/validate");

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const HERE_API_KEY = defineSecret("HERE_API_KEY");

admin.initializeApp();
setGlobalOptions({maxInstances: 10});

/* ------------------------------------------------------------------ *
 * Emergency notifications
 * ------------------------------------------------------------------ */

// Firestore triggers are at-least-once. This is a best-effort per-instance guard against
// a redelivered event producing a second alert; it is bounded so it cannot grow unchecked.
const PROCESSED_EVENT_TTL_MS = 10 * 60 * 1000;
const MAX_PROCESSED_EVENTS = 1000;
const processedEvents = new Map();

function alreadyProcessed(id) {
  const now = Date.now();
  for (const [key, ts] of processedEvents) {
    if (now - ts > PROCESSED_EVENT_TTL_MS) processedEvents.delete(key);
  }
  if (processedEvents.has(id)) return true;
  processedEvents.set(id, now);
  while (processedEvents.size > MAX_PROCESSED_EVENTS) {
    const oldest = processedEvents.keys().next();
    if (oldest.done) break;
    processedEvents.delete(oldest.value);
  }
  return false;
}

exports.notifyOnEmergency = onDocumentUpdated("groups/{groupId}", async (event) => {
  const before = event.data && event.data.before.data();
  const after = event.data && event.data.after.data();
  if (!before || !after) return;

  const beforeMembers = before.memberLocations || {};
  const afterMembers = after.memberLocations || {};

  // This trigger fires on every member location write. Work out whether anything we care
  // about changed before spending anything - most invocations end here.
  const transitions = [];
  for (const [uid, member] of Object.entries(afterMembers)) {
    const was = Boolean(beforeMembers[uid] && beforeMembers[uid].emergency);
    const is = Boolean(member && member.emergency);
    if (was !== is) transitions.push({uid, raised: is});
  }
  if (transitions.length === 0) return;

  if (alreadyProcessed(event.id)) return;

  const groupId = event.params.groupId;

  for (const {uid, raised} of transitions) {
    try {
      const userSnap = await admin.firestore().collection("users").doc(uid).get();
      const username = (userSnap.exists && userSnap.data().username) || "member";

      const recipients = await push.tokensForGroup(after, uid);
      if (recipients.length === 0) continue;

      if (raised) {
        console.log(`Emergency raised by ${uid} in group ${groupId}`);
        await push.sendExpoPush(
          recipients,
          "⚠️ Emergency Alert",
          `${username} signaled an emergency! Click here to view location.`,
          {emergencyUid: uid},
        );
      } else {
        console.log(`Emergency cleared by ${uid} in group ${groupId}`);
        await push.sendExpoPush(
          recipients,
          "Emergency Cleared",
          `${username} is no longer in an emergency.`,
          {emergencyUid: uid},
        );
      }
    } catch (err) {
      console.error("Failed to deliver emergency notification:", err);
    }
  }
});

/* ------------------------------------------------------------------ *
 * OpenAI proxy
 * ------------------------------------------------------------------ */

exports.callChatGPT = onCall(
  {secrets: [OPENAI_API_KEY], timeoutSeconds: 60, maxInstances: 5},
  async (request) => {
    const uid = requireAuth(request);

    const {mode, payload} = request.data || {};
    const apiKey = OPENAI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "OpenAI key not configured.");
    }

    if (mode === "feedback") {
      const serialized = requireObject(payload && payload.statsJSON, "statsJSON", {
        maxKeys: 40,
        maxBytes: 4000,
      });
      await limits.consume(uid, "feedback");
      return {result: await openai.driverFeedback(apiKey, serialized)};
    }

    if (mode === "roadCondition") {
      const serialized = requireObject(payload && payload.metrics, "metrics", {
        maxKeys: 20,
        maxBytes: 1500,
      });
      await limits.consume(uid, "roadCondition");
      return {result: await openai.roadCondition(apiKey, serialized)};
    }

    throw new HttpsError("invalid-argument", `Unknown mode: ${mode}`);
  },
);

/* ------------------------------------------------------------------ *
 * HERE proxy
 * ------------------------------------------------------------------ */

exports.hereAutocomplete = onCall(
  {secrets: [HERE_API_KEY], timeoutSeconds: 15},
  async (request) => {
    const uid = requireAuth(request);
    const q = requireQueryString(request.data || {});

    const apiKey = HERE_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "HERE key not configured.");
    }

    return {items: await here.autocomplete(uid, q, apiKey)};
  },
);

exports.hereRevGeocode = onCall(
  {secrets: [HERE_API_KEY], timeoutSeconds: 15},
  async (request) => {
    const uid = requireAuth(request);
    const {lat, lon} = requireCoordinates(request.data || {});

    const apiKey = HERE_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "HERE key not configured.");
    }

    const {items, source, street} = await here.reverseGeocode(uid, lat, lon, apiKey);
    // `street` lets the client reject an answer that belongs to a different road from the
    // one it is currently driving, which a shared grid cache can otherwise hand it.
    return {items, source, street: street || null};
  },
);
