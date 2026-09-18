# RoadCash backend audit

Branch: `backend-optimization`. Nothing in here has been deployed — every deploy step is
written out below for you to run.

The four "Urgent" items in `TODO.md` are all addressed: Google sign-in (F1), speed-limit /
geocoding call volume (P2, P3), location update volume (P1), Firestore organization and
security (S1–S6), and the Firebase project details now come from an env file (S7).

---

## 1. Findings, ranked

Severity: **S#** security, **F#** functional bug, **P#** performance/cost. Each says what
was wrong, where, and what was done.

### S1 — Any signed-in account could read and overwrite every family's live location
`firestore.rules` (old): `match /groups/{groupId} { allow read, write: if isSignedIn(); }`

Creating an account takes ten seconds. With one, you could read every group document in the
project — live coordinates, speed and emergency flags for every member of every family —
and you could also write to them: plant a fake position, clear somebody's emergency flag,
or wipe `savedLocations`. This is the most serious finding in the codebase.

**Fixed.** Groups are readable only by their members. Membership is the `members` array,
with a fallback to the keys of `memberLocations` so groups created before that field
existed are not locked out. Updates are constrained by field: a member may write only their
own `memberLocations.<uid>` entry and the shared `savedLocations`; `groupName`, `createdBy`
and `createdAt` are immutable after creation; nobody can delete a group or remove another
member. Joining is the single write a non-member may make, and only if it adds exactly
themselves and touches nothing else.

### S2 — Every user's push token, trusted contacts and profile were world-readable
`firestore.rules` (old): `match /users/{userId} { allow read: if isSignedIn(); }`

The user document held `pushToken` and `trustedContacts`. An Expo push token is a bearer
credential: anyone holding it can POST to Expo's public endpoint and send that device a
notification. `trustedContacts` is worse — it is names and phone numbers of people who are
not users of the app and never agreed to anything.

**Fixed.** Those two fields moved to `users/{uid}/private/push` and
`users/{uid}/private/contacts`, which only the owner can read. The rules also refuse to let
them be written back onto the public document (they may only be *deleted* from it, which is
how the migration works). The user document stays readable because the leaderboard ranks
every user and the group map shows other members' names and photos — but it now contains
nothing except that public profile.

`functions/scripts/migrate.js` moves existing values; run it **before** deploying, or
existing users' tokens and contacts sit exposed until each user happens to re-save.

### S3 — No write validation anywhere
Old rules allowed any shape of document on a user's own profile. A user could set
`points: 1e9` (leaderboard and rewards fraud), invent fields, or write a drive record dated
whenever they liked.

**Fixed.** Writes are type-checked, the key set is closed, points may only increase and only
by ≤ 2000 in one write, and a drive record must carry a server timestamp.

> Honest limit: a rules-only points cap is a speed bump, not an anti-cheat system — a
> determined client can still loop small increments. Making points authoritative means
> moving the award into a Cloud Function that recomputes them from the drive record. That
> is the natural next step and is not done here.

### S4 — Cloud Functions were an unmetered, unvalidated relay
`functions/index.js` (old): `callChatGPT`, `hereAutocomplete` and `hereRevGeocode` checked
auth and nothing else. One account in a loop could spend the entire OpenAI budget or
exhaust the HERE quota for every user. `statsJSON` went into the prompt with no size limit,
so the token bill was client-controlled. Outbound calls had no timeout, so a hung upstream
pinned a function instance for the full 60 s.

**Fixed.** Per-user daily allowances at `users/{uid}/private/usage` (feedback 25,
roadCondition 200, revGeocode 500, autocomplete 200), input validation including a
serialized-size cap on anything that reaches a prompt, and a timeout on every outbound call.

### S5 — `require("node-fetch")` was an undeclared dependency
It was never in `functions/package.json`; it only resolved because a transitive dependency
happened to install `node-fetch@2`. A clean install or a dependency bump would have broken
deployment at runtime, not at deploy time.

