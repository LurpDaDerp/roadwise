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
const {
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  where,
  writeBatch,
  serverTimestamp,
  increment,
  deleteField,
} = require("firebase/firestore");

const RULES_PATH = path.resolve(__dirname, "..", "..", "firestore.rules");

const ALICE = "alice";
const BOB = "bob";
const MALLORY = "mallory";
const GHOST = "ghost"; // in a legacy group, but never had a position written
const GROUP = "FAMILY01";
const LEGACY_GROUP = "OLDCODE1";

let testEnv;

jest.setTimeout(60000);

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

    await setDoc(doc(db, "users", ALICE), {username: "alice", points: 100});
    await setDoc(doc(db, "users", BOB), {username: "bob", points: 50});
    await setDoc(doc(db, "users", MALLORY), {username: "mallory", points: 0});
    await setDoc(doc(db, "users", GHOST), {username: "ghost", points: 0});

    await setDoc(doc(db, "users", ALICE, "private", "info"), {groupId: GROUP});
    await setDoc(doc(db, "users", ALICE, "private", "push"), {token: "ExponentPushToken[x]"});
    await setDoc(doc(db, "users", ALICE, "private", "contacts"), {
      contacts: [{name: "Mum", phone: "1"}],
    });

    await setDoc(doc(db, "groups", GROUP), {
      groupName: "Family",
      createdBy: ALICE,
      members: [ALICE, BOB],
      memberLocations: {
        [ALICE]: {latitude: 1, longitude: 2, speed: 0, emergency: false},
        [BOB]: {latitude: 3, longitude: 4, speed: 0, emergency: false},
      },
      savedLocations: [],
    });

    // A group from before `members` existed: membership is implied by memberLocations.
    await setDoc(doc(db, "groups", LEGACY_GROUP), {
      groupName: "Old Family",
      createdBy: ALICE,
      memberLocations: {
        [ALICE]: {latitude: 5, longitude: 6, speed: 0, emergency: false},
      },
      savedLocations: [{name: "Home", address: "1 Road", createdBy: ALICE}],
    });

    await setDoc(doc(db, "usernames", "alice"), {uid: ALICE, username: "alice"});
    await setDoc(doc(db, "apikeys", "here"), {key: "secret"});
    await setDoc(doc(db, "geocache", "1_2"), {items: []});
  });
});

const as = (uid) => testEnv.authenticatedContext(uid).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();

/* ------------------------------------------------------------------ *
 * The enumeration attack this data model exists to prevent
 * ------------------------------------------------------------------ */

describe("group code enumeration", () => {
  test("a group id is not readable from anybody's public profile", async () => {
    const snap = await getDoc(doc(as(MALLORY), "users", ALICE));
    expect(snap.data().groupId).toBeUndefined();
  });

  test("a listing of users exposes no group ids", async () => {
    const snap = await getDocs(
      query(collection(as(MALLORY), "users"), orderBy("points", "desc"), limit(50)),
    );
    snap.forEach((d) => expect(d.data().groupId).toBeUndefined());
  });

  test("nobody can read another user's private profile to find their group", async () => {
    await assertFails(getDoc(doc(as(MALLORY), "users", ALICE, "private", "info")));
  });

  test("groupId can no longer be written back onto a public profile", async () => {
    await assertFails(updateDoc(doc(as(ALICE), "users", ALICE), {groupId: GROUP}));
  });

  test("the legacy public groupId may still be deleted (the migration)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "users", ALICE), {groupId: GROUP});
    });
    await assertSucceeds(updateDoc(doc(as(ALICE), "users", ALICE), {groupId: deleteField()}));
  });
});

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

