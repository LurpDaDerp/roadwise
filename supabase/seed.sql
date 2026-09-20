insert into public.app_config (key, value, is_public) values
  ('feature_flags', '{"camera_beta": true, "auto_detect": true, "referral": true}', true),
  ('min_app_version', '"2.0.0"', true)
on conflict (key) do update set value = excluded.value;
