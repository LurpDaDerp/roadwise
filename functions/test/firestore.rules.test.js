"use strict";

/**
 * Security rules tests for firestore.rules.
 *
 * NOT EXECUTED in the environment these were written in: the Firestore emulator needs
 * Java 11+ and only Java 8 was available. Run them with:
 *
 *   cd functions
 *   npm install
 *   npm run test:rules
 *
 * (that wraps `firebase emulators:exec --only firestore ... jest`, so the emulator is
 * started and torn down for you; it needs Java 11+ on PATH.)
 */

const fs = require("fs");
const path = require("path");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");

const RULES_PATH = path.resolve(__dirname, "..", "..", "firestore.rules");

const ALICE = "alice";
const BOB = "bob";
const MALLORY = "mallory";
const GROUP = "FAMILY01";

let testEnv;

jest.setTimeout(30000);

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "roadcash-test",
    firestore: {
      rules: fs.readFileSync(RULES_PATH, "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc(`users/${ALICE}`).set({username: "alice", points: 100, groupId: GROUP});
    await db.doc(`users/${BOB}`).set({username: "bob", points: 50, groupId: GROUP});
    await db.doc(`users/${MALLORY}`).set({username: "mallory", points: 0, groupId: null});
    await db.doc(`users/${ALICE}/private/push`).set({token: "ExponentPushToken[x]"});
    await db.doc(`users/${ALICE}/private/contacts`).set({contacts: [{name: "Mum", phone: "1"}]});
    await db.doc(`groups/${GROUP}`).set({
      groupName: "Family",
      createdBy: ALICE,
      members: [ALICE, BOB],
      memberLocations: {
        [ALICE]: {latitude: 1, longitude: 2, speed: 0, emergency: false},
        [BOB]: {latitude: 3, longitude: 4, speed: 0, emergency: false},
      },
      savedLocations: [],
    });
    await db.doc("usernames/alice").set({uid: ALICE, username: "alice"});
    await db.doc("apikeys/here").set({key: "secret"});
    await db.doc("geocache/1_2").set({items: []});
  });
});

const as = (uid) => testEnv.authenticatedContext(uid).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();

describe("groups", () => {
  test("a member can read their group", async () => {
    await assertSucceeds(as(ALICE).doc(`groups/${GROUP}`).get());
  });

  test("a signed-in non-member cannot read a group", async () => {
    await assertFails(as(MALLORY).doc(`groups/${GROUP}`).get());
  });

  test("an anonymous user cannot read a group", async () => {
    await assertFails(anon().doc(`groups/${GROUP}`).get());
  });

  test("groups cannot be listed", async () => {
    await assertFails(as(ALICE).collection("groups").get());
  });

  test("a member can write their own location", async () => {
    await assertSucceeds(
      as(ALICE).doc(`groups/${GROUP}`).update({
        [`memberLocations.${ALICE}.latitude`]: 10,
        [`memberLocations.${ALICE}.longitude`]: 20,
      }),
    );
  });

  test("a member cannot write another member's location", async () => {
    await assertFails(
      as(ALICE).doc(`groups/${GROUP}`).update({
        [`memberLocations.${BOB}.latitude`]: 10,
      }),
    );
  });

  test("a member cannot rename the group", async () => {
    await assertFails(as(ALICE).doc(`groups/${GROUP}`).update({groupName: "Hijacked"}));
  });

  test("a member cannot delete the group", async () => {
    await assertFails(as(ALICE).doc(`groups/${GROUP}`).delete());
  });

  test("a stranger with the code may join by adding only themselves", async () => {
    await assertSucceeds(
      as(MALLORY).doc(`groups/${GROUP}`).update({
        members: ["alice", "bob", MALLORY],
        [`memberLocations.${MALLORY}`]: {
          latitude: null, longitude: null, speed: 0, emergency: false,
        },
      }),
    );
  });

  test("a stranger cannot join on someone else's behalf", async () => {
    await assertFails(
      as(MALLORY).doc(`groups/${GROUP}`).update({
        members: ["alice", "bob", "eve"],
      }),
    );
  });

  test("a stranger cannot remove existing members while joining", async () => {
    await assertFails(
      as(MALLORY).doc(`groups/${GROUP}`).update({members: [MALLORY]}),
    );
  });

  test("a member can leave", async () => {
    await assertSucceeds(
      as(BOB).doc(`groups/${GROUP}`).update({members: [ALICE]}),
    );
  });

  test("a member cannot remove another member", async () => {
    await assertFails(
      as(ALICE).doc(`groups/${GROUP}`).update({members: [ALICE]}),
    );
  });

  test("creating a group requires being its only member and its creator", async () => {
    await assertSucceeds(
      as(MALLORY).doc("groups/NEWGROUP").set({
        groupName: "Mine",
        createdBy: MALLORY,
        createdAt: new Date(),
        members: [MALLORY],
        memberLocations: {[MALLORY]: {latitude: null, longitude: null, speed: 0}},
        savedLocations: [],
      }),
    );
  });

  test("a group cannot be created on someone else's behalf", async () => {
    await assertFails(
      as(MALLORY).doc("groups/OTHER").set({
        groupName: "Theirs",
        createdBy: ALICE,
        createdAt: new Date(),
        members: [ALICE],
        memberLocations: {},
        savedLocations: [],
      }),
    );
  });
});

