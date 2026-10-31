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

`.github/workflows/ci.yml` runs on every push to `V2` and `main` and on pull requests, in three
parallel jobs: **app** (`npm ci` on Node 22 / npm 10, then typecheck, lint, Jest, lock:check),
**functions** (`functions:check` and `functions:test` on Deno 2.9.6) and **db** (a local Supabase
stack on CLI 2.121.0 with Postgres and Auth only, `db reset`, `test db`, then the integration test).
It needs no secrets and never reaches the hosted project.

## Layout

`app/` routes · `src/ui` design system · `src/features` screens · `src/core` engine · `src/data` storage and Supabase · `packages/scoring` shared scoring · `modules/` native modules · `supabase/` schema and functions.
