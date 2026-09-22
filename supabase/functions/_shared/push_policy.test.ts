import { assert, assertEquals } from '@std/assert';
import { buildCatalog, CATALOG, type Catalog } from './catalog.ts';
import {
  cappedDecision,
  decide,
  DEFER_WHEN_CAPPED,
  decideBatch,
  DEFAULT_TZ,
  DRIVING_RETRY_MS,
  firstSlotAfter,
  inQuietHours,
  localDate,
  type Decision,
  type PushItem,
} from './push_policy.ts';

const H = 3_600_000;
const MIN = 60_000;
/** 12:00 PDT on a Tuesday: outside the default quiet hours. */
const NOW = Date.parse('2026-09-22T19:00:00Z');
const USER = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

let seq = 0;
const inboxId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function item(overrides: Partial<PushItem> = {}, ctx: Partial<PushItem['ctx']> = {}): PushItem {
  return {
    inboxId: inboxId(),
    userId: USER,
    type: 'permission_lapsed',
    payload: { permission: 'location_always', platform: 'ios', deviceId: 'phone-a' },
    createdAt: NOW - 10 * MIN,
    read: false,
    dismissed: false,
    subjectGone: false,
    ...overrides,
    ctx: {
      tz: 'America/Los_Angeles',
      quiet: { enabled: true, start: '22:00', end: '07:00' },
      categories: {},
      drivingSince: null,
      recent: [],
      localSentToday: 0,
      tokens: [TOKEN],
      ...ctx,
    },
  };
}

const reason = (d: Decision): string => (d.kind === 'send' ? 'send' : d.reason);

// ——— one case per reason, in order ———

Deno.test('a trip_summary arriving pending is refused as local, before anything else is looked at', () => {
  const d = decide(
    item({ type: 'trip_summary', payload: { nonsense: true }, dismissed: true, read: true, subjectGone: true }),
    NOW,
    CATALOG
  );
  assertEquals(d, { kind: 'skip', reason: 'local' });
});

Deno.test('an unknown type and a non-live type are unknown_type', () => {
  assertEquals(reason(decide(item({ type: 'weekly_recap_v9' }), NOW, CATALOG)), 'unknown_type');
  assertEquals(reason(decide(item({ type: 'missed_drive', payload: {} }), NOW, CATALOG)), 'unknown_type');
  assertEquals(reason(decide(item({ type: '__proto__' }), NOW, CATALOG)), 'unknown_type');
});

Deno.test('a payload that fails its schema is bad_payload', () => {
  const d = decide(item({ payload: { permission: 'camera', platform: 'ios', deviceId: 'x' }, dismissed: true }), NOW, CATALOG);
  assertEquals(reason(d), 'bad_payload');
  assertEquals(reason(decide(item({ payload: null }), NOW, CATALOG)), 'bad_payload');
});

Deno.test('dismissed comes before already_read, which comes before subject_gone', () => {
  assertEquals(reason(decide(item({ dismissed: true, read: true, subjectGone: true }), NOW, CATALOG)), 'dismissed');
  assertEquals(reason(decide(item({ read: true, subjectGone: true }), NOW, CATALOG)), 'already_read');
  assertEquals(reason(decide(item({ subjectGone: true, createdAt: NOW - 100 * H }), NOW, CATALOG)), 'subject_gone');
});

Deno.test('a cap-deferred lapse that was fixed meanwhile is dropped as subject_gone (the re-check)', () => {
  // The claim's subject_gone is true when the lapse is no longer current on that device (task 2 §2).
  const d = decide(item({ subjectGone: true, createdAt: NOW - 20 * H }, { localSentToday: 0 }), NOW, CATALOG);
  assertEquals(d, { kind: 'skip', reason: 'subject_gone' });
});

Deno.test('permission_lapsed is stale past its 48 h ttl and not before', () => {
  assertEquals(CATALOG.permission_lapsed.ttlHours, 48);
  assertEquals(reason(decide(item({ createdAt: NOW - 49 * H }), NOW, CATALOG)), 'stale');
  assertEquals(reason(decide(item({ createdAt: NOW - 47 * H }), NOW, CATALOG)), 'send');
});

Deno.test('stale comes before category_off', () => {
  const d = decide(item({ createdAt: NOW - 49 * H }, { categories: { recording: false } }), NOW, CATALOG);
  assertEquals(reason(d), 'stale');
});

