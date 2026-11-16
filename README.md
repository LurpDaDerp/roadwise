# RoadWise

A free safe-driving app for teen drivers: it detects drives automatically, scores each one and keeps a Safety Rating. React Native / Expo (development client), Supabase backend.

## Develop

    npm install
    npx expo start --dev-client

Background drive capture needs a development build (`npx eas-cli@24.7.0 build --profile development`); it does not run in Expo Go.

## Development builds

Install the dev client from its build page, then run `npx expo start --dev-client` and scan the QR code. Both are internal-distribution builds of the `development` profile; the iOS one only installs on a device registered in the ad hoc provisioning profile.

- Android: https://expo.dev/accounts/lurpdaderp/projects/SafeDriveApp/builds/3c6971a3-ab6f-4ed4-b9e4-67c162dd0ab5
- iOS: https://expo.dev/accounts/lurpdaderp/projects/SafeDriveApp/builds/3627c3be-9130-4597-9001-fc9ea274cd70

Every EAS command is run as `npx eas-cli@24.7.0 …` (the CLI is deliberately not a devDependency: its optional `typescript@5` peer made npm 10 and npm 11 write incompatible lockfiles, and the EAS builder runs `npm ci` on npm 10). Rebuild both with:

    npx eas-cli@24.7.0 build --profile development --platform all

`eas.json` still refuses any CLI below 24.

## Over-the-air updates (release notes)

The runtime version is the **native fingerprint** (`runtimeVersion: { policy: 'fingerprint' }` in
`app.config.ts`, pinned by `app/__tests__/app-config.test.ts`): an update reaches only binaries built
from the same native code, so JS from before a native change (the drive-sense row fields, for
example) can never reach a newer binary.

- **Publish with the build's environment:** `npx eas-cli@24.7.0 update --channel <channel> --environment <the EAS environment the build used>`.
  The config reads environment-dependent values (the Google services file, the Maps key); publishing
  under another environment computes another fingerprint, and the update is then simply not delivered.