**Fixed.** Removed — Node 24 has a global `fetch`.

### S6 — eslint had never run on the functions
`.eslintrc.js` pinned `ecmaVersion: 2018`, which cannot parse optional chaining. `index.js`
used `?.` on line 71, so the parse failed and the file was skipped entirely; the remaining
errors were all CRLF-vs-LF noise from `core.autocrlf=true`. Effectively zero lint coverage.

**Fixed.** Parser at ES2022, `linebreak-style` off, lint is clean, and `firebase.json` runs
it as a predeploy step.

### S7 — Project identifiers hard-coded in source
Firebase web config in `utils/firebase.js`, Supabase URL and anon key in `utils/supabase.js`,
Google OAuth client id in `screens/LoginScreen.js`.

None of these are secrets — they all ship inside the app binary and are readable by anyone
who downloads it. They are protected by Firestore rules and Supabase RLS, not by being
hidden. They are in the environment now because you asked for it and because it lets the
project be re-pointed (staging vs production) without editing source.

**Fixed.** `app.config.js` + `utils/config.js` + `.env` / `.env.example`. See §4.

### S8 — Supabase Storage has no documented policy
`screens/AccountSettings.js` uploads to the `profile-pictures` bucket with the anon key,
under a path of `<uid>/profilePic.jpg`, and calls `.remove()` first. Supabase has no idea
who the Firebase user is, so if that bucket is public-write, **any** anon-key holder can
overwrite or delete **any** user's profile photo. Nothing in code can fix this; it is a
dashboard setting. See §5 for the exact policies to apply.

### F1 — Google sign-in could not work
`screens/LoginScreen.js` passed a single **web** OAuth client id to
`Google.useIdTokenAuthRequest`. A native build redirects to its own URL scheme (the reversed
iOS client id, or package + signing certificate on Android), and Google rejects a redirect
URI that does not belong to the client id the request was made with. There was also no
`WebBrowser.maybeCompleteAuthSession()`, no iOS URL scheme registered for the Google client
(`app.json` registered only `roadcash`), no `android.package` at all, and only
`response.type === 'success'` was handled — so a rejection or a dismissal looked to the user
like the button did nothing.

**Fixed in code**: per-platform client ids from env, `maybeCompleteAuthSession()`, the
reversed-client-id URL scheme derived from the iOS client id in `app.config.js`,
`android.package`, explicit error alerts, and `ensureUserProfile()` so a brand-new Google
account gets a profile document and a username. **You must still create two OAuth client
ids in the Google Cloud console** — §6.

### F2 — Sign-up was broken end to end
`screens/SignUpScreen.js` did two things that could not succeed:
1. Checked username uniqueness with `getDocs(query(users, where('username','==',…)))` while
   **signed out**. The rules require auth for that read, so it threw `permission-denied`.
2. Wrote `userinfo/{uid}`, a collection no rule ever matched, so it hit the catch-all deny.

Both threw *after* `createUserWithEmailAndPassword` had already created the auth account, so
the user got "Sign Up Failed" while holding a half-provisioned account with no profile
document. The check was also a read-then-write race: two people submitting the same name at
the same moment both passed.

**Fixed.** A `usernames/{lowercase}` claim registry whose existence is publicly readable (so
the pre-flight check works while signed out) and whose claims are made in a transaction, so
exactly one of two simultaneous signups wins. The loser's orphaned auth account is deleted.
Email moved to `users/{uid}/private/info`.

### F3 — Signing out wiped the user's points
`screens/AccountSettings.js` read `AsyncStorage.getItem('totalPoints')` and wrote the result
to Firestore. The dashboard stores points under `totalPoints_${uid}`, so that read returned
`null`, `parseFloat(null)` gave `NaN`, `NaN ? … : 0` gave 0, and **every sign-out wrote 0
points to the account**.

