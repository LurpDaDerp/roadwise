# Supabase data layer

`types.ts` is generated (`npm run db:types`) and describes every column, so its `Insert`/`Update` types are wider than what the column grants in `supabase/migrations/0001_foundation.sql` let a client write: `profiles` accepts only `display_name, avatar_path, driving_stage, units, locale, profile_visibility, flags`, `consents` only `user_id, type, version`, and Postgres rejects the whole statement (42501) when any other key is present.
`profile.ts` holds the only write paths: `updateOwnProfile(userId, patch: ProfilePatch)` and `recordConsent(userId, consent: ConsentInsert)` strip everything outside those columns before sending.
Never call `.update()`/`.insert()` on these tables anywhere else, and never spread a `Row` into a patch.
