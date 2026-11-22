# Supabase data layer

`types.ts` is generated (`npm run db:types`) and describes every column, so its `Insert`/`Update` types list columns a client cannot write. Clients have no `INSERT`, `UPDATE` or `DELETE` on `profiles` or `consents`: `supabase/migrations/0001_core.sql` revokes everything and grants back only `SELECT` (on `consents`, and on named `profiles` columns, to which `0025_friend_sharing.sql` adds the `share_*` ones), so a direct `.update()`/`.insert()` fails with 42501.
`profile.ts` holds the only write paths, both server functions: `updateOwnProfile(userId, patch: ProfilePatch)` calls the `update_profile` RPC (`p_units`, `p_state`, `p_heatmap_visibility`, `p_share_*`) and `recordConsent(userId, consent: ConsentInsert)` calls `accept_terms(p_version)`. Each then reads the row back.
Reads of `profiles` name `PROFILE_COLUMNS`, never `select('*')`: `flagged` is not granted, and Postgres refuses the whole read.
Never write these tables anywhere else, and never spread a `Row` into a patch.
