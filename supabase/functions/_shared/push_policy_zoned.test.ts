// push-sender's half of the zoned-time golden table (T7 review n2). The phone's local delivery plan
// runs the same JSON (src/notifications/__tests__/localDelivery.test.ts), so a fix to one side's
// quiet-hours or local-day arithmetic that misses the other fails here or there.
import { assertEquals } from '@std/assert';
import { CATALOG } from './catalog.ts';
import { decide, inQuietHours, localDate, type PushItem } from './push_policy.ts';
import golden from './testing/zoned_golden.json' with { type: 'json' };

const MIN = 60_000;
const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

/** A lapse push due at `t` with nothing else holding it back: only quiet hours can defer it. */
function lapseAt(t: number, tz: string, quiet: PushItem['ctx']['quiet']): PushItem {
  return {
    inboxId: '00000000-0000-4000-8000-000000000001',
    userId: '11111111-1111-4111-8111-111111111111',
    type: 'permission_lapsed',
    payload: { permission: 'location_always', platform: 'ios', deviceId: 'phone-a' },
    createdAt: t - 10 * MIN,
    read: false,
    dismissed: false,
    subjectGone: false,
    ctx: { tz, quiet, categories: {}, drivingSince: null, recent: [], localSentToday: 0, tokens: [TOKEN] },
  };
}

Deno.test('the golden table has cases', () => {
  assertEquals(golden.quiet.length > 10 && golden.day.length > 10, true);
});

for (const c of golden.quiet) {
  Deno.test(`golden quiet: ${c.name}`, () => {
    const t = Date.parse(c.t);
    assertEquals(inQuietHours(t, c.tz, c.quiet), c.in);
    const d = decide(lapseAt(t, c.tz, c.quiet), t, CATALOG);
    if (c.deferTo === null) assertEquals(d.kind, 'send');
    else assertEquals(d, { kind: 'defer', reason: 'quiet_hours', until: Date.parse(c.deferTo) });
  });
}

for (const c of golden.day) {
  Deno.test(`golden day: ${c.t} in ${c.tz}`, () => {
    assertEquals(localDate(Date.parse(c.t), c.tz), c.day);
  });
}
