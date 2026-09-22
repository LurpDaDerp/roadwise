-- 0005_app_config_flags: the `feature_flags` app_config row, on every database (ruling D2 m5).
--
-- Until now the row existed only in seed.sql, and `supabase db push` never runs seeds, so a hosted
-- database had no flags. The values are the M3 defaults seed.sql carried. A flag only makes a
-- feature available; the user's own opt-in still gates it.
--
-- `on conflict do nothing`: a value an operator has already set on a hosted database is never
-- overwritten by a later push. No table, function or grant changes: app_config keeps 0001's RLS,
-- its `app_config_public` read policy (anon and authenticated read rows where is_public) and its
-- select-only grants, which the test file re-asserts.
insert into public.app_config (key, value, is_public)
values ('feature_flags', '{"camera_beta": true, "auto_detect": true, "referral": true}'::jsonb, true)
on conflict (key) do nothing;