**Fixed.** The write is gone — points are persisted when a drive ends. The rules now also
refuse any write that decreases `points`, so this class of bug cannot silently recur.

### F4 — Rewards balance always showed 0
`screens/RewardsScreen.js` read the same wrong `'totalPoints'` key. **Fixed** via
`getCachedTotalPoints(uid)`.

### F5 — Points could be lost entirely
`DriveScreen.finalizeDrive` wrote the earned points to `AsyncStorage['@pointsThisDrive']`
and relied on the dashboard, on some later focus, to add them to a locally cached total and
push the sum to Firestore. Kill the app before opening the dashboard and the points were
gone. The dashboard's write was also an absolute value derived from a local cache, so a
stale cache could overwrite a newer server value.

**Fixed.** `finalizeDriveWrite()` commits the drive record and the user's
points / streak / drive count in one atomic batch with server-side `increment()`.

### F6 — Streak was a read-modify-write race
Same function: read `drivingStreak`, add one, write it back. Two finalizations (backgrounded
drive plus the Complete button) could interleave and lose an increment.

**Fixed.** `drivingStreak: wasDistracted ? 0 : increment(1)` — no read at all.

### F7 — Creating a group discarded the group name
`LocationScreen.handleConfirmCreateGroup` generated an id, wrote it onto the user document,
and returned. It never created `groups/{id}`. The document only came into existence later,
nameless, when the background location task merged a position into it — which is why
AccountSettings showed "Unknown" for the current group.

**Fixed.** `createGroup()` writes a complete document (name, creator, members, empty
locations and places).

### F8 — Group codes were guessable and sometimes short
`Math.random().toString(36).substring(2, 8)` is not a CSPRNG, and can return fewer than six
characters when the float's base-36 expansion is short. That code was the only thing between
a stranger and a family's live location.

**Fixed.** `expo-crypto` CSPRNG over an 8-character unambiguous alphabet (32^8).

### F9 — An app restart cleared an active emergency
`LocationService.startLocationUpdates` pushed an initial position that included
`emergency: false`. **Fixed** — location writes never touch the emergency flag.

### F10 — Sudden-stop / sudden-acceleration counts were meaningless
`DriveScreen` had `let lastUpdateTime = Date.now()` **in the component body**, so every
render reset it and the acceleration was divided by a near-zero or arbitrary interval.

**Fixed.** Moved to a ref, with implausible intervals (< 0.2 s, > 10 s) ignored.

### F11 — `startDriving` fired unpredictably and could crash
`useEffect(..., [speedRef.current, user.uid])`: a ref mutation never re-runs an effect, so
this ran on whatever unrelated render came next; `user.uid` also threw for a signed-out user
(`const user = auth.currentUser`).

**Fixed.** Keyed on the `speed` state with a null guard.

> Note: `users/{uid}.isDriving` is written but never read — `LocationScreen` derives
> "driving" from the member's reported speed. It is left in place (harmless, and the UX
> rework may want it) but it is currently dead weight.

### F12 — Errors were swallowed in ways that hid failures
`getTotalDrivesNumber`, `getUserDrives`, `getAllDriveMetrics` and `getDriveMetrics` all
returned `[]`/`0` on error with no log (two of them had a bare `catch`), so a
permission-denied read looked identical to an empty account. All error paths now log.

### P1 — Background location was "cooking the backend"
`utils/LocationService.js` had four compounding problems:
1. `startLocationUpdatesAsync` was called with `accuracy: High` and **no** `distanceInterval`
   or `timeInterval`, so the OS delivered fixes as fast as the GPS produced them — several
   per second while driving — and every one of them woke the JS task, which then discarded
   most of them in JS.
2. The gate state (`lastLocation`, `lastUpdateTime`) lived in module globals. The background
   JS context is torn down between wake-ups, so `isFirstUpdate` was true on every cold start
   and each one wrote immediately, bypassing the gate.
3. `App.js` starts tracking at launch unconditionally. Users with no group were prompted for
   always-on location permission and burned battery producing fixes that were then dropped.