describe("users", () => {
  test("the leaderboard can read other users", async () => {
    await assertSucceeds(as(MALLORY).doc(`users/${ALICE}`).get());
    await assertSucceeds(as(MALLORY).collection("users").orderBy("points", "desc").limit(50).get());
  });

  test("private data is owner-only", async () => {
    await assertSucceeds(as(ALICE).doc(`users/${ALICE}/private/push`).get());
    await assertFails(as(MALLORY).doc(`users/${ALICE}/private/push`).get());
    await assertFails(as(MALLORY).doc(`users/${ALICE}/private/contacts`).get());
  });

  test("a user cannot write another user's profile", async () => {
    await assertFails(as(MALLORY).doc(`users/${ALICE}`).update({points: 0}));
  });

  test("a push token cannot be written back onto the public profile", async () => {
    await assertFails(as(ALICE).doc(`users/${ALICE}`).update({pushToken: "ExponentPushToken[y]"}));
  });

  test("trusted contacts cannot be written onto the public profile", async () => {
    await assertFails(
      as(ALICE).doc(`users/${ALICE}`).update({trustedContacts: [{name: "x", phone: "1"}]}),
    );
  });

  test("the legacy private fields may be deleted", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`users/${ALICE}`).update({pushToken: "old"});
    });
    const {deleteField} = require("firebase/firestore");
    await assertSucceeds(
      as(ALICE).doc(`users/${ALICE}`).update({pushToken: deleteField()}),
    );
  });

  test("points cannot go down", async () => {
    await assertFails(as(ALICE).doc(`users/${ALICE}`).update({points: 1}));
  });

  test("points cannot jump implausibly in one write", async () => {
    await assertFails(as(ALICE).doc(`users/${ALICE}`).update({points: 1000000}));
  });

  test("a normal drive award is allowed", async () => {
    await assertSucceeds(as(ALICE).doc(`users/${ALICE}`).update({points: 140}));
  });

  test("unknown fields are rejected", async () => {
    await assertFails(as(ALICE).doc(`users/${ALICE}`).update({isAdmin: true}));
  });

  test("a user document cannot be deleted", async () => {
    await assertFails(as(ALICE).doc(`users/${ALICE}`).delete());
  });
});

describe("drive metrics", () => {
  const {serverTimestamp} = require("firebase/firestore");

  test("a user can write their own drive with a server timestamp", async () => {
    await assertSucceeds(
      as(ALICE).collection(`users/${ALICE}/drivemetrics`).add({
        timestamp: serverTimestamp(),
        points: 12,
        duration: 600,
        distracted: 0,
        totalDistance: 5000,
      }),
    );
  });

  test("a client-chosen timestamp is rejected", async () => {
    await assertFails(
      as(ALICE).collection(`users/${ALICE}/drivemetrics`).add({
        timestamp: new Date(),
        points: 12,
        duration: 600,
      }),
    );
  });

  test("another user cannot read or write drive metrics", async () => {
    await assertFails(as(MALLORY).collection(`users/${ALICE}/drivemetrics`).get());
    await assertFails(
      as(MALLORY).collection(`users/${ALICE}/drivemetrics`).add({
        timestamp: serverTimestamp(),
        points: 1,
      }),
    );
  });
});

describe("usernames", () => {
  test("availability can be checked while signed out", async () => {
    await assertSucceeds(anon().doc("usernames/alice").get());
  });

  test("the registry cannot be listed", async () => {
    await assertFails(as(ALICE).collection("usernames").get());
  });

  test("a user can claim a free name", async () => {
    await assertSucceeds(
      as(MALLORY).doc("usernames/mallory").set({
        uid: MALLORY,
        username: "mallory",
        createdAt: new Date(),
      }),
    );
  });

  test("a claim must match the document id", async () => {
    await assertFails(
      as(MALLORY).doc("usernames/mallory").set({
        uid: MALLORY,
        username: "somebodyelse",
        createdAt: new Date(),
      }),
    );
  });

  test("a claim cannot be made for another uid", async () => {
    await assertFails(
      as(MALLORY).doc("usernames/newname").set({
        uid: ALICE,
        username: "newname",
        createdAt: new Date(),
      }),
    );
  });

  test("an existing claim cannot be stolen", async () => {
    await assertFails(
      as(MALLORY).doc("usernames/alice").set({
        uid: MALLORY,
        username: "alice",
        createdAt: new Date(),
      }),
    );
    await assertFails(as(MALLORY).doc("usernames/alice").delete());
  });

  test("an owner can release their own claim", async () => {
    await assertSucceeds(as(ALICE).doc("usernames/alice").delete());
  });
});

describe("server-only collections", () => {
  test("api keys are unreachable", async () => {
    await assertFails(as(ALICE).doc("apikeys/here").get());
    await assertFails(anon().doc("apikeys/here").get());
  });

  test("the shared geocode cache is unreachable", async () => {
    await assertFails(as(ALICE).doc("geocache/1_2").get());
    await assertFails(as(ALICE).doc("geocache/1_2").set({items: []}));
  });

  test("unknown collections are denied", async () => {
    await assertFails(as(ALICE).doc("userinfo/alice").get());
    await assertFails(as(ALICE).doc("anythingelse/doc").set({a: 1}));
  });
});