Deno.test('a category switched off is category_off; a missing key or true is on', () => {
  assertEquals(reason(decide(item({}, { categories: { recording: false } }), NOW, CATALOG)), 'category_off');
  assertEquals(reason(decide(item({}, { categories: { recording: true, family: false } }), NOW, CATALOG)), 'send');
  assertEquals(reason(decide(item({}, { categories: {} }), NOW, CATALOG)), 'send');
});

Deno.test('no tokens is no_device, and comes before driving', () => {
  const d = decide(item({}, { tokens: [], drivingSince: NOW - 5 * H }), NOW, CATALOG);
  assertEquals(reason(d), 'no_device');
});

Deno.test('driving for 5 h defers by 5 minutes; no driving_since sends', () => {
  const driving = decide(item({}, { drivingSince: NOW - 5 * H }), NOW, CATALOG);
  assertEquals(driving, { kind: 'defer', reason: 'driving', until: NOW + DRIVING_RETRY_MS });
  assertEquals(DRIVING_RETRY_MS, 5 * MIN);
  assertEquals(reason(decide(item({}, { drivingSince: null }), NOW, CATALOG)), 'send');
});

Deno.test('driving comes before quiet hours', () => {
  const at = Date.parse('2026-09-23T06:30:00Z'); // 23:30 PDT
  const d = decide(item({ createdAt: at - MIN }, { drivingSince: at - H }), at, CATALOG);
  assertEquals(reason(d), 'driving');
});

// ——— quiet hours ———

Deno.test('quiet hours 22:00–07:00 Los Angeles: 23:30 and 06:59 defer to 07:00, 07:00 sends', () => {
  const at2330 = Date.parse('2026-09-23T06:30:00Z'); // 23:30 PDT, Sep 22
  const at0659 = Date.parse('2026-09-23T13:59:00Z'); // 06:59 PDT, Sep 23
  const at0700 = Date.parse('2026-09-23T14:00:00Z'); // 07:00 PDT
  const sevenAm = Date.parse('2026-09-23T14:00:00Z');
  assertEquals(decide(item({ createdAt: at2330 - MIN }), at2330, CATALOG), {
    kind: 'defer',
    reason: 'quiet_hours',
    until: sevenAm,
  });
  assertEquals(decide(item({ createdAt: at0659 - MIN }), at0659, CATALOG), {
    kind: 'defer',
    reason: 'quiet_hours',
    until: sevenAm,
  });
  assertEquals(reason(decide(item({ createdAt: at0700 - MIN }), at0700, CATALOG)), 'send');
  // 22:00 is inside (the start is inclusive).
  const at2200 = Date.parse('2026-09-23T05:00:00Z');
  assertEquals(reason(decide(item({ createdAt: at2200 - MIN }), at2200, CATALOG)), 'quiet_hours');
});

Deno.test('DST: a deferral at 23:30 the night before the March shift lands at 07:00 PDT', () => {
  // 2027-03-14 is the second Sunday of March: 02:00 PST → 03:00 PDT.
  const at = Date.parse('2027-03-14T07:30:00Z'); // 23:30 PST, Mar 13
  const d = decide(item({ createdAt: at - MIN }), at, CATALOG);
  assertEquals(d, { kind: 'defer', reason: 'quiet_hours', until: Date.parse('2027-03-14T14:00:00Z') });
});

Deno.test('DST: a deferral at 23:30 the night before the November shift lands at 07:00 PST', () => {
  // 2026-11-01 is the first Sunday of November: 02:00 PDT → 01:00 PST.
  const at = Date.parse('2026-11-01T06:30:00Z'); // 23:30 PDT, Oct 31
  const d = decide(item({ createdAt: at - MIN }), at, CATALOG);
  assertEquals(d, { kind: 'defer', reason: 'quiet_hours', until: Date.parse('2026-11-01T15:00:00Z') });
});

Deno.test('quiet hours with start = end are off, and disabled quiet hours are off', () => {
  const at2330 = Date.parse('2026-09-23T06:30:00Z');
  const same = item({ createdAt: at2330 - MIN }, { quiet: { enabled: true, start: '22:00', end: '22:00' } });
  assertEquals(reason(decide(same, at2330, CATALOG)), 'send');
  const off = item({ createdAt: at2330 - MIN }, { quiet: { enabled: false, start: '22:00', end: '07:00' } });
  assertEquals(reason(decide(off, at2330, CATALOG)), 'send');
});