4. The write was `setDoc(groupRef, {memberLocations: {…}}, {merge: true})` — a write to the
   whole group document.

**Fixed.** The OS is asked for the cadence we actually write at (25 m / 20 s) with deferred
batching; gate state is persisted, with a 15 s hard floor that also applies to the first fix;
tracking only starts for users in a group and stops itself when the group goes away; and
writes go through `updateMemberLocation()`, which sets only the caller's own coordinate
fields.

> Not changed, deliberately: `memberLocations` is still a map on the group document, so one
> member's write still re-fires every member's `onSnapshot`. Moving it to a
> `groups/{id}/memberLocations/{uid}` subcollection does **not** reduce the read count (a
> collection listener still charges one read per changed document per listener) — it buys
> write-contention headroom (Firestore sustains ~1 write/s per document, so a large group
> writing every 20 s eventually contends) and stops `savedLocations` churn from waking
> location listeners. It is a schema migration with real breakage risk and the write-rate
> reduction above buys more, sooner. Recommended when groups get past ~10 members.

### P2 — Speed-limit cache re-serialized itself on every cell fill
`DriveScreen` called `saveSpeedLimitCache()` — `JSON.stringify` of the entire, unbounded,
never-expiring `Map` — after every fill. Filling one 4 km segment touches ~150 cells, i.e.
~150 full serializations, on the JS thread, inside the position callback. This is a very
likely contributor to the "location screen lag" on your Chill list.

**Fixed.** `utils/speedLimits.js`: debounced persistence (one write per 4 s burst, flushed
when a drive ends), LRU-bounded at 4000 entries, 60-day expiry, and the request throttle and
HERE response parsing live with the cache instead of being scattered across the screen.

### P3 — Every driver paid for the same roads
Reverse geocoding is the app's most frequent paid call, and it is enormously repetitive —
the same roads, by the same driver daily, and by every other driver in town. Each one was a
fresh billed HERE transaction.

**Fixed.** `functions/lib/here.js` caches results per ~220 m grid cell both in the function
instance and in Firestore at `geocache/{cell}` (60-day TTL), shared across all users. A
Firestore read is roughly three orders of magnitude cheaper than a HERE transaction, and the
second driver down a road pays nothing. Only a request that will actually reach HERE
consumes the caller's quota.

### P4 — Reading whole collections to answer small questions
| Function | Was | Now |
|---|---|---|
| `getTotalDrivesNumber` | read **every** drive document to call `.size` | `totalDrives` counter on the user doc, falling back to `getCountFromServer` and backfilling |
| `getDriveMetrics(uid, days)` | read every drive, filter and sort on device | `where('timestamp','>=',cutoff)` + `orderBy` on the server |
| `getUserDrives` | unbounded | optional `pageSize`/`cursor`; new `getDriveHistoryPage` |
| `clearUserDrives` | one `deleteDoc` round trip per document | batched, 450 per commit |
| MyDrives summary | derived from the full history in memory | two count queries |

### P5 — Dashboard read the same document three times
`getUserPoints`, `getUsername` and a local `getCachedUserDoc` each read `users/{uid}`, plus
`getTotalDrivesNumber` read the whole drive collection — on mount **and** on every focus.
Now one shared cached read (30 s TTL) in `utils/firestore.js` serves all of them.

### P6 — AIScreen re-read everything on every tab press
`getAllDriveMetrics(uid)` ran inside an effect keyed on `[uid, timeframe]`, so tapping
Day/Week/Month re-read the user's entire drive history. Now one 30-day range query per
account, filtered locally.

### P7 — Weather polled every 10 s / 100 m
Each poll can trigger an OpenAI road-condition summary. Weather does not change on that
timescale. Now 5 min / 1 km.

