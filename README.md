# RoadWise

Reward-based safe-driving app for new drivers. React Native / Expo (development client), Supabase backend.

## Develop

    npm install
    npx expo start --dev-client

Camera coaching and background drive capture need a development build (`eas build --profile development`); they do not run in Expo Go.

## Test

    npm test                 # Jest
    npx supabase start       # local stack (Docker)
    npx supabase test db     # pgTAP

## Layout

`app/` routes · `src/ui` design system · `src/features` screens · `src/core` engine · `src/data` storage and Supabase · `packages/scoring` shared scoring · `modules/` native modules · `supabase/` schema and functions.
