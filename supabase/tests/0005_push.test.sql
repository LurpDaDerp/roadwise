-- 0005_push: preferences, the outbox claim/outcome/receipt cycle, token hygiene, the idle sweep
-- probe, the recap producer, grants.
create extension if not exists pgtap with schema extensions;

begin;
select plan(32);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
insert into public.devices (user_id, device_id, platform, push_token) values
  ('00000000-0000-0000-0000-000000000001', 'device-aaaaaaaa', 'ios', 'ExponentPushToken[aaaaaaaaaaaa]'),
  ('00000000-0000-0000-0000-000000000002', 'device-bbbbbbbb', 'android', 'ExponentPushToken[bbbbbbbbbbbb]');

-- ---------------------------------------------------------------------------
-- preferences
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(public.get_notification_prefs(), '{"tz": null, "social": true, "leagues": true, "quiet_end": "07:00", "quiet_start": "22:00", "weekly_recap": true, "quiet_enabled": true}'::jsonb, 'defaults without a row');
select throws_ok($$ select public.set_notification_prefs(p_quiet_start := '25:00') $$, '22023', 'quiet hours must be HH:MM', 'a bad time is refused');
select throws_ok($$ select public.set_notification_prefs(p_tz := 'Mars/Olympus') $$, '22023', 'unknown time zone', 'an unknown zone is refused');
select is(public.set_notification_prefs(p_weekly_recap := false, p_quiet_start := '23:30', p_tz := 'America/Los_Angeles') -> 'weekly_recap', 'false'::jsonb, 'A turns the weekly recap off');
select is(public.get_notification_prefs(), '{"tz": "America/Los_Angeles", "social": true, "leagues": true, "quiet_end": "07:00", "quiet_start": "23:30", "weekly_recap": false, "quiet_enabled": true}'::jsonb, 'the row holds the changes, the rest default');
select is((select count(*)::int from public.notification_prefs), 1, 'the owner reads their prefs row');
select throws_ok($$ update public.notification_prefs set weekly_recap = true $$, '42501', null, 'but cannot write it directly');
select throws_ok($$ select count(*) from public.inbox $$, '42501', null, 'the inbox is server-only');
select throws_ok($$ select public.claim_push_batch(10, 60) $$, '42501', null, 'a client cannot claim pushes');
reset role;

-- ---------------------------------------------------------------------------
-- outbox cycle (service role)
-- ---------------------------------------------------------------------------
insert into public.inbox (user_id, kind, payload, dedupe_key) values
  ('00000000-0000-0000-0000-000000000001', 'weekly_recap', '{"week":"2026-W39","rating":null,"rating_delta":null,"drives":2,"goals_done":1}', 'weekly_recap:2026-W39'),
  ('00000000-0000-0000-0000-000000000002', 'friend_request', '{"from_user_id":"00000000-0000-0000-0000-000000000001"}', 'friend_request:00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002', 'weekly_recap', '{"week":"2026-W40"}', 'weekly_recap:2026-W40');
update public.inbox set push_after = now() + interval '1 hour' where dedupe_key = 'weekly_recap:2026-W40';
select throws_ok($$ insert into public.inbox (user_id, kind, payload, dedupe_key) values ('00000000-0000-0000-0000-000000000001', 'league_result', '{}', 'league:x') $$,
  '23514', null, 'a league result is no inbox kind any more');
select is(private.dispatch_push(), 'unconfigured', 'with due rows and no vault secrets the sweep reports unconfigured');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table batch as select public.claim_push_batch(10, 60) as b;
select is((select jsonb_array_length(b) from batch), 2, 'two due rows are claimed (the deferred one is not)');
select is((select x -> 'ctx' from batch, jsonb_array_elements(b) x where x ->> 'user_id' = '00000000-0000-0000-0000-000000000001'),
  '{"tz": "America/Los_Angeles", "quiet": {"end": "07:00", "start": "23:30", "enabled": true}, "tokens": ["ExponentPushToken[aaaaaaaaaaaa]"], "enabled": false}'::jsonb,
  'ctx carries A''s zone, quiet hours, tokens and the preference for this kind (the recap, off)');