### P8 — `notifyOnEmergency` did work on every location write
It fires on every `groups/{id}` update, i.e. every member position. It now determines
whether any emergency flag actually changed before touching Firestore at all, and most
invocations exit immediately. Push sending also chunks to Expo's 100-message limit and
deletes tokens Expo reports as `DeviceNotRegistered`.

### Not changed, flagged
* `screens/LocationScreen.js` reverse-geocodes member positions against
  **nominatim.openstreetmap.org** directly from the client, with a hard-coded 1 s sleep for
  rate-limit compliance. Nominatim's usage policy does not permit app traffic at scale and
  they block by User-Agent/IP. It works and it is cached, so it is left alone, but it should
  move behind `hereRevGeocode` (now server-cached, so the cost is much lower than it was)
  before you have many users.
* App Check is not enabled. It is the standard way to stop the callables being used by
  anything other than your app binary. Worth doing before launch.
* `users/{uid}.isDriving` is written and never read (F11 note).

---

## 2. Firestore data model, as it now stands

```
users/{uid}                                  PUBLIC profile (any signed-in user may read)
  username           string  (<= 16 chars)
  usernameLower      string  (mirror of the usernames/ claim key)
  points             number  (>= 0, may only increase, <= +2000 per write)
  drivingStreak      number
  totalDrives        number  (counter; avoids counting the drive collection)
  photoURL           string | null   (Supabase public URL)
  groupId            string | null
  isDriving          bool    (written, currently unread)
  createdAt          timestamp
  lastDriveAt        timestamp
  [pushToken]        REMOVED - migrated to private/push
  [trustedContacts]  REMOVED - migrated to private/contacts

users/{uid}/private/info        { email, createdAt }            owner only
users/{uid}/private/contacts    { contacts: [{name, phone}] }   owner only
users/{uid}/private/push        { token, platform, updatedAt }  owner only
users/{uid}/private/usage       { day, counts:{…} }             owner-readable, function-written

users/{uid}/drivemetrics/{auto}                                 owner only, immutable
  timestamp          timestamp (server; enforced by rules)
  points, duration, distracted, avgSpeed, avgSpeedingMargin,
  suddenStops, suddenAccelerations, phoneUsageTime,
  totalDistance, speedingEvents

usernames/{lowercase}           { uid, username, createdAt }
  get: public (sign-up needs it while signed out).  list: denied.
  create/update/delete: only by the uid that owns the claim.

groups/{groupId}                members only
  groupName     string (<= 40, immutable after create)
  createdBy     uid            (immutable)
  createdAt     timestamp      (immutable)
  members       [uid]          (a member may only add/remove themselves)
  memberLocations { uid: { latitude, longitude, speed, updatedAt, emergency } }
                               (a member may only write their own key)
  savedLocations  [{ name, address, createdBy }]   (<= 100)

geocache/{cell}                 server only - shared HERE reverse-geocode cache
apikeys/**                      server only
userinfo/{uid}                  RETIRED - migrated into users/{uid}/private/info
```

### Indexes
`firestore.indexes.json` is wired into `firebase.json`. Every query in the app is served by
automatic single-field indexes — no composite index is required:

| Query | Index |
|---|---|
| `users orderBy points desc limit 50` | automatic |
| `users where points > n` (count) | automatic |
| `users where groupId == g` (function) | automatic |
| `users where __name__ in […]` | key index |
| `drivemetrics orderBy timestamp` (asc/desc, with range) | field override, both orders |
| `drivemetrics where distracted > 0` (count) | automatic |

---

## 3. Deploy steps

Run them in this order. Step 2 before step 3 matters: the rules depend on data the migration
creates.

### 1. Install dependencies (on Windows, as you normally do)
```
cd C:\Users\lurpd\Documents\dev\RoadCash-backend
npm install
cd functions
npm install
```
One new devDependency was added: **`@firebase/rules-unit-testing`** (rules tests only).
No new runtime dependency was added; `node-fetch` was *removed* as an implicit one.

