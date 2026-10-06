import { assertEquals } from '@std/assert';
import { decide, inQuietHours, nextLocalTime, resolveTz, type PushItem } from './push_policy.ts';
import { renderPush, TTL_MS } from './push_copy.ts';
import { pushItem } from './testing/fake_push_db.ts';

/** 2026-09-21 14:13:20 UTC = 07:13:20 Los Angeles (outside the default quiet hours). */
const NOW = 1790000000 * 1000;
const HOUR = 3_600_000;
const item = (o: Partial<PushItem> = {}, ctx: Partial<PushItem['ctx']> = {}) => pushItem({ createdAt: NOW - HOUR, ...o }, ctx);

Deno.test('a league result is sent to every token with its words and the leagues url', () => {
  const d = decide(item(), NOW);
  assertEquals(d.kind, 'send');
  if (d.kind !== 'send') return;
  assertEquals(d.tokens, ['ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]']);
  assertEquals(d.message.title, 'League results are in');
  assertEquals(d.message.body, 'You finished #3 in Bronze and moved up to Silver.');
  assertEquals(d.message.data.url, '/leagues');
  assertEquals(d.message.channelId, 'updates');
});

Deno.test('the rules in order: unknown kind, bad payload, preference off, no device, stale', () => {
  assertEquals(decide(item({ kind: 'trip_summary' }), NOW), { kind: 'skip', reason: 'unknown_type' });
  assertEquals(decide(item({ payload: { week: '2026-W40' } }), NOW), { kind: 'fail', reason: 'bad_payload' });
  assertEquals(decide(item({}, { enabled: false }), NOW), { kind: 'skip', reason: 'category_off' });
  assertEquals(decide(item({}, { tokens: [] }), NOW), { kind: 'skip', reason: 'no_device' });
  assertEquals(decide(item({ createdAt: NOW - TTL_MS.league_result - 1 }), NOW), { kind: 'skip', reason: 'stale' });
  assertEquals(decide(item({ createdAt: NOW - TTL_MS.league_result }), NOW).kind, 'send');
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

Deno.test('copy: the recap and friend request never name anyone or a speed', () => {
  const recap = renderPush('weekly_recap', { week: '2026-W40', rating: 91.7, rating_delta: 1.2, streak: 4, drives: 5, week_points: 420, best_drive_net: 167, league: { rank: 3, tier: 'silver', size: 30 } });
  assertEquals(recap?.body, '5 drives, +420 points. Best drive +167. Safety Rating 91.7 (up 1.2). Streak 4. #3 in Silver.');
  const closed = renderPush('weekly_recap', { week: '2026-W40', rating: 80, rating_delta: 0, streak: 2, drives: 2, week_points: 50, best_drive_net: 30, league: null, last_result: { week: '2026-W39', result: 'promoted', final_rank: 2, tier: 'bronze' } });
  assertEquals(closed?.body, '2 drives, +50 points. Best drive +30. Safety Rating 80.0. Streak 2. Last week: promoted from Bronze.');
  const unranked = renderPush('weekly_recap', { week: '2026-W40', rating: null, rating_delta: null, streak: 0, drives: 1, week_points: -12, best_drive_net: -12 });
  assertEquals(unranked?.body, '1 drive, -12 points. Best drive -12. Not ranked yet. Streak 0.');
  const fr = renderPush('friend_request', { from_user_id: '22222222-2222-4222-8222-222222222222' });
  assertEquals(fr, { title: 'New friend request', body: 'Someone wants to add you as a friend.', url: '/friends' });
  assertEquals(renderPush('league_result', { week: '2026-W40', result: 'demoted', final_rank: 11, tier: 'silver', new_tier: 'bronze', week_points: 3 })?.body,
    'You finished #11 in Silver. Next week starts in Bronze.');
  assertEquals(renderPush('weekly_recap', { week: 1 }), null);
});