Deno.test('quiet hours inside one day (13:00–15:00) defer to 15:00 the same day', () => {
  const at = Date.parse('2026-09-22T21:00:00Z'); // 14:00 PDT
  const d = decide(item({ createdAt: at - MIN }, { quiet: { enabled: true, start: '13:00', end: '15:00' } }), at, CATALOG);
  assertEquals(d, { kind: 'defer', reason: 'quiet_hours', until: Date.parse('2026-09-22T22:00:00Z') });
});

Deno.test('quiet hours follow ctx.tz, and a zone Intl does not know falls back to the default zone', () => {
  const at = Date.parse('2026-09-22T21:30:00Z'); // 23:30 in Paris (CEST), 14:30 in Los Angeles
  const paris = decide(item({ createdAt: at - MIN }, { tz: 'Europe/Paris' }), at, CATALOG);
  assertEquals(paris, { kind: 'defer', reason: 'quiet_hours', until: Date.parse('2026-09-23T05:00:00Z') });
  assertEquals(DEFAULT_TZ, 'America/Los_Angeles');
  const unknown = decide(item({ createdAt: at - MIN }, { tz: 'Mars/Olympus_Mons' }), at, CATALOG);
  assertEquals(reason(unknown), 'send'); // 14:30 in the default zone
  assertEquals(inQuietHours(at, 'Mars/Olympus_Mons', { enabled: true, start: '14:00', end: '15:00' }), true);
});

// ——— windows ———

/** A catalog where permission_lapsed carries a window, to exercise the rule no live type uses yet. */
const withWindow = (start: string, end: string): Catalog => {
  const c = buildCatalog(true);
  return { ...c, permission_lapsed: { ...c.permission_lapsed, window: { start, end } } };
};

Deno.test('a window crossing midnight (21:00–02:00): inside at 23:00 and 01:30 sends, outside defers to 21:00', () => {
  const noQuiet = { quiet: { enabled: false, start: '22:00', end: '07:00' } };
  const cat = withWindow('21:00', '02:00');
  const at2300 = Date.parse('2026-09-23T06:00:00Z');
  const at0130 = Date.parse('2026-09-23T08:30:00Z');
  const at0200 = Date.parse('2026-09-23T09:00:00Z');
  assertEquals(reason(decide(item({ createdAt: at2300 - MIN }, noQuiet), at2300, cat)), 'send');
  assertEquals(reason(decide(item({ createdAt: at0130 - MIN }, noQuiet), at0130, cat)), 'send');
  assertEquals(decide(item({ createdAt: at0200 - MIN }, noQuiet), at0200, cat), {
    kind: 'defer',
    reason: 'window',
    until: Date.parse('2026-09-24T04:00:00Z'), // 21:00 PDT, Sep 23
  });
  // Noon: outside, deferred to 21:00 the same day.
  assertEquals(decide(item({}, noQuiet), NOW, cat), { kind: 'defer', reason: 'window', until: Date.parse('2026-09-23T04:00:00Z') });
});

Deno.test('quiet hours come before the window', () => {
  const at = Date.parse('2026-09-23T06:30:00Z'); // 23:30 PDT
  const d = decide(item({ createdAt: at - MIN }), at, withWindow('08:00', '11:00'));
  assertEquals(reason(d), 'quiet_hours');
});

// ——— weekly limit ———

Deno.test('a weekly limit counts the type in the last 7 days', () => {
  const c = buildCatalog(true);
  const cat: Catalog = { ...c, permission_lapsed: { ...c.permission_lapsed, weeklyLimit: 1 } };
  const within = item({}, { recent: [{ type: 'permission_lapsed', pushedAt: NOW - 6 * 24 * H }] });
  assertEquals(reason(decide(within, NOW, cat)), 'weekly_limit');
  const outside = item({}, { recent: [{ type: 'permission_lapsed', pushedAt: NOW - 8 * 24 * H }] });
  assertEquals(reason(decide(outside, NOW, cat)), 'send');
});

// ——— the daily cap ———

Deno.test('cap: two local sends today and no server sends → capped (a lapse is deferred to the next day, never dropped)', () => {
  const d = decide(item({}, { localSentToday: 2 }), NOW, CATALOG);
  // 00:00 Sep 23 is inside quiet hours, so the next day's first slot is 07:00 PDT.
  assertEquals(d, { kind: 'defer', reason: 'capped', until: Date.parse('2026-09-23T14:00:00Z') });
});

