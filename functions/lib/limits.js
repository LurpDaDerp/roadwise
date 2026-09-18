"use strict";

// Per-user, per-day call limits for the paid upstream APIs.
//
// Every callable was previously unmetered: one signed-in account could loop
// callChatGPT and spend the project's OpenAI budget, or exhaust the HERE quota for
// everybody. Counters live at users/{uid}/private/usage, which is owner-readable and
// written only by the Admin SDK.

const {HttpsError} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const DAILY_LIMITS = {
  feedback: 25,
  roadCondition: 200,
  hereRevGeocode: 500,
  hereAutocomplete: 200,
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Consume one unit of the caller's daily allowance for `kind`.
 * Throws a resource-exhausted HttpsError when the allowance is gone.
 */
async function consume(uid, kind) {
  const limit = DAILY_LIMITS[kind];
  if (!limit) return;

  const ref = admin.firestore().doc(`users/${uid}/private/usage`);
  const day = todayKey();

  try {
    await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : {};
      const counts = data.day === day ? data.counts || {} : {};
      const used = counts[kind] || 0;

      if (used >= limit) {
        const err = new Error("rate-limited");
        err.rateLimited = true;
        throw err;
      }

      tx.set(ref, {day, counts: {...counts, [kind]: used + 1}}, {merge: false});
    });
  } catch (err) {
    if (err && err.rateLimited) {
      throw new HttpsError(
        "resource-exhausted",
        `Daily limit reached for ${kind}. Try again tomorrow.`,
      );
    }
    // A counter failure must not take the feature down; log and let the call through.
    console.error("Rate limit bookkeeping failed:", err);
  }
}

module.exports = {consume, DAILY_LIMITS};