- **Check once after each new build:** `npx eas-cli@24.7.0 fingerprint:compare` against the build (or
  `npx expo-updates fingerprint:generate` locally and on the build) must report no difference. If the
  services-file path differs between environments, add a `fingerprint.config.js` source skip for the
  path (the file's content, not its path, is what the native build depends on).
- Binaries built before the fingerprint policy (runtime `2.0.0`) receive no further updates: testers
  install the new build.

## Verify

    npm test                 # Jest: the app, the engine, the scoring package
    npm run typecheck        # tsc over the app, scripts/ and packages/scoring
    npm run lint             # eslint
    npm run lock:check       # the lockfile passes npm ci on npm 10, as on EAS Build
    npm run functions:check  # deno lint + deno check over the edge functions
    npm run functions:test   # deno test: the edge functions' unit tests
    npm run db:start         # local Supabase stack (Docker)
    npm run db:test          # supabase db reset (migrations + seed), then pgTAP over the schema, the policies and the writers

The edge-function integration test (`supabase/functions/finalize-trip/integration.test.ts`) skips
itself under `functions:test`; with the local stack running, run it as its header shows:

    FUNCTIONS_IT_DB_URL=postgresql://postgres:postgres@127.0.0.1:54622/postgres deno test -A --config supabase/functions/deno.json supabase/functions/finalize-trip/integration.test.ts

## CI

`.github/workflows/ci.yml` runs on every push to `V2` and `main` and on pull requests, in four
parallel jobs: **app** (`npm ci` on Node 22 / npm 10, then typecheck, lint, Jest, lock:check),
**android** (JDK 17, `expo prebuild -p android`, then Gradle: drive-sense's JVM unit tests,
google-credential's Kotlin and a debug APK of the 64-bit ABIs, whose native libraries
`scripts/check-16kb-pages.py` and `zipalign -c -P 16` then check for 16 KB pages),
**functions** (`functions:check` and `functions:test` on Deno 2.9.6) and **db** (a local Supabase
stack on CLI 2.121.0 with Postgres and Auth only, `db reset`, `test db`, then the integration test).
It needs no secrets and never reaches the hosted project.

The android job's Gradle step runs locally the same way (JDK 17 and an Android SDK on the path):

    npx expo prebuild -p android --no-install
    cd android && ./gradlew :drive-sense:testDebugUnitTest :google-credential:compileDebugKotlin :app:assembleDebug -PreactNativeArchitectures=arm64-v8a,x86_64
    python scripts/check-16kb-pages.py android/app/build/outputs/apk/debug/app-debug.apk

## Android release (Google Play)

The build side is in the repo: `eas.json` makes a preview **APK** for testers (`--profile preview`,
installed straight from its build page) and a production **app bundle** (`--profile production`), and
`eas submit -p android` sends the latest production build to Play's **internal** track as a
**draft**. Everything below is the owner's, once, in the consoles (no secret is ever committed):

1. **Play Console app.** Create the app (package `com.lurp.safedrive`). The first app bundle must be
   uploaded by hand (Test and release › Internal testing › Create release), which also turns on
   **Play App Signing**; `eas submit` works from the second one on.
2. **Upload key.** EAS made it with the first Android build (`npx eas-cli@24.7.0 credentials -p
   android` shows its SHA-1 and SHA-256). Play Console › Test and release › Setup › App signing then
   shows two certificates: the **app signing key** (Google's, on every copy Play installs) and the
   **upload key** (EAS's, on the preview APKs). Steps 4, 5 and 6 need both.
3. **`eas submit` key.** Google Cloud › IAM › Service accounts › create one, add a JSON key; in Play
   Console › Users and permissions, invite its email with release rights for RoadWise. Keep the JSON
   outside the repo and set `GOOGLE_PLAY_SERVICE_ACCOUNT_KEY_PATH` to its path before
   `npx eas-cli@24.7.0 submit -p android --profile production` (`eas.json` reads the path from
   there; without it the submit stops at "serviceAccountKeyPath is not allowed to be empty").
4. **Firebase (server pushes).** Firebase console › add an Android app `com.lurp.safedrive` (add both
   SHA-1s), download `google-services.json` and store it as an EAS file variable:
   `npx eas-cli@24.7.0 env:create --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret`
   for every environment, then delete the local copy (or keep it git-ignored). Upload the FCM V1
   service account key: `npx eas-cli@24.7.0 credentials -p android` › Google Service Account › Push
   notifications (FCM V1). Without the file Android builds still work, with server pushes off.
   After the next build, check a signed-in Android phone registers its token as `android` and a
   recap push arrives on the "Updates" channel.
5. **Maps key.** Google Cloud › Maps SDK for Android › a key restricted to Android apps:
   `com.lurp.safedrive` with both SHA-1s. Set it as `EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY` (an EAS
   environment variable, and in `.env`). Without it the trip map is a blank grey tile.
6. **Google sign-in.** Google Auth Platform › Clients: one **Android** client per signing
   certificate (package `com.lurp.safedrive`, the SHA-1 of the app signing key; another with the
   upload key's SHA-1 for preview APKs). Credential Manager signs in with the **web** client id
   (`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`); the Android clients only have to exist with the right SHA-1,
   or the account sheet ends in an error.
7. **App Links.** Put the app signing key's and the upload key's SHA-256 into
   `web/link-site/.well-known/assetlinks.json` and deploy the link site
   (`web/link-site/README.md`), then set `ROADWISE_LINK_DOMAIN` and rebuild.
8. **Store link.** Set `store_urls.android` in the remote app config to
   `https://play.google.com/store/apps/details?id=com.lurp.safedrive`, so the update-required screen
   opens Play.
9. **App content declarations** (Play Console › Policy and programs › App content):
   - **Location permissions:** background location for automatic drive detection and recording.
     Describe the in-app disclosure ("Allow location in the background", shown before every
     request) and upload a short video: onboarding's Location step, the disclosure, Continue, the
     system's "Allow all the time", then a drive starting with the app closed.
   - **Foreground service types:** `location` (a drive being recorded, and the short silent
     "Checking for a drive" watch) and `connectedDevice` (the DashPal dashcam link while one is
     paired), each with a video of the notification while it runs. The app declares no other type.
   - **Data safety:** answer from `legal/data-inventory.md` (what is collected, what stays on the
     phone, what reaches third parties, retention, export and deletion); data is encrypted in
     transit and drivers can delete their account.
   - **Account deletion:** a web URL where a driver can ask for the account and its data to be
     deleted without the app (Play requires one besides Settings › Account › Delete account).
   - Privacy policy URL, target audience (13 and older, as the Terms), content rating, ads (none).
10. **Closed test.** A new personal developer account must run a closed test with at least 12
    testers opted in for 14 days in a row before it can apply for production access. Add their
    Google accounts (or a Google Group) to a closed track and share its opt-in link.

## Layout

`app/` routes · `src/ui` design system · `src/features` screens · `src/core` engine · `src/data` storage and Supabase · `packages/scoring` shared scoring · `modules/` native modules · `supabase/` schema and functions.
