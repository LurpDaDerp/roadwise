"use strict";

/**
 * One-off data migration for the security and data-model changes.
 *
 * It is idempotent and defaults to a dry run. Run it BEFORE deploying the new rules and
 * the new client build, because:
 *
 *   * usernames/{lowercase} has to be populated or two accounts could claim the same name
 *   * pushToken and trustedContacts have to move off the publicly readable user document,
 *     otherwise existing users' tokens and their contacts' phone numbers stay exposed
 *     until each user happens to save that screen again
 *   * userinfo/{uid} (which no rule ever allowed the client to write) moves to
 *     users/{uid}/private/info
 *   * groups get an explicit members array; the rules also accept the memberLocations
 *     keys, so this is tidiness rather than a hard requirement
 *
 * Usage (from the functions/ directory):
 *
 *   # credentials: a service account key with Firestore access
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   export GOOGLE_CLOUD_PROJECT=roadcash-e05e1
 *
 *   node scripts/migrate.js            # dry run, prints what it would do
 *   node scripts/migrate.js --apply    # actually writes
 */

const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");

admin.initializeApp({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || undefined,
});

const db = admin.firestore();
const {FieldValue} = admin.firestore;

const stats = {
  usernameClaims: 0,
  usernameConflicts: 0,
  pushTokens: 0,
  trustedContacts: 0,
  userinfo: 0,
  groups: 0,
};

async function migrateUsers() {
  const snapshot = await db.collection("users").get();

  for (const doc of snapshot.docs) {
    const uid = doc.id;
    const data = doc.data();
    const profileUpdate = {};

    // 1. Username claim
    const username = typeof data.username === "string" ? data.username.trim() : "";
    if (username) {
      const key = username.toLowerCase();
      const claimRef = db.doc(`usernames/${key}`);
      const claim = await claimRef.get();

      if (!claim.exists) {
        stats.usernameClaims++;
        if (APPLY) {
          await claimRef.set({
            uid,
            username,
            createdAt: FieldValue.serverTimestamp(),
          });
        }
      } else if (claim.data().uid !== uid) {
        stats.usernameConflicts++;
        console.warn(
          `CONFLICT: username "${username}" is claimed by ${claim.data().uid}, ` +
            `also used by ${uid}. Resolve manually.`,
        );
      }

      if (data.usernameLower !== key) profileUpdate.usernameLower = key;
    }

    // 2. Push token -> users/{uid}/private/push
    if (data.pushToken) {
      stats.pushTokens++;
      if (APPLY) {
        await db.doc(`users/${uid}/private/push`).set(
          {token: data.pushToken, migratedAt: FieldValue.serverTimestamp()},
          {merge: true},
        );
      }
      profileUpdate.pushToken = FieldValue.delete();
    }

    // 3. Trusted contacts -> users/{uid}/private/contacts
    if (Array.isArray(data.trustedContacts) && data.trustedContacts.length >= 0) {
      stats.trustedContacts++;
      if (APPLY) {
        await db.doc(`users/${uid}/private/contacts`).set(
          {contacts: data.trustedContacts, migratedAt: FieldValue.serverTimestamp()},
          {merge: true},
        );
      }
      profileUpdate.trustedContacts = FieldValue.delete();
    }

    if (APPLY && Object.keys(profileUpdate).length > 0) {
      await doc.ref.update(profileUpdate);
    }
  }
}

async function migrateUserInfo() {
  const snapshot = await db.collection("userinfo").get();
  for (const doc of snapshot.docs) {
    stats.userinfo++;
    if (APPLY) {
      await db.doc(`users/${doc.id}/private/info`).set(
        {...doc.data(), migratedAt: FieldValue.serverTimestamp()},
        {merge: true},
      );
      await doc.ref.delete();
    }
  }
}

async function migrateGroups() {
  const snapshot = await db.collection("groups").get();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (Array.isArray(data.members) && data.members.length > 0) continue;

    const members = Object.keys(data.memberLocations || {});
    if (members.length === 0) continue;

    stats.groups++;
    if (APPLY) await doc.ref.update({members});
  }
}

async function main() {
  console.log(APPLY ? "APPLYING migration" : "DRY RUN (pass --apply to write)");
  await migrateUsers();
  await migrateUserInfo();
  await migrateGroups();
  console.log(JSON.stringify(stats, null, 2));
  if (stats.usernameConflicts > 0) {
    console.warn(
      `${stats.usernameConflicts} duplicate username(s) found. ` +
        "The later account keeps its profile name but holds no claim; ask those users to " +
        "pick a new one, or rename them before deploying.",
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