### 2. Migrate the data (before deploying rules)
```
cd functions
set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
set GOOGLE_CLOUD_PROJECT=roadcash-e05e1
npm run migrate            # dry run - prints what it would do
npm run migrate:apply      # writes
```
It is idempotent, and it: creates `usernames/` claims for every existing user; moves
`pushToken` and `trustedContacts` off the public document; moves `userinfo/{uid}` into
`users/{uid}/private/info`; and adds `members` arrays to existing groups. It prints a warning
for any duplicate username it finds — resolve those before deploying.

Get the service account key from Firebase console → Project settings → Service accounts →
Generate new private key. Delete the file afterwards; do not commit it.

### 3. Deploy rules and indexes
```
cd C:\Users\lurpd\Documents\dev\RoadCash-backend
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

> Deploy the rules and the new app build close together. Old installs write `pushToken` on
> every launch and `trustedContacts` when the safety screen is saved; both are refused by
> the new rules. The writes are already inside try/catch so nothing crashes, but an old
> install will stop refreshing its push token until it updates.

### 4. Set the function secrets (if not already set)
```
firebase functions:secrets:set OPENAI_API_KEY
firebase functions:secrets:set HERE_API_KEY
```

### 5. Deploy functions
```
firebase deploy --only functions
```
`firebase.json` now runs `npm run lint` as a predeploy step, so a lint error blocks the
deploy. Lint is currently clean.

### 6. Client environment
Local: `.env` already exists in this worktree, pre-filled with the values that used to be
hard-coded, **plus two blanks you must fill** (see §6). It is gitignored, so copy it across
when you merge, or recreate it from `.env.example`.

```
npx expo start --clear     # --clear is required after changing env or app.config.js
```

EAS does not upload `.env`. Set the same names as EAS environment variables:
```
eas env:create --name EXPO_PUBLIC_FIREBASE_API_KEY            --value "..." --environment production
eas env:create --name EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN        --value "..." --environment production
eas env:create --name EXPO_PUBLIC_FIREBASE_PROJECT_ID         --value "..." --environment production
eas env:create --name EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET     --value "..." --environment production
eas env:create --name EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID --value "..." --environment production
eas env:create --name EXPO_PUBLIC_FIREBASE_APP_ID             --value "..." --environment production
eas env:create --name EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID     --value "..." --environment production
eas env:create --name EXPO_PUBLIC_SUPABASE_URL                --value "..." --environment production
eas env:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY           --value "..." --environment production
eas env:create --name EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID        --value "..." --environment production
eas env:create --name EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID        --value "..." --environment production
eas env:create --name EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID    --value "..." --environment production
```
Repeat for `--environment preview` and `--environment development`. `EXPO_PUBLIC_*` values
are inlined into the bundle and are visible to anyone with the binary — that is expected for
all twelve of these. If your EAS CLI predates `eas env`, the equivalent is
`eas secret:create --scope project --name <NAME> --value "<value>"`.

### 7. Native rebuild required
`app.config.js` adds `android.package` and a new iOS URL scheme, so this needs a new native
build, not an OTA update:
```
eas build --platform ios --profile production
eas build --platform android --profile production
```

---

## 4. Configuration values you must supply

Names only — no values are recorded in this repo outside the gitignored `.env`.

| Name | Where it comes from | Status |
|---|---|---|
| `EXPO_PUBLIC_FIREBASE_API_KEY` | Firebase console → Project settings → Web app | pre-filled in `.env` |
| `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN` | same | pre-filled |
| `EXPO_PUBLIC_FIREBASE_PROJECT_ID` | same | pre-filled |
| `EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET` | same | pre-filled |
| `EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | same | pre-filled |
| `EXPO_PUBLIC_FIREBASE_APP_ID` | same | pre-filled |
| `EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID` | same | pre-filled |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase → Project settings → API | pre-filled |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project settings → API (`anon` key) | pre-filled |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Google Cloud → Credentials | pre-filled |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | **you must create it** — §6 | **EMPTY** |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` | **you must create it** — §6 | **EMPTY** |
| `OPENAI_API_KEY` | Cloud Functions secret | already set |
| `HERE_API_KEY` | Cloud Functions secret | already set |
| service account JSON | Firebase console → Service accounts | needed only to run the migration |

---

## 5. Supabase Row Level Security

The app uses Supabase for one thing: `profile-pictures` storage, uploaded from
`screens/AccountSettings.js` to the path `<firebase-uid>/profilePic.jpg` using the anon key.

**Supabase has no idea who the Firebase user is.** There is no Supabase session — the app
authenticates against Firebase only. So a policy of the form `auth.uid() = owner` cannot
work here, and any policy that permits anonymous writes permits *every* anon-key holder to
overwrite or delete *any* user's photo. The `.remove()` call before each upload means a
hostile client can delete other people's avatars.

Verify in the Supabase dashboard (Storage → `profile-pictures` → Policies) that the bucket
is **public-read, no anonymous write**:

```sql
-- Anyone may read (the public URL is embedded in the app and in the user document).
create policy "profile pictures are publicly readable"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'profile-pictures');