describe("groups", () => {
  test("a member can read their group", async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), "groups", GROUP)));
  });

  test("a signed-in non-member cannot read a group", async () => {
    await assertFails(getDoc(doc(as(MALLORY), "groups", GROUP)));
  });

  test("an anonymous user cannot read a group", async () => {
    await assertFails(getDoc(doc(anon(), "groups", GROUP)));
  });

  test("groups cannot be listed", async () => {
    await assertFails(getDocs(collection(as(ALICE), "groups")));
  });

  test("a member can write their own location", async () => {
    await assertSucceeds(
      updateDoc(doc(as(ALICE), "groups", GROUP), {
        [`memberLocations.${ALICE}.latitude`]: 10,
        [`memberLocations.${ALICE}.longitude`]: 20,
      }),
    );
  });

  test("a member cannot write another member's location", async () => {
    await assertFails(
      updateDoc(doc(as(ALICE), "groups", GROUP), {[`memberLocations.${BOB}.latitude`]: 10}),
    );
  });

  test("a member cannot rename or delete the group", async () => {
    await assertFails(updateDoc(doc(as(ALICE), "groups", GROUP), {groupName: "Hijacked"}));
    await assertFails(deleteDoc(doc(as(ALICE), "groups", GROUP)));
  });

  test("a stranger who knows the code may join by adding only themselves", async () => {
    await assertSucceeds(
      updateDoc(doc(as(MALLORY), "groups", GROUP), {
        members: [ALICE, BOB, MALLORY],
        [`memberLocations.${MALLORY}`]: {
          latitude: null, longitude: null, speed: 0, emergency: false,
        },
      }),
    );
  });

  test("a stranger cannot join on someone else's behalf", async () => {
    await assertFails(
      updateDoc(doc(as(MALLORY), "groups", GROUP), {members: [ALICE, BOB, "eve"]}),
    );
  });

  test("a stranger cannot remove existing members while joining", async () => {
    await assertFails(updateDoc(doc(as(MALLORY), "groups", GROUP), {members: [MALLORY]}));
  });

  test("a joiner cannot also change the shared places", async () => {
    await assertFails(
      updateDoc(doc(as(MALLORY), "groups", GROUP), {
        members: [ALICE, BOB, MALLORY],
        savedLocations: [{name: "x", address: "y", createdBy: MALLORY}],
      }),
    );
  });

  test("a member can leave", async () => {
    await assertSucceeds(updateDoc(doc(as(BOB), "groups", GROUP), {members: [ALICE]}));
  });

  // These used to be a second assertion inside the test above, which ran AFTER Bob had
  // already left - so it wrote members: [ALICE] over a value that was already [ALICE].
  // That is a no-op, which no rule can distinguish from not writing the field at all, so
  // it was allowed and the test failed without ever exercising the real case.
  test("a member cannot remove another member", async () => {
    await assertFails(updateDoc(doc(as(ALICE), "groups", GROUP), {members: [ALICE]}));
  });

  test("a member cannot empty the members array on their way out", async () => {
    await assertFails(updateDoc(doc(as(ALICE), "groups", GROUP), {members: []}));
  });

  test("a member cannot replace the membership with just themselves", async () => {
    await assertFails(updateDoc(doc(as(BOB), "groups", GROUP), {members: [BOB]}));
  });

  test("leaving removes exactly the caller and nobody else", async () => {
    await assertSucceeds(updateDoc(doc(as(ALICE), "groups", GROUP), {members: [BOB]}));

    // withSecurityRulesDisabled resolves to undefined, so capture the value outside it.
    let after = null;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(doc(ctx.firestore(), "groups", GROUP));
      after = snap.data().members;
    });
    expect(after).toEqual([BOB]);
  });

  test("creating a group requires being its only member and its creator", async () => {
    await assertSucceeds(
      setDoc(doc(as(MALLORY), "groups", "NEWGROUP"), {
        groupName: "Mine",
        createdBy: MALLORY,
        createdAt: serverTimestamp(),
        members: [MALLORY],
        memberLocations: {[MALLORY]: {latitude: null, longitude: null, speed: 0}},
        savedLocations: [],
      }),
    );
  });

  test("a group cannot be created on someone else's behalf", async () => {
    await assertFails(
      setDoc(doc(as(MALLORY), "groups", "OTHER"), {
        groupName: "Theirs",
        createdBy: ALICE,
        createdAt: serverTimestamp(),
        members: [ALICE],
        memberLocations: {},
        savedLocations: [],
      }),
    );
  });

  test("a group cannot be created with a client-chosen creation time", async () => {
    await assertFails(
      setDoc(doc(as(MALLORY), "groups", "BADTIME"), {
        groupName: "Mine",
        createdBy: MALLORY,
        createdAt: new Date(),
        members: [MALLORY],
        memberLocations: {[MALLORY]: {latitude: null, longitude: null, speed: 0}},
        savedLocations: [],
      }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Legacy groups (no members array)
 * ------------------------------------------------------------------ */

describe("legacy groups without a members array", () => {
  test("an implied member can still read it", async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), "groups", LEGACY_GROUP)));
  });

  test("a non-member still cannot", async () => {
    await assertFails(getDoc(doc(as(MALLORY), "groups", LEGACY_GROUP)));
    await assertFails(getDoc(doc(as(GHOST), "groups", LEGACY_GROUP)));
  });

  test("an implied member can write their location", async () => {
    await assertSucceeds(
      updateDoc(doc(as(ALICE), "groups", LEGACY_GROUP), {
        [`memberLocations.${ALICE}.latitude`]: 7,
      }),
    );
  });

  test("an implied member can edit the shared places", async () => {
    await assertSucceeds(
      updateDoc(doc(as(ALICE), "groups", LEGACY_GROUP), {savedLocations: []}),
    );
  });

  test("somebody with the code can join, creating the members array", async () => {
    await assertSucceeds(
      updateDoc(doc(as(MALLORY), "groups", LEGACY_GROUP), {
        members: [MALLORY],
        [`memberLocations.${MALLORY}`]: {
          latitude: null, longitude: null, speed: 0, emergency: false,
        },
      }),
    );
  });

  test("an implied member can leave", async () => {
    await assertSucceeds(
      updateDoc(doc(as(ALICE), "groups", LEGACY_GROUP), {
        members: [],
        [`memberLocations.${ALICE}`]: deleteField(),
      }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Emergencies
 * ------------------------------------------------------------------ */

describe("emergency flag", () => {
  test("a member can raise and clear their own emergency", async () => {
    await assertSucceeds(
      updateDoc(doc(as(ALICE), "groups", GROUP), {
        [`memberLocations.${ALICE}.emergency`]: true,
        [`memberLocations.${ALICE}.latitude`]: 12,
        [`memberLocations.${ALICE}.longitude`]: 34,
      }),
    );
    await assertSucceeds(
      updateDoc(doc(as(ALICE), "groups", GROUP), {
        [`memberLocations.${ALICE}.emergency`]: false,
      }),
    );
  });

  test("a member cannot clear somebody else's emergency", async () => {
    // Bob's flag is seeded false, so writing false was a no-op that changed nothing and
    // was therefore allowed - the assertion never reached the rule it meant to test.
    // Raise it first so that clearing it is a real change.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "groups", GROUP), {
        [`memberLocations.${BOB}.emergency`]: true,
      });
    });

    await assertFails(
      updateDoc(doc(as(ALICE), "groups", GROUP), {
        [`memberLocations.${BOB}.emergency`]: false,
      }),
    );
  });

  test("a member cannot raise somebody else's emergency", async () => {
    await assertFails(
      updateDoc(doc(as(ALICE), "groups", GROUP), {
        [`memberLocations.${BOB}.emergency`]: true,
      }),
    );
  });

  test("a member cannot overwrite another member's whole location entry", async () => {
    await assertFails(
      updateDoc(doc(as(ALICE), "groups", GROUP), {
        [`memberLocations.${BOB}`]: {
          latitude: 0, longitude: 0, speed: 0, emergency: false,
        },
      }),
    );
  });

  // Recorded deliberately: rules cannot see a write that changes nothing, so this is
  // allowed. It reveals nothing and alters nothing, and forbidding it would mean
  // requiring every update to change something - which would break idempotent retries.
  test("writing another member's field to its existing value is a permitted no-op", async () => {
    await assertSucceeds(
      updateDoc(doc(as(ALICE), "groups", GROUP), {
        [`memberLocations.${BOB}.emergency`]: false,
      }),
    );
  });

  test("a non-member cannot raise an emergency in a group", async () => {
    await assertFails(
      updateDoc(doc(as(MALLORY), "groups", GROUP), {
        [`memberLocations.${MALLORY}.emergency`]: true,
      }),
    );
  });

  test("emergency must be a boolean and coordinates must be in range", async () => {
    await assertFails(
      updateDoc(doc(as(ALICE), "groups", GROUP), {
        [`memberLocations.${ALICE}.emergency`]: "yes",
      }),
    );
    await assertFails(
      updateDoc(doc(as(ALICE), "groups", GROUP), {
        [`memberLocations.${ALICE}.latitude`]: 999,
      }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

describe("users", () => {
  test("the leaderboard can read other users", async () => {
    await assertSucceeds(getDoc(doc(as(MALLORY), "users", ALICE)));
    await assertSucceeds(
      getDocs(query(collection(as(MALLORY), "users"), orderBy("points", "desc"), limit(50))),
    );
  });

  test("the rank count query is allowed", async () => {
    await assertSucceeds(
      getDocs(query(collection(as(MALLORY), "users"), where("points", ">", 10))),
    );
  });

  test("private data is owner-only", async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), "users", ALICE, "private", "push")));
    await assertFails(getDoc(doc(as(MALLORY), "users", ALICE, "private", "push")));
    await assertFails(getDoc(doc(as(MALLORY), "users", ALICE, "private", "contacts")));
    await assertFails(getDoc(doc(as(MALLORY), "users", ALICE, "private", "info")));
  });

  test("a user cannot write another user's profile", async () => {
    await assertFails(updateDoc(doc(as(MALLORY), "users", ALICE), {points: 0}));
  });

  test("a push token cannot be written back onto the public profile", async () => {
    await assertFails(
      updateDoc(doc(as(ALICE), "users", ALICE), {pushToken: "ExponentPushToken[y]"}),
    );
  });

  test("trusted contacts cannot be written onto the public profile", async () => {
    await assertFails(
      updateDoc(doc(as(ALICE), "users", ALICE), {trustedContacts: [{name: "x", phone: "1"}]}),
    );
  });

  test("the legacy private fields may be deleted", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "users", ALICE), {pushToken: "old"});
    });
    await assertSucceeds(updateDoc(doc(as(ALICE), "users", ALICE), {pushToken: deleteField()}));
  });

  test("an account carrying a legacy field can still make ordinary writes", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "users", ALICE), {
        pushToken: "old",
        trustedContacts: [{name: "x", phone: "1"}],
        groupId: GROUP,
      });
    });
    // The whole resulting document still contains all three; only the touched key matters.
    await assertSucceeds(updateDoc(doc(as(ALICE), "users", ALICE), {points: 150}));
  });

  test("points cannot go down", async () => {
    await assertFails(updateDoc(doc(as(ALICE), "users", ALICE), {points: 1}));
  });

  test("points cannot jump implausibly in one write", async () => {
    await assertFails(updateDoc(doc(as(ALICE), "users", ALICE), {points: 1000000}));
  });

  test("a long drive's points are accepted", async () => {
    // ~14 hours of driving at one point per 2.5 s. The old 2000 cap rejected anything
    // past ~83 minutes and took the whole finalization batch down with it.
    await assertSucceeds(
      updateDoc(doc(as(ALICE), "users", ALICE), {points: increment(19000)}),
    );
  });

  test("unknown fields are rejected", async () => {
    await assertFails(updateDoc(doc(as(ALICE), "users", ALICE), {isAdmin: true}));
  });

  test("a user document cannot be deleted", async () => {
    await assertFails(deleteDoc(doc(as(ALICE), "users", ALICE)));
  });
});

