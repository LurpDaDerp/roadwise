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
SQLite, upload the gzip trace, POST the queued payload to `finalize-trip`, read the stored rows back,
then dispute an event, change the role and delete the trip through `trip-actions`. The device's
provisional score and the server's authoritative score must agree exactly (`provisionalMismatch:
false`), and the dispute's recomputed score is checked against what `packages/scoring` predicts
without the disputed event rather than against a written-down number.

It needs the local stack running (`npx supabase start`); it starts `npx supabase functions serve`
itself if nothing is answering, or pass `--external-serve` to use one you already have. Every key is
read from `npx supabase status -o json` at run time and the run refuses to start unless the stack is
on 127.0.0.1 or localhost — no secret is ever written down and no hosted project can be reached.
Each run uses a fresh user and cleans up after itself; `--user <uuid>` pins the subject and `--keep`
leaves the trips in place for inspection. `--self-check` runs only the script's own pure-helper
checks and needs no stack at all.

## Layout

`app/` routes · `src/ui` design system · `src/features` screens · `src/core` engine · `src/data` storage and Supabase · `packages/scoring` shared scoring · `modules/` native modules · `supabase/` schema and functions.
