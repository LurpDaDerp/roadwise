# RoadWise

Reward-based safe-driving app for new drivers. React Native / Expo (development client), Supabase backend.

## Develop

    npm install
    npx expo start --dev-client

Camera coaching and background drive capture need a development build (`eas build --profile development`); they do not run in Expo Go.

## Development builds

Install the dev client from its build page, then run `npx expo start --dev-client` and scan the QR code. Both are internal-distribution builds of the `development` profile; the iOS one only installs on a device registered in the ad hoc provisioning profile.

- Android: https://expo.dev/accounts/lurpdaderp/projects/SafeDriveApp/builds/3c6971a3-ab6f-4ed4-b9e4-67c162dd0ab5
- iOS: https://expo.dev/accounts/lurpdaderp/projects/SafeDriveApp/builds/3627c3be-9130-4597-9001-fc9ea274cd70

Rebuild both with `npx eas-cli build --profile development --platform all`. The pinned `eas-cli` in `devDependencies` is what `npx eas-cli` resolves, so everyone runs the same CLI.

## Test

    npm test                 # Jest
    npx supabase start       # local stack (Docker)
    npx supabase test db     # pgTAP

## Layout

`app/` routes · `src/ui` design system · `src/features` screens · `src/core` engine · `src/data` storage and Supabase · `packages/scoring` shared scoring · `modules/` native modules · `supabase/` schema and functions.