/* ------------------------------------------------------------------ *
 * Sign-up and rename
 * ------------------------------------------------------------------ */

describe("sign-up and rename", () => {
  const NEWBIE = "newbie";

  test("a new account can claim a name and create its profile", async () => {
    const db = as(NEWBIE);
    await assertSucceeds(
      setDoc(doc(db, "usernames", "newbie"), {
        uid: NEWBIE,
        username: "newbie",
        createdAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(
      setDoc(
        doc(db, "users", NEWBIE),
        {username: "newbie", usernameLower: "newbie"},
        {merge: true},
      ),
    );
    await assertSucceeds(
      setDoc(
        doc(db, "users", NEWBIE),
        {
          points: 0,
          drivingStreak: 0,
          totalDrives: 0,
          photoURL: null,
          isDriving: false,
          createdAt: serverTimestamp(),
        },
        {merge: true},
      ),
    );
    await assertSucceeds(
      setDoc(doc(db, "users", NEWBIE, "private", "info"), {email: "a@b.c"}),
    );
  });

  test("a rename updates the claim and the profile", async () => {
    const db = as(ALICE);
    await assertSucceeds(
      setDoc(doc(db, "usernames", "alice2"), {
        uid: ALICE,
        username: "alice2",
        createdAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(
      setDoc(
        doc(db, "users", ALICE),
        {username: "alice2", usernameLower: "alice2"},
        {merge: true},
      ),
    );
    await assertSucceeds(deleteDoc(doc(db, "usernames", "alice")));
  });

  test("a username over the length limit is refused", async () => {
    await assertFails(
      setDoc(doc(as(MALLORY), "usernames", "a".repeat(17)), {
        uid: MALLORY,
        username: "a".repeat(17),
        createdAt: serverTimestamp(),
      }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Drive finalization
 * ------------------------------------------------------------------ */

describe("drive finalization", () => {
  test("the drive record and the profile increments commit as one batch", async () => {
    const db = as(ALICE);
    const batch = writeBatch(db);

    batch.set(doc(collection(db, "users", ALICE, "drivemetrics")), {
      timestamp: serverTimestamp(),
      points: 42,
      duration: 900,
      distracted: 0,
      avgSpeed: 30,
      avgSpeedingMargin: 0,
      suddenStops: 1,
      suddenAccelerations: 0,
      phoneUsageTime: 0,
      totalDistance: 12000,
      speedingEvents: 0,
    });
    batch.set(
      doc(db, "users", ALICE),
      {
        points: increment(42),
        drivingStreak: increment(1),
        totalDrives: increment(1),
        lastDriveAt: serverTimestamp(),
        isDriving: false,
      },
      {merge: true},
    );

    await assertSucceeds(batch.commit());
  });

  test("a distracted drive resets the streak in the same batch", async () => {
    const db = as(ALICE);
    const batch = writeBatch(db);
    batch.set(doc(collection(db, "users", ALICE, "drivemetrics")), {
      timestamp: serverTimestamp(),
      points: 5,
      duration: 120,
      distracted: 3,
    });
    batch.set(
      doc(db, "users", ALICE),
      {points: increment(5), drivingStreak: 0, totalDrives: increment(1), isDriving: false},
      {merge: true},
    );
    await assertSucceeds(batch.commit());
  });

  test("a batch whose profile half is invalid fails ENTIRELY", async () => {
    const db = as(ALICE);
    const batch = writeBatch(db);
    batch.set(doc(collection(db, "users", ALICE, "drivemetrics")), {
      timestamp: serverTimestamp(),
      points: 10,
      duration: 60,
    });
    batch.set(doc(db, "users", ALICE), {points: 9999999}, {merge: true});
    await assertFails(batch.commit());
  });

  test("a user can write their own drive with a server timestamp", async () => {
    await assertSucceeds(
      addDoc(collection(as(ALICE), "users", ALICE, "drivemetrics"), {
        timestamp: serverTimestamp(),
        points: 12,
        duration: 600,
        distracted: 0,
        totalDistance: 5000,
      }),
    );
  });

  test("a legacy boolean `distracted` is still accepted", async () => {
    await assertSucceeds(
      addDoc(collection(as(ALICE), "users", ALICE, "drivemetrics"), {
        timestamp: serverTimestamp(),
        points: 3,
        distracted: true,
      }),
    );
  });

  test("a client-chosen timestamp is rejected", async () => {
    await assertFails(
      addDoc(collection(as(ALICE), "users", ALICE, "drivemetrics"), {
        timestamp: new Date(),
        points: 12,
        duration: 600,
      }),
    );
  });

  test("another user cannot read or write drive metrics", async () => {
    await assertFails(getDocs(collection(as(MALLORY), "users", ALICE, "drivemetrics")));
    await assertFails(
      addDoc(collection(as(MALLORY), "users", ALICE, "drivemetrics"), {
        timestamp: serverTimestamp(),
        points: 1,
      }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Usernames registry
 * ------------------------------------------------------------------ */

describe("usernames", () => {
  test("availability can be checked while signed out", async () => {
    await assertSucceeds(getDoc(doc(anon(), "usernames", "alice")));
  });

  test("the registry cannot be listed", async () => {
    await assertFails(getDocs(collection(as(ALICE), "usernames")));
  });

  test("a claim must match the document id and the caller", async () => {
    await assertFails(
      setDoc(doc(as(MALLORY), "usernames", "mallory"), {
        uid: MALLORY,
        username: "somebodyelse",
        createdAt: serverTimestamp(),
      }),
    );
    await assertFails(
      setDoc(doc(as(MALLORY), "usernames", "newname"), {
        uid: ALICE,
        username: "newname",
        createdAt: serverTimestamp(),
      }),
    );
  });

  test("an existing claim cannot be stolen or deleted by others", async () => {
    await assertFails(
      setDoc(doc(as(MALLORY), "usernames", "alice"), {
        uid: MALLORY,
        username: "alice",
        createdAt: serverTimestamp(),
      }),
    );
    await assertFails(deleteDoc(doc(as(MALLORY), "usernames", "alice")));
  });

  test("an owner can release their own claim", async () => {
    await assertSucceeds(deleteDoc(doc(as(ALICE), "usernames", "alice")));
  });
});

/* ------------------------------------------------------------------ *
 * Server-only collections
 * ------------------------------------------------------------------ */

describe("server-only collections", () => {
  test("api keys are unreachable", async () => {
    await assertFails(getDoc(doc(as(ALICE), "apikeys", "here")));
    await assertFails(getDoc(doc(anon(), "apikeys", "here")));
  });

  test("the shared geocode cache is unreachable", async () => {
    await assertFails(getDoc(doc(as(ALICE), "geocache", "1_2")));
    await assertFails(setDoc(doc(as(ALICE), "geocache", "1_2"), {items: []}));
  });

  test("unknown collections are denied", async () => {
    await assertFails(getDoc(doc(as(ALICE), "userinfo", "alice")));
    await assertFails(setDoc(doc(as(ALICE), "anythingelse", "doc"), {a: 1}));
  });
});