Deno.test('cap: one local send and one server send today → capped', () => {
  const today = item({}, { localSentToday: 1, recent: [{ type: 'permission_lapsed', pushedAt: NOW - 2 * H }] });
  assertEquals(reason(decide(today, NOW, CATALOG)), 'capped');
  // A server send yesterday (local) does not count: 23:00 PDT on Sep 21.
  const yesterday = item(
    {},
    { localSentToday: 1, recent: [{ type: 'permission_lapsed', pushedAt: Date.parse('2026-09-22T06:00:00Z') }] }
  );
  assertEquals(reason(decide(yesterday, NOW, CATALOG)), 'send');
});

Deno.test('cap: a family-class send is not counted', () => {
  const d = decide(
    item(
      {},
      {
        localSentToday: 1,
        recent: [
          { type: 'family_membership', pushedAt: NOW - H },
          { type: 'family_digest', pushedAt: NOW - 2 * H },
          { type: 'family_sharing_changed', pushedAt: NOW - 3 * H },
        ],
      }
    ),
    NOW,
    CATALOG
  );
  assertEquals(reason(d), 'send');
});

Deno.test('cap: an unknown type in recent counts (the conservative reading)', () => {
  const d = decide(item({}, { localSentToday: 1, recent: [{ type: 'something_new', pushedAt: NOW - H }] }), NOW, CATALOG);
  assertEquals(reason(d), 'capped');
});

Deno.test('cap: with quiet hours off, the next day first slot is local midnight', () => {
  const d = decide(item({}, { localSentToday: 2, quiet: { enabled: false, start: '22:00', end: '07:00' } }), NOW, CATALOG);
  assertEquals(d, { kind: 'defer', reason: 'capped', until: Date.parse('2026-09-23T07:00:00Z') });
});

Deno.test('cap: only a lapse is carried to the next day; any other capped type is skipped', () => {
  // No other pushed type has copy yet (renderPush), so the skip path is pinned through the rule.
  assertEquals(DEFER_WHEN_CAPPED, ['permission_lapsed']);
  const q = { enabled: true, start: '22:00', end: '07:00' };
  assertEquals(cappedDecision('streak_milestone', NOW, 'America/Los_Angeles', q, undefined), {
    kind: 'skip',
    reason: 'capped',
  });
  assertEquals(cappedDecision('permission_lapsed', NOW, 'America/Los_Angeles', q, undefined), {
    kind: 'defer',
    reason: 'capped',
    until: Date.parse('2026-09-23T14:00:00Z'),
  });
});

Deno.test('promo: at most one in 7 days', () => {
  const c = buildCatalog(true);
  const cat: Catalog = { ...c, permission_lapsed: { ...c.permission_lapsed, capClass: 'promo' } };
  const d = decide(item({}, { recent: [{ type: 'transparency_reminder', pushedAt: NOW - 6 * 24 * H }] }), NOW, cat);
  assertEquals(reason(d), 'capped');
  const old = decide(item({}, { recent: [{ type: 'transparency_reminder', pushedAt: NOW - 8 * 24 * H }] }), NOW, cat);
  assertEquals(reason(old), 'send');
});

Deno.test('the cap reads countsTowardDailyCap: with drive summaries transactional nothing else changes', () => {
  // buildCatalog(false) makes trip_summary transactional; a lapse still counts.
  const d = decide(item({}, { localSentToday: 2 }), NOW, buildCatalog(false));
  assertEquals(reason(d), 'capped');
});

Deno.test('batch: one slot left and two items → one send, one capped', () => {
  const a = item({ payload: { permission: 'location_always', platform: 'ios', deviceId: 'phone-a' } }, { localSentToday: 1 });
  const b = item({ payload: { permission: 'motion', platform: 'ios', deviceId: 'phone-a' } }, { localSentToday: 1 });
  const [da, db] = decideBatch([a, b], NOW, CATALOG);
  assertEquals(reason(da), 'send');
  assertEquals(reason(db), 'capped');
});

Deno.test('batch: another user does not use up this user\'s slots', () => {
  const a = item({}, { localSentToday: 1 });
  const b = item({ userId: '22222222-2222-4222-8222-222222222222' }, { localSentToday: 1 });
  assertEquals(decideBatch([a, b], NOW, CATALOG).map(reason), ['send', 'send']);
});

