import { assertEquals } from '@std/assert';
import { decide, inQuietHours, nextLocalTime, resolveTz, type PushItem } from './push_policy.ts';
import { isPushKind, PUSH_KINDS, renderPush, TTL_MS } from './push_copy.ts';
import { pushItem } from './testing/fake_push_db.ts';

/** 2026-09-21 14:13:20 UTC = 07:13:20 Los Angeles (outside the default quiet hours). */
const NOW = 1790000000 * 1000;
const HOUR = 3_600_000;
const item = (o: Partial<PushItem> = {}, ctx: Partial<PushItem['ctx']> = {}) => pushItem({ createdAt: NOW - HOUR, ...o }, ctx);

Deno.test('a weekly recap is sent to every token with its words and the home url', () => {
  const d = decide(item(), NOW);
  assertEquals(d.kind, 'send');
  if (d.kind !== 'send') return;
  assertEquals(d.tokens, ['ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]']);
  assertEquals(d.message.title, 'Your week on the road');
  assertEquals(d.message.body, '5 drives this week. Safety Rating 92, up 1. 2 of 3 weekly goals done.');
  assertEquals(d.message.data.url, '/home');
  assertEquals(d.message.channelId, 'updates');
});

Deno.test('no league result is ever sent: the kind is gone, so a queued one is skipped', () => {
  const league = item({ kind: 'league_result', payload: { week: '2026-W40', result: 'promoted', final_rank: 3, tier: 'bronze', new_tier: 'silver', week_points: 410 } });
  assertEquals(decide(league, NOW), { kind: 'skip', reason: 'unknown_type' });
  assertEquals(isPushKind('league_result'), false);
  assertEquals([...PUSH_KINDS], ['weekly_recap', 'friend_request']);
});

Deno.test('the rules in order: unknown kind, bad payload, preference off, no device, stale', () => {
  assertEquals(decide(item({ kind: 'trip_summary' }), NOW), { kind: 'skip', reason: 'unknown_type' });
  assertEquals(decide(item({ payload: { week: '2026-W40' } }), NOW), { kind: 'fail', reason: 'bad_payload' });
  assertEquals(decide(item({}, { enabled: false }), NOW), { kind: 'skip', reason: 'category_off' });
  assertEquals(decide(item({}, { tokens: [] }), NOW), { kind: 'skip', reason: 'no_device' });
  assertEquals(decide(item({ createdAt: NOW - TTL_MS.weekly_recap - 1 }), NOW), { kind: 'skip', reason: 'stale' });
  assertEquals(decide(item({ createdAt: NOW - TTL_MS.weekly_recap }), NOW).kind, 'send');
});

Deno.test('quiet hours defer to their end in the user zone, across midnight and DST', () => {
  const lateLA = NOW + 16 * HOUR; // 23:13 Los Angeles
  const d = decide(item(), lateLA);
  assertEquals(d.kind, 'defer');
  if (d.kind !== 'defer') return;
  assertEquals(d.reason, 'quiet_hours');
  assertEquals(new Date(d.until).toISOString(), '2026-09-22T14:00:00.000Z'); // 07:00 PDT
  // the clocks fall back on 2026-11-01: 07:00 PST is 15:00 UTC
  const beforeShift = Date.UTC(2026, 10, 1, 6, 30); // 23:30 PDT on Oct 31
  assertEquals(new Date(nextLocalTime(beforeShift, 'America/Los_Angeles', '07:00')).toISOString(), '2026-11-01T15:00:00.000Z');
  assertEquals(inQuietHours(lateLA, 'America/Los_Angeles', { enabled: false, start: '22:00', end: '07:00' }), false);
  assertEquals(inQuietHours(lateLA, 'America/Los_Angeles', { enabled: true, start: '09:00', end: '09:00' }), false);
  assertEquals(resolveTz('Mars/Olympus'), 'America/New_York');
});

Deno.test('copy: the recap says the drives, the rating and its change, and the goals done; it never names anyone, a speed, points or a league', () => {
  const recap = (p: Record<string, unknown>) => renderPush('weekly_recap', { week: '2026-W40', ...p })?.body;
  assertEquals(recap({ rating: 91.7, rating_delta: 1.2, drives: 4, goals_done: 2 }), '4 drives this week. Safety Rating 92, up 1. 2 of 3 weekly goals done.');
  assertEquals(recap({ rating: 88, rating_delta: -2.4, drives: 5, goals_done: 3 }), '5 drives this week. Safety Rating 88, down 2. All 3 weekly goals done.');
  assertEquals(recap({ rating: 80, rating_delta: 0.4, drives: 2, goals_done: 0 }), '2 drives this week. Safety Rating 80.');
  assertEquals(recap({ rating: 80, rating_delta: null, drives: 2, goals_done: 1 }), '2 drives this week. Safety Rating 80. 1 of 3 weekly goals done.');
  assertEquals(recap({ rating: null, rating_delta: null, drives: 1, goals_done: 0 }), '1 drive this week. Your Safety Rating is on its way.');
  assertEquals(renderPush('weekly_recap', { week: '2026-W40', rating: 90, rating_delta: 1, drives: 3, goals_done: 1 })?.title, 'Your week on the road');
  // a recap queued before 0023 (points, streak, no goals) still renders, without the goals part or the points
  const old = recap({ rating: 91.7, rating_delta: 1.2, streak: 4, drives: 5, week_points: 420, best_drive_net: 167, league: { rank: 3, tier: 'silver', size: 30 } });
  assertEquals(old, '5 drives this week. Safety Rating 92, up 1.');
  for (const body of [old, recap({ rating: null, rating_delta: null, drives: 1 })]) {
    assertEquals(/points?|streak|league|level|!|—/i.test(body ?? ''), false);
  }
  const fr = renderPush('friend_request', { from_user_id: '22222222-2222-4222-8222-222222222222' });
  assertEquals(fr, { title: 'New friend request', body: 'Someone wants to add you as a friend.', url: '/friends' });
  assertEquals(renderPush('weekly_recap', { week: 1 }), null);
  assertEquals(renderPush('weekly_recap', { week: '2026-W40', rating: 90, rating_delta: 1, drives: 3, goals_done: 4 }), null);
});
