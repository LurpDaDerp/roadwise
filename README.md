# RoadWise

Reward-based safe-driving app for new drivers. React Native / Expo (development client), Supabase backend.

## Develop

    npm install
    npx expo start --dev-client

Camera coaching and background drive capture need a development build (`npx eas-cli@24.7.0 build --profile development`); they do not run in Expo Go.

## Development builds

Install the dev client from its build page, then run `npx expo start --dev-client` and scan the QR code. Both are internal-distribution builds of the `development` profile; the iOS one only installs on a device registered in the ad hoc provisioning profile.

- Android: https://expo.dev/accounts/lurpdaderp/projects/SafeDriveApp/builds/3c6971a3-ab6f-4ed4-b9e4-67c162dd0ab5
- iOS: https://expo.dev/accounts/lurpdaderp/projects/SafeDriveApp/builds/3627c3be-9130-4597-9001-fc9ea274cd70

Every EAS command is run as `npx eas-cli@24.7.0 …` (the CLI is deliberately not a devDependency: its optional `typescript@5` peer made npm 10 and npm 11 write incompatible lockfiles, and the EAS builder runs `npm ci` on npm 10). Rebuild both with:

    npx eas-cli@24.7.0 build --profile development --platform all

`eas.json` still refuses any CLI below 24.

## Verify

    npm test                 # Jest — the app, the engine, the scoring package
    npm run typecheck        # tsc over the app, scripts/ and packages/scoring
    npm run lint             # eslint
    npx supabase start       # local stack (Docker)
    npx supabase db reset    # migrations + seed
    npx supabase test db     # pgTAP over the schema, the policies and the writers
    npm run functions:test   # deno test — the edge functions
    npm run functions:check  # deno lint + deno check
    npm run e2e:trip         # the end-to-end trip golden (below)

### The end-to-end trip golden

`npm run e2e:trip` drives recorded trips through every piece at once and asserts the authoritative
numbers at each step: replay a committed trace through the M1 detectors, finalize it over a real
SQLite, upload the gzip trace, POST the payload to `finalize-trip` (the one the finalizer returned,
asserted byte-equal to the one it put on the sync queue), read the stored rows back, then dispute an
event, change a role and delete a still-scored trip through `trip-actions` — checking how each one
moves the day aggregates, not merely that a row is still there.

Three things keep it honest. The device's provisional score and the server's authoritative score
must agree exactly (`provisionalMismatch: false`). The dispute's recomputed score is checked against
what `packages/scoring` predicts without the disputed event, computed before the request goes out
rather than written down. And a final negative control posts a payload declaring a score it did not
earn, proving the server returns and stores its own number — without it, a `finalize-trip` that
simply echoed the device back would pass every other check. Each section also declares how many
checks it must record, and the run ends by asserting it recorded exactly that many, so a block that
does not run is a failure rather than a shorter green run.

It needs the local stack running (`npx supabase start`); it starts `npx supabase functions serve`
itself if nothing is answering, or pass `--external-serve` to use one you already have. Every key is
read from `npx supabase status -o json` at run time and the run refuses to start unless the stack is
on 127.0.0.1 or localhost — no secret is ever written down and no hosted project can be reached.
Each run uses a fresh user and cleans up after itself. `--user <uuid>` pins the subject instead —
which first **deletes** that user's trips, day rows, baselines and rate limits, so the dispute
allowance and the aggregates are this run's alone. `--keep` leaves the trips in place for
inspection, and `--self-check` runs only the script's own pure-helper checks and needs no stack.

## Layout

`app/` routes · `src/ui` design system · `src/features` screens · `src/core` engine · `src/data` storage and Supabase · `packages/scoring` shared scoring · `modules/` native modules · `supabase/` schema and functions.