Deno.test('batch: a deferred or skipped item uses no slot', () => {
  const skipped = item({ read: true }, { localSentToday: 1 });
  const sent = item({ payload: { permission: 'motion', platform: 'ios', deviceId: 'phone-b' } }, { localSentToday: 1 });
  assertEquals(decideBatch([skipped, sent], NOW, CATALOG).map(reason), ['already_read', 'send']);
});

// ——— one lapse, one push (T2 r1 n3) ———

Deno.test('batch: a cap-deferred lapse and a fresh lapse of the same device and kind → only the fresh one is sent', () => {
  const deferred = item({ createdAt: NOW - 20 * H });
  const fresh = item({ createdAt: NOW - MIN });
  const out = decideBatch([deferred, fresh], NOW, CATALOG);
  assertEquals(out.map(reason), ['subject_gone', 'send']);
  // Order in the batch does not matter.
  assertEquals(decideBatch([fresh, deferred], NOW, CATALOG).map(reason), ['send', 'subject_gone']);
});

Deno.test('batch: a lapse of another kind or another device is not a duplicate', () => {
  const a = item({ createdAt: NOW - 20 * H });
  const otherKind = item({ payload: { permission: 'motion', platform: 'ios', deviceId: 'phone-a' } });
  const otherDevice = item({ payload: { permission: 'location_always', platform: 'ios', deviceId: 'phone-b' } });
  assertEquals(decideBatch([a, otherKind], NOW, CATALOG).map(reason), ['send', 'send']);
  assertEquals(decideBatch([a, otherDevice], NOW, CATALOG).map(reason), ['send', 'send']);
});

Deno.test('a lapse raised before a lapse push already delivered resolves subject_gone (the fresh one went first)', () => {
  const deferred = item({ createdAt: NOW - 20 * H }, { recent: [{ type: 'permission_lapsed', pushedAt: NOW - H }] });
  assertEquals(decide(deferred, NOW, CATALOG), { kind: 'skip', reason: 'subject_gone' });
  // A lapse raised after that push is a new one.
  const later = item({ createdAt: NOW - 30 * MIN }, { recent: [{ type: 'permission_lapsed', pushedAt: NOW - H }] });
  assertEquals(reason(decide(later, NOW, CATALOG)), 'send');
});

// ——— send ———

Deno.test('send carries every token and the rendered message, and nothing else', () => {
  const tokens = [TOKEN, 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]'];
  const it = item({}, { tokens });
  const d = decide(it, NOW, CATALOG);
  assertEquals(d, {
    kind: 'send',
    tokens,
    message: {
      title: 'Automatic recording is off',
      body: "RoadWise can't start drives on its own right now. Tap to fix it.",
      data: { inboxId: it.inboxId, url: '/permissions' },
      sound: 'default',
      priority: 'default',
      channelId: 'recording_problems',
    },
  });
});

Deno.test('lock-screen copy names no person, place or drive detail, and carries only the inbox id and url', () => {
  // T10 security note: a push shows on a lock screen and can reach a phone just after a handover.
  for (const permission of ['location_always', 'location', 'motion']) {
    for (const platform of ['ios', 'android']) {
      const deviceId = `Julian's iPhone 5th Ave ${permission}`;
      const d = decide(item({ payload: { permission, platform, deviceId } }), NOW, CATALOG);
      assert(d.kind === 'send');
      const shown = `${d.message.title} ${d.message.body}`;
      assert(!shown.includes('Julian') && !shown.includes('5th Ave') && !shown.includes(platform), shown);
      assert(!/\d/.test(shown), `no numbers (distance, time, place) on the lock screen: ${shown}`);
      assertEquals(Object.keys(d.message.data).sort(), ['inboxId', 'url']);
      assertEquals(d.message.data.url, '/permissions');
    }
  }
});

// ——— the zoned helpers ———

Deno.test('localDate follows the zone across midnight', () => {
  assertEquals(localDate(Date.parse('2026-09-23T06:30:00Z'), 'America/Los_Angeles'), '2026-09-22');
  assertEquals(localDate(Date.parse('2026-09-23T06:30:00Z'), 'Europe/Paris'), '2026-09-23');
});

Deno.test('firstSlotAfter skips a spring-forward gap and quiet hours', () => {
  const q = { enabled: true, start: '22:00', end: '07:00' };
  const slot = firstSlotAfter(Date.parse('2027-03-13T20:00:00Z'), 'America/Los_Angeles', q, undefined);
  assertEquals(slot, Date.parse('2027-03-14T14:00:00Z'));
  assert(slot > Date.parse('2027-03-13T20:00:00Z'));
});