-- Nobody may write with the anon key. Uploads go through a trusted path (see below).
-- Confirm NO insert/update/delete policy exists for the `anon` role on this bucket.
```

If uploads are currently working with the anon key, an anonymous write policy exists and
should be removed. Two ways to keep the feature:

* **Recommended, no new infrastructure**: move the photo upload into a Cloud Function
  (`uploadProfilePhoto`) that verifies the Firebase auth context and uploads with the
  Supabase **service role** key held as a function secret. The client sends the image, never
  the key.
* **Alternative**: drop Supabase for this and use Firebase Storage, which already
  understands the Firebase user. One rule (`match /profilePictures/{uid}/{f} { allow read:
  if true; allow write: if request.auth.uid == uid; }`) replaces the whole problem, and
  `getStorage()` is already initialized in `utils/firebase.js`.

Either is a change to `AccountSettings.js`, which the UX agent is rewriting, so it was left
alone here and is documented instead.

---

## 6. Google sign-in — console steps

Everything fixable in code is fixed. The remaining work is in the Google Cloud console, in
the **same GCP project as Firebase** (`roadcash-e05e1`) so Firebase Auth accepts the tokens.

**APIs & Services → Credentials → Create credentials → OAuth client ID**

1. **iOS client**
   * Application type: **iOS**
   * Bundle ID: `com.lurp.safedrive`
   * Copy the client id into `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`.
   * `app.config.js` derives the redirect URL scheme from it automatically
     (`com.googleusercontent.apps.<id-without-suffix>`) and registers it in `CFBundleURLTypes`,
     so there is nothing to paste into `app.json`. **This was the missing piece** — without
     that scheme registered, Google's redirect has nowhere to land.

2. **Android client**
   * Application type: **Android**
   * Package name: `com.lurp.safedrive` (now set in `app.config.js`)
   * SHA-1: from the credentials EAS will sign with —
     `eas credentials --platform android` → Keystore → SHA1 fingerprint.
   * Copy the client id into `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`.
   * If you later let Google Play re-sign the app, add the Play **App signing** SHA-1 as a
     second Android client or sign-in will break on store builds.

3. **Keep the existing Web client id.** It stays in `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`; it
   is the audience Firebase validates the id token against.

4. **Firebase console → Authentication → Sign-in method → Google**: enabled, and its "Web
   SDK configuration" web client id matches `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`.

5. **OAuth consent screen**: published (or your test account listed as a test user), with the
   `email` and `profile` scopes.

6. Rebuild natively (`eas build`) — a URL scheme change cannot ship over the air.

Until the two client ids are filled in, the Google button is disabled and the screen says
"Google sign-in is not configured for this build", instead of failing silently.

---

## 7. Call sites touched

The UX agent is rewriting screens in parallel, so screen edits were kept to the minimum
needed. Every one:

| File | What changed |
|---|---|
| `screens/LoginScreen.js` | per-platform Google client ids, `maybeCompleteAuthSession()`, error/dismiss handling, `ensureUserProfile()` after sign-in, disabled state when unconfigured |
| `screens/SignUpScreen.js` | username registry check + transactional claim, `ensureUserProfile()`, removed the `userinfo` write and the `users` uniqueness query |
| `screens/AccountSettings.js` | one `getUserSummary()` read instead of two; `getGroupName()`; `claimUsername()` for rename; **removed the sign-out points write** |
| `screens/DashboardScreen.js` | `getUserSummary()` replaces the local cache and two reads; points read from the server instead of being recomputed and written locally; `invalidateDashboardUserCache` kept as a re-export |
| `screens/MyDrivesScreen.js` | `getDriveHistoryPage()` + `getDriveCounts()`; "Load more" fetches a page; `keyExtractor` uses the document id |
| `screens/AIScreen.js` | `getDriveMetrics(uid, 30)` once per account; aggregation split into its own effect |
| `screens/RewardsScreen.js` | `getCachedTotalPoints(uid)` instead of the wrong AsyncStorage key |
| `screens/DriveScreen.js` | `finalizeDriveWrite()`; speed-limit cache moved to `utils/speedLimits`; emergency via `utils/groups`; accel-sample ref; `startDriving` effect; weather cadence; dead `getAdaptiveGridKey` removed |
| `screens/LocationScreen.js` | `createGroup` / `joinGroup` / `leaveGroup` / `addSavedLocation` / `removeSavedLocation`; `getUserSummary()`; explicit `limit(10)` on the profile `in` query |

`App.js`, `hooks/`, `context/`, `navigation/` and `theme/` were **not** touched.

### Backward compatibility
Every function previously exported from `utils/` still exists with a compatible signature.
Added arguments are optional. `getUserDrives(uid)` and `getAllDriveMetrics(uid)` still
return everything when called with one argument. `updateCachedGroupId` is still exported
from `utils/LocationService` (re-exported from the new `utils/groupCache`).

---

## 8. What was verified, and what was not

**Verified here**
* `npx expo export --platform ios` builds the bundle clean — every import resolves and every
  screen compiles. (Output dir deleted afterwards; it is gitignored.)
* `npx eslint .` in `functions/` is clean. It had never passed before: the parser could not
  read the file.
* Syntax-checked every modified `utils/*.js` module.
* Grepped for dangling references to everything removed (`getCachedUserDoc`, `userinfo`,
  the bare `'totalPoints'` key, the old speed-limit globals) — none remain.

**NOT verified here — please check before/after deploying**
* **The rules tests were not executed.** `functions/test/firestore.rules.test.js` is written
  (39 cases across groups, users, private data, drive metrics, usernames and the server-only
  collections) but the Firestore emulator needs Java 11+ and this environment has Java 8.
  Run `cd functions && npm install && npm run test:rules` on Windows first. **Do not deploy
  the rules without running them** — a rules mistake either leaks data or locks users out,
  and neither is visible until it happens.
* No runtime testing on a device: sign-up, Google sign-in, a real drive finalization, group
  create/join/leave, and a background location write have not been exercised.
* The migration script has not been run against real data.
* The Supabase bucket policy has not been inspected — I have no access to that dashboard.
* Cloud Functions were not deployed or invoked; the OpenAI and HERE paths are unexercised.

**Suggested smoke test after deploying**, in order: sign up with a new email → check
`users/{uid}` and `usernames/{name}` in the console → complete a short drive and confirm
points, streak and `totalDrives` all move in one write → sign out and back in and confirm
points did **not** reset → create a group, join it from a second account, confirm the second
account sees the first on the map and that a third, non-member account gets
`permission-denied` reading that group document → raise and clear an emergency and confirm
both pushes arrive.