select is((select x -> 'ctx' ->> 'enabled' from batch, jsonb_array_elements(b) x where x ->> 'kind' = 'friend_request'), 'true', 'B has no prefs row: social is on');
select is((select array_agg(push_state) from public.inbox where push_state = 'sending'), array['sending', 'sending'], 'claimed rows are sending');
select is(public.claim_push_batch(10, 60), '[]'::jsonb, 'a second claim finds nothing');
select is(public.record_push_outcomes(jsonb_build_object('outcomes', jsonb_build_array(
    jsonb_build_object('inbox_id', (select id from public.inbox where dedupe_key = 'weekly_recap:2026-W39'), 'state', 'skipped', 'reason', 'category_off'),
    jsonb_build_object('inbox_id', (select id from public.inbox where kind = 'friend_request'), 'state', 'sent', 'reason', 'ok',
      'deliveries', jsonb_build_array(jsonb_build_object('token', 'ExponentPushToken[bbbbbbbbbbbb]', 'ticket_id', 'tkt-1')))))), 2, 'two outcomes applied');
select is((select row(push_state, push_reason, pushed_at is not null)::text from public.inbox where kind = 'friend_request'), row('sent', 'ok', true)::text, 'the sent row is stamped');
select is((select row(push_state, push_reason)::text from public.inbox where dedupe_key = 'weekly_recap:2026-W39'), row('skipped', 'category_off')::text, 'the skipped row keeps its reason');
select throws_ok($$ select public.record_push_outcomes(jsonb_build_object('outcomes', jsonb_build_array(jsonb_build_object('inbox_id', (select id from public.inbox where dedupe_key = 'weekly_recap:2026-W39'), 'state', 'sent', 'reason', 'ok')))) $$,
  '22023', 'outcome for an unclaimed item', 'an outcome for a settled row is refused');
select is(public.push_receipts_due(100), '[]'::jsonb, 'a ticket under 15 minutes old is not due yet');
reset role;
update public.push_deliveries set created_at = now() - interval '20 minutes';
set local role service_role;
select is((select jsonb_array_length(public.push_receipts_due(100))), 1, 'after 15 minutes the receipt is due');
select is(public.record_push_receipts(jsonb_build_object('receipts', jsonb_build_array(jsonb_build_object('delivery_id', (select id from public.push_deliveries), 'status', 'error', 'error', 'DeviceNotRegistered')))), 1, 'a receipt is recorded');
select is((select push_token from public.devices where user_id = '00000000-0000-0000-0000-000000000002'), null, 'DeviceNotRegistered clears the device token');
select is((select row(receipt_status, receipt_error)::text from public.push_deliveries), row('error', 'DeviceNotRegistered')::text, 'and the delivery keeps the receipt');
select is(array[public.acquire_job_lease('push-sender', 'runner-1', 60), public.acquire_job_lease('push-sender', 'runner-2', 60), public.acquire_job_lease('push-sender', 'runner-1', 60)], array[true, false, true],
  'a lease is held by one runner at a time, renewable by its holder');
reset role;

-- lease expiry on the sending state
update public.inbox set push_state = 'sending', push_claimed_at = now() - interval '2 hours' where dedupe_key = 'weekly_recap:2026-W39';
set local role service_role;
select public.claim_push_batch(10, 60);
select is((select row(push_state, push_reason)::text from public.inbox where dedupe_key = 'weekly_recap:2026-W39'), row('failed', 'lease_expired')::text, 'a claim past its lease is failed, never re-sent');
reset role;

-- idle probe: nothing due, nothing sending, no receipt owed
update public.inbox set push_after = now() + interval '1 day' where push_state in ('pending', 'deferred');
select is(private.dispatch_push(), 'idle', 'the sweep is idle without reading any secret');
select is(private.produce_weekly_recaps(), 0, 'no user with a drive this week: no recap');

-- grants
select is((select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
    from unnest(array['public.claim_push_batch(int, int)', 'public.record_push_outcomes(jsonb)', 'public.push_receipts_due(int)', 'public.record_push_receipts(jsonb)',
      'public.acquire_job_lease(text, text, int)', 'public.release_job_lease(text, text)']) f), true, 'the push writers execute for service_role only');
select is((select count(*)::int from information_schema.role_table_grants g where g.grantee in ('anon', 'authenticated') and g.table_name in ('inbox', 'push_deliveries', 'job_leases')), 0,
  'inbox, deliveries and leases have no client grants');
select is((select array_agg(jobname order by jobname) from cron.job), array['cron-log-purge', 'inbox-purge', 'purge-auth-audit', 'push-sender-sweep', 'rating-refresh', 'weekly-recap'], 'the six cron jobs are scheduled (no league close)');

select * from finish();
rollback;
