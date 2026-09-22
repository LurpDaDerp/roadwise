import type { PermissionSnapshot } from '@/core/permissions';
import { eventRow, MILE_M, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { toTripEventView, type TripEventView } from '@/data/queries/rows';
import type { TripRow } from '@/data/db/types';
import { inboxCopy } from '@/features/inbox/copy';
import {
  countServerPushesToday,
  toItemView,
  toTripDetail,
  type InboxItemView,
} from '@/features/inbox/viewModel';
import { tripSummaryHref } from '@/features/trips/routes';
import { buildCatalog } from '@/notifications/catalog';

import { inboxRow, iso, lapseRow, nextId } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const TZ = 'UTC';
const NOW = T0 + 60 * 60_000;

const onPhone = (over: Partial<TripRow> = {}, events: TripEventView[] = []) => ({
  trip: toTripDetail(tripRow(over), 1),
  events,
});
const missing = { trip: null, events: [] };

/** Every string the row renders or speaks. */
const strings = (v: InboxItemView | null): string[] =>
  v === null ? [] : [v.title, v.body, v.dispute ?? '', v.note ?? '', v.when, v.accessibilityLabel];

describe('toItemView — a drive on this phone renders from its CURRENT state', () => {
  it('a payload saying roleUnknown: true for a drive now marked driver renders "Drive summary ready"', () => {
    const row = inboxRow({ payload: { ...inboxRow().payload, roleUnknown: true } });
    const v = toItemView(row, onPhone({ role: 'driver', distance_m: 3.2 * MILE_M }), NOW, TZ);
    expect(v?.title).toBe('Drive summary ready');
    expect(v?.body).toBe('Your 3.2 mi drive is ready. Tap to see how it went.');
    expect(v?.href).toEqual(tripSummaryHref('trip-1'));
    expect(v?.note).toBeNull();
  });

  it('a drive whose role is now unknown asks "Were you driving?", promising a score only if it would score', () => {
    const scorable = toItemView(inboxRow(), onPhone({ role: 'unknown', status: 'unscored', score: null }), NOW, TZ);
    expect(scorable?.title).toBe('Were you driving?');
    expect(scorable?.body).toBe('Tell us who drove your 10 mi trip so it can be scored.');

    const gradeC = toItemView(
      inboxRow({ payload: { ...inboxRow().payload, scorableIfDriver: true } }),
      onPhone({ role: 'unknown', status: 'unscored', score: null, data_quality: 'C' }),
      NOW,
      TZ
    );
    expect(gradeC?.body).toBe('Tell us who drove your 10 mi trip.');
  });

  it('a drive re-scored to unscored renders no "scored" wording', () => {
    const tooShort = toItemView(
      inboxRow(),
      onPhone({ role: 'unknown', status: 'unscored', score: null, distance_m: 300, duration_s: 60 }),
      NOW,
      TZ
    );
    const driverUnscored = toItemView(
      inboxRow(),
      onPhone({ role: 'driver', status: 'unscored', score: null, data_quality: 'C' }),
      NOW,
      TZ
    );
    for (const v of [tooShort, driverUnscored]) {
      expect(v).not.toBeNull();
      for (const s of strings(v)) expect(s).not.toMatch(/scored/i);
    }
  });

  it('the distance is the drive’s current distance, not the payload’s', () => {
    const v = toItemView(inboxRow(), onPhone({ distance_m: 25 * MILE_M }), NOW, TZ);
    expect(v?.body).toContain('25 mi');
  });

  it('a deleted drive says so, with no link', () => {
    const v = toItemView(inboxRow(), onPhone({ deleted_at: T0 + 1000 }), NOW, TZ);
    expect(v?.body).toBe('You deleted this drive.');
    expect(v?.href).toBeNull();
    const synced = toItemView(inboxRow(), { trip: null, events: [], deleted: true }, NOW, TZ);
    expect(synced?.body).toBe('You deleted this drive.');
    expect(synced?.href).toBeNull();
  });

  it('adds one line from a dispute outcome the server settled', () => {
    const disputed = (outcome: string, extra: Record<string, unknown> = {}) =>
      toTripEventView(
        eventRow({
          id: nextId(),
          dispute_json: JSON.stringify({ reason: 'wrong_limit', submittedAt: T0, outcome, ...extra }),
        })
      );
    const line = (events: TripEventView[]) => toItemView(inboxRow(), onPhone({}, events), NOW, TZ)?.dispute;
    expect(line([disputed('accepted', { decidedAt: T0 + 5 })])).toBe(inboxCopy.dispute.reportAccepted);
    expect(line([disputed('denied', { decidedAt: T0 + 5 })])).toBe(inboxCopy.dispute.reportRecorded);
    expect(line([disputed('queued')])).toBe(inboxCopy.dispute.reportSending);
    expect(line([disputed('window_closed', { decidedAt: T0 + 5 })])).toBe(inboxCopy.dispute.reportClosed);
    expect(line([toTripEventView(eventRow())])).toBeNull();
    // The newest decision is the one told.
    expect(
      line([disputed('accepted', { decidedAt: T0 + 5 }), disputed('denied', { decidedAt: T0 + 9 })])
    ).toBe(inboxCopy.dispute.reportRecorded);
  });

  it('shows no score anywhere', () => {
    const scored = tripRow({ score: 87 });
    const views = [
      toItemView(inboxRow(), { trip: toTripDetail(scored, 1), events: [] }, NOW, TZ),
      toItemView(inboxRow(), onPhone({ role: 'unknown', score: 64 }), NOW, TZ),
      toItemView(inboxRow(), missing, NOW, TZ),
    ];
    for (const v of views) {
      for (const s of strings(v)) {
        expect(s).not.toMatch(/\b(87|64)\b/);
        expect(s).not.toMatch(/excellent|good|getting there|needs focus|points/i);
      }
    }
  });
});

describe('toItemView — not on this phone', () => {
  it('uses the payload’s facts and date, says so, links nowhere — and asks for nothing (review m1)', () => {
    const payload = { ...inboxRow().payload, distanceM: 2 * MILE_M };
    const asked = toItemView(
      inboxRow({ payload: { ...payload, roleUnknown: true, scorableIfDriver: true } }),
      missing,
      NOW,
      TZ
    );
    const ready = toItemView(inboxRow({ payload: { ...payload, roleUnknown: false } }), missing, NOW, TZ);
    const tiny = toItemView(inboxRow({ payload: { ...payload, distanceM: 10 } }), missing, NOW, TZ);
    for (const v of [asked, ready]) {
      expect(v?.title).toBe(inboxCopy.elsewhere.title);
      expect(v?.body).toBe('A 2.0 mi trip on your account.');
      expect(v?.note).toBe(inboxCopy.notOnPhone);
      expect(v?.href).toBeNull();
      expect(v?.when).toContain('Today');
    }
    expect(tiny?.body).toBe(inboxCopy.elsewhere.bodyNoDistance);
    for (const v of [asked, ready, tiny]) {
      expect(`${v?.title} ${v?.body}`).not.toMatch(/tap|tell us|scored|\?/i);
    }
  });
});

describe('toItemView — other types', () => {
  it('a permission lapse opens B2 (with no reading here it says only what was true that day)', () => {
    const v = toItemView(lapseRow(), missing, NOW, TZ);
    expect(v?.title).toBe('Automatic recording was off');
    expect(v?.href).toBe('/permissions');
    expect(v?.note).toBeNull();
  });

  it('unknown, non-live and malformed rows render nothing', () => {
    expect(toItemView(inboxRow({ type: 'streak_milestone' }), missing, NOW, TZ)).toBeNull();
    expect(toItemView(inboxRow({ type: 'something_new' }), missing, NOW, TZ)).toBeNull();
    expect(toItemView(inboxRow({ payload: { clientTripId: 'trip-1' } }), missing, NOW, TZ)).toBeNull();
    expect(toItemView(lapseRow({ payload: { permission: 'camera' } }), missing, NOW, TZ)).toBeNull();
  });

  it('read state and the spoken label: unread is said in words, not colour', () => {
    const unread = toItemView(inboxRow(), onPhone(), NOW, TZ);
    const read = toItemView(inboxRow({ read_at: iso(T0) }), onPhone(), NOW, TZ);
    expect(unread?.unread).toBe(true);
    expect(unread?.accessibilityLabel.startsWith('Unread. ')).toBe(true);
    expect(read?.unread).toBe(false);
    expect(read?.accessibilityLabel.startsWith('Unread')).toBe(false);
  });

  it('dates: today, yesterday, then the weekday and date', () => {
    const at = (ms: number) =>
      toItemView(inboxRow(), onPhone({ started_at: ms, ended_at: ms + 1000 }), NOW, TZ)?.when;
    expect(at(T0)).toMatch(/^Today · 12:00 PM$/);
    expect(at(T0 - 86_400_000)).toMatch(/^Yesterday · /);
    expect(at(T0 - 3 * 86_400_000)).toMatch(/^Fri, Jan 2 · /);
  });
});

describe('countServerPushesToday', () => {
  const LA = 'America/Los_Angeles';
  // NOW_LA = T0 = 04:00 in Los Angeles on Monday 5 January.
  const pushed = (ms: number | null, type = 'permission_lapsed') =>
    inboxRow({ id: nextId(), type, pushed_at: ms === null ? null : iso(ms) });

  it('counts rows pushed in the user’s local day whose type counts toward the cap', () => {
    const rows = [
      pushed(T0 - 60 * 60_000), // 03:00 LA today
      pushed(T0 - 3.5 * 60 * 60_000), // 00:30 LA today
      pushed(T0 - 5 * 60 * 60_000), // 23:00 LA yesterday
      pushed(null), // never pushed
      pushed(T0 - 60_000, 'family_digest'), // family: exempt
    ];
    expect(countServerPushesToday(rows, LA, T0)).toBe(2);
    // The same rows in UTC: 12:00 on the 5th, so 23:00 LA (07:00 UTC) is today there.
    expect(countServerPushesToday(rows, 'UTC', T0)).toBe(3);
  });

  it('decides the cap only through the catalog: a transactional summary is not counted', () => {
    const rows = [pushed(T0 - 60_000, 'trip_summary')];
    expect(countServerPushesToday(rows, LA, T0, buildCatalog(true))).toBe(1);
    expect(countServerPushesToday(rows, LA, T0, buildCatalog(false))).toBe(0);
  });

  it('counts a type this build does not know (the cautious answer for a cap)', () => {
    expect(countServerPushesToday([pushed(T0 - 60_000, 'future_type')], LA, T0)).toBe(1);
  });

  it('counts dismissed rows too: a push that arrived still arrived', () => {
    const row = { ...pushed(T0 - 60_000), dismissed_at: iso(T0) };
    expect(countServerPushesToday([row], LA, T0)).toBe(1);
  });
});

describe('toItemView — a permission lapse renders from the phone’s CURRENT permissions (ruling T6 (1))', () => {
  const snap = (over: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
    platform: 'ios',
    location: 'foreground',
    precise: true,
    locationCanAskAgain: false,
    motion: 'granted',
    notifications: 'granted',
    notificationsCanAskAgain: false,
    batteryOptimization: 'unknown',
    lowPowerMode: false,
    checkedAt: T0,
    ...over,
  });
  const here = (over: Partial<PermissionSnapshot> = {}) => ({
    trip: null,
    events: [],
    permissions: { deviceId: 'dev-1', snapshot: snap(over) },
  });
  const lapse = (permission: string) =>
    lapseRow({ payload: { permission, platform: 'ios', deviceId: 'dev-1' } });

  it('still lapsed → present tense, as pushed', () => {
    const v = toItemView(lapse('location_always'), here({ location: 'foreground' }), NOW, TZ);
    expect(v?.title).toBe('Automatic recording is off');
    expect(v?.body).toBe("RoadWise can't start drives on its own right now. Tap to fix it.");
    expect(v?.href).toBe('/permissions');
  });

  it('fixed since → past tense, and says it is back on', () => {
    const always = toItemView(lapse('location_always'), here({ location: 'always' }), NOW, TZ);
    expect(always?.title).toBe('Automatic recording is back on');
    expect(always?.body).toBe("Automatic recording was off on Mon, Jan 5. It's back on.");
    const location = toItemView(lapse('location'), here({ location: 'foreground' }), NOW, TZ);
    expect(location?.body).toBe("Drive recording was off on Mon, Jan 5. It's back on.");
    const motion = toItemView(lapse('motion'), here({ motion: 'granted' }), NOW, TZ);
    expect(motion?.body).toBe("Motion access was off on Mon, Jan 5. It's back on.");
    for (const v of [always, location, motion]) expect(v?.body).not.toMatch(/fix it|right now/);
  });

  it('cannot be read → neither: neutral copy about that day only', () => {
    const cases = [
      toItemView(lapse('location_always'), missing, NOW, TZ), // no reading at all
      toItemView(lapse('location_always'), { trip: null, events: [], permissions: { deviceId: 'dev-1', snapshot: null } }, NOW, TZ),
      toItemView(lapse('motion'), here({ motion: null }), NOW, TZ), // motion "can't check"
      toItemView(
        lapse('location_always'),
        { trip: null, events: [], permissions: { deviceId: 'other-phone', snapshot: snap({ location: 'always' }) } },
        NOW,
        TZ
      ), // the lapse was on another phone
    ];
    expect(cases[0]?.title).toBe('Automatic recording was off');
    expect(cases[0]?.body).toBe('On Mon, Jan 5, automatic recording was off. Open to check how it is now.');
    expect(cases[2]?.title).toBe('Drive detection needed attention');
    for (const v of cases) {
      expect(v).not.toBeNull();
      expect(`${v?.title} ${v?.body}`).not.toMatch(/\bis off\b|back on|right now|fix it/);
    }
  });
});
