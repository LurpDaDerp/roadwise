-- 0005_app_config_flags: the `feature_flags` and `min_app_version` app_config rows, on every
-- database (ruling D2 m5 and its addendum).
--
-- Until now both rows existed only in seed.sql, and `supabase db push` never runs seeds, so a hosted
-- database had neither. A flag only makes a feature available; the user's own opt-in still gates
-- it. `camera_beta` and `referral` are false until their milestones ship (M4 ruling T1 m5: a flag
-- must not advertise a feature that is not built); this file was amended in place while unpushed.
--
-- `on conflict do nothing`: a value an operator has already set on a hosted database is never
-- overwritten by a later push. No table, function or grant changes: app_config keeps 0001's RLS,
-- its `app_config_public` read policy (anon and authenticated read rows where is_public) and its
-- select-only grants, which the test file re-asserts.
insert into public.app_config (key, value, is_public)
values
  ('feature_flags', '{"camera_beta": false, "auto_detect": true, "referral": false}'::jsonb, true),
  ('min_app_version', '"2.0.0"'::jsonb, true)
on conflict (key) do nothing;
