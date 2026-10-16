/**
 * The permission registry: each permission's state from one read of the phone (design §3.1), one
 * case per branch, on both platforms.
 */
import type { TripReminderStatus } from '@drive-sense';

import type { PermissionSnapshot } from '@/core/permissions';

import { snap } from '../__fixtures__/harness';
import { PERMISSIONS, permissionDef, REMINDER_CHANNEL_ID, signature, type PermissionBoardRead, type PermissionId, type PermState } from '../registry';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node typings
const { readFileSync } = require('node:fs') as { readFileSync: (file: string, encoding: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const reminder = (over: Partial<TripReminderStatus> = {}): TripReminderStatus => ({ enabled: true, state: 'on', missing: [], ...over });

function board(over: Partial<PermissionSnapshot> = {}, rest: Partial<Omit<PermissionBoardRead, 'snapshot'>> = {}): PermissionBoardRead {
  const snapshot = snap(over);
  return {
    snapshot,
    androidApi: snapshot.platform === 'android' ? 34 : null,
    paired: false,
    bluetooth: null,
    camera: null,
    reminder: null,
    ...rest,
  };
}

const state = (id: PermissionId, read: PermissionBoardRead): PermState => permissionDef(id).state(read);
const missing = (reason: string, canAsk: boolean, target = 'app') => ({ kind: 'missing', reason, canAsk, target });

test('every permission has a unique order; only the camera has no Home row; location and precise are required', () => {
  const orders = PERMISSIONS.map((d) => d.order);
  expect(new Set(orders).size).toBe(orders.length);
  expect(PERMISSIONS.map((d) => d.id)).toEqual(['location', 'precise', 'motion', 'notifications', 'reminderAccess', 'bluetooth', 'camera']);
  expect(PERMISSIONS.filter((d) => !d.homeRow).map((d) => d.id)).toEqual(['camera']);
  expect(PERMISSIONS.filter((d) => d.need === 'required').map((d) => d.id)).toEqual(['location', 'precise']);
  for (const d of PERMISSIONS) expect(d.platforms).toEqual(['ios', 'android']);
});

describe('location', () => {
  it('granted While Using or Always', () => {
    expect(state('location', board({ location: 'foreground' }))).toEqual({ kind: 'granted' });
    expect(state('location', board({ location: 'always' }))).toEqual({ kind: 'granted' });
  });

  it('not asked yet / denied, asking again only while the phone still can', () => {
    expect(state('location', board({ location: 'undetermined', precise: null }))).toEqual(missing('notYet', true));
    expect(state('location', board({ location: 'denied', precise: null, locationCanAskAgain: true }))).toEqual(missing('denied', true));
    expect(state('location', board({ location: 'denied', precise: null, locationCanAskAgain: false }))).toEqual(missing('denied', false));
  });

  it("Location Services off beats a granted permission: Android asks with Play services' dialog, then its Location page; iOS has only the app's page", () => {
    expect(state('location', board({ platform: 'android', locationServices: false }))).toEqual(missing('servicesOff', true, 'locationServices'));
    expect(state('location', board({ platform: 'ios', locationServices: false, location: 'denied' }))).toEqual(missing('servicesOff', false, 'app'));
  });

  it('a switch that could not be read never makes a row', () => {
    expect(state('location', board({ locationServices: null }))).toEqual({ kind: 'granted' });
  });
});

describe('precise', () => {
  it('idle while location is off or Location Services are off (the location row covers it)', () => {
    expect(state('precise', board({ location: 'denied', precise: null }))).toEqual({ kind: 'idle' });
    expect(state('precise', board({ locationServices: false, precise: false }))).toEqual({ kind: 'idle' });
  });

  it('granted; unknown when the accuracy cannot be read', () => {
    expect(state('precise', board({ precise: true }))).toEqual({ kind: 'granted' });
    expect(state('precise', board({ precise: null }))).toEqual({ kind: 'unknown' });
  });

  it("approximate: Android 12+ asks again (its change-to-precise dialog); Android 11 and iOS only in Settings", () => {
    expect(state('precise', board({ platform: 'android', precise: false }, { androidApi: 31 }))).toEqual(missing('denied', true));
    expect(state('precise', board({ platform: 'android', precise: false, locationCanAskAgain: false }, { androidApi: 33 }))).toEqual(missing('denied', true));
    expect(state('precise', board({ platform: 'android', precise: false }, { androidApi: 30 }))).toEqual(missing('denied', false));
    expect(state('precise', board({ platform: 'ios', precise: false }))).toEqual(missing('denied', false));
  });
});

describe('motion', () => {
  it('granted / not asked / denied (Android may still ask once) / unavailable or unreadable', () => {
    expect(state('motion', board({ motion: 'granted' }))).toEqual({ kind: 'granted' });
    expect(state('motion', board({ motion: 'undetermined' }))).toEqual(missing('notYet', true));
    expect(state('motion', board({ platform: 'android', motion: 'denied' }))).toEqual(missing('denied', true));
    expect(state('motion', board({ platform: 'ios', motion: 'denied' }))).toEqual(missing('denied', false));
    expect(state('motion', board({ motion: 'unavailable' }))).toEqual({ kind: 'unknown' });
    expect(state('motion', board({ motion: null }))).toEqual({ kind: 'unknown' });
  });
});

describe('notifications', () => {
  it('granted or provisional is on; otherwise asking again only while the phone can', () => {
    expect(state('notifications', board({ notifications: 'granted' }))).toEqual({ kind: 'granted' });
    expect(state('notifications', board({ notifications: 'provisional' }))).toEqual({ kind: 'granted' });
    expect(state('notifications', board({ notifications: 'undetermined', notificationsCanAskAgain: true }))).toEqual(missing('notYet', true));
    expect(state('notifications', board({ notifications: 'denied', notificationsCanAskAgain: true }))).toEqual(missing('denied', true));
    expect(state('notifications', board({ notifications: 'denied', notificationsCanAskAgain: false }))).toEqual(missing('denied', false));
  });
});

describe("the reminder's need", () => {
  it('no reminder module: unknown; reminder off: idle; unavailable phone: unknown', () => {
    expect(state('reminderAccess', board({}, { reminder: null }))).toEqual({ kind: 'unknown' });
    expect(state('reminderAccess', board({}, { reminder: reminder({ enabled: false, state: 'off' }) }))).toEqual({ kind: 'idle' });
    expect(state('reminderAccess', board({}, { reminder: reminder({ enabled: false, state: 'unavailable' }) }))).toEqual({ kind: 'idle' });
    expect(state('reminderAccess', board({}, { reminder: reminder({ state: 'unavailable' }) }))).toEqual({ kind: 'unknown' });
  });

  it('iOS with location denied and the reminder on: only the location row (no duplicate)', () => {
    const read = board({ platform: 'ios', location: 'denied', precise: null }, { reminder: reminder({ state: 'needs', missing: ['locationAlways'] }) });
    expect(state('reminderAccess', read)).toEqual({ kind: 'idle' });
    expect(state('location', read).kind).toBe('missing');
  });

  it('iOS kept at While Using: missing, Settings only; Always: granted', () => {
    expect(state('reminderAccess', board({ platform: 'ios', location: 'foreground' }, { reminder: reminder({ state: 'needs', missing: ['locationAlways'] }) }))).toEqual(
      missing('denied', false)
    );
    expect(state('reminderAccess', board({ platform: 'ios', location: 'always' }, { reminder: reminder() }))).toEqual({ kind: 'granted' });
  });

  it('iOS reads that disagree (the reminder needs nothing, location still While Using): unknown', () => {
    expect(state('reminderAccess', board({ platform: 'ios', location: 'foreground' }, { reminder: reminder() }))).toEqual({ kind: 'unknown' });
  });

  it("Android: only its own channel switched off is this row, opening the channel's page", () => {
    expect(state('reminderAccess', board({ platform: 'android' }, { reminder: reminder({ state: 'needs', missing: ['notifications'] }) }))).toEqual(
      missing('denied', false, 'reminderChannel')
    );
  });

  it("Android: app-wide notifications off is only the notifications row; motion or precise needs aren't repeated", () => {
    const off = board({ platform: 'android', notifications: 'denied' }, { reminder: reminder({ state: 'needs', missing: ['notifications'] }) });
    expect(state('reminderAccess', off)).toEqual({ kind: 'granted' });
    expect(state('notifications', off).kind).toBe('missing');
    expect(state('reminderAccess', board({ platform: 'android', motion: 'denied' }, { reminder: reminder({ state: 'needs', missing: ['motion'] }) }))).toEqual({
      kind: 'granted',
    });
    expect(state('reminderAccess', board({ platform: 'ios', location: 'always', precise: false }, { reminder: reminder({ state: 'needs', missing: ['locationPrecise'] }) }))).toEqual({
      kind: 'granted',
    });
  });
});

describe('Bluetooth (paired DashPal only)', () => {
  it('no pairing: idle on both platforms, even after an abandoned setup (btOptIn plays no part)', () => {
    for (const platform of ['ios', 'android'] as const) {
      expect(state('bluetooth', board({ platform }, { paired: false, bluetooth: 'denied' }))).toEqual({ kind: 'idle' });
    }
  });

  it('Android 11 and lower: idle (location covers the scan)', () => {
    expect(state('bluetooth', board({ platform: 'android' }, { androidApi: 30, paired: true, bluetooth: 'undetermined' }))).toEqual({ kind: 'idle' });
  });

  it('paired: granted; denied → Settings only; unreadable or no Bluetooth LE → unknown', () => {
    expect(state('bluetooth', board({ platform: 'ios' }, { paired: true, bluetooth: 'granted' }))).toEqual({ kind: 'granted' });
    expect(state('bluetooth', board({ platform: 'ios' }, { paired: true, bluetooth: 'denied' }))).toEqual(missing('denied', false));
    expect(state('bluetooth', board({ platform: 'ios' }, { paired: true, bluetooth: null }))).toEqual({ kind: 'unknown' });
    expect(state('bluetooth', board({ platform: 'android' }, { paired: true, bluetooth: 'unavailable' }))).toEqual({ kind: 'unknown' });
  });

  it('paired and not granted: Android reads a revoke (Settings only); iOS before its manager starts reads unknown', () => {
    expect(state('bluetooth', board({ platform: 'android' }, { androidApi: 31, paired: true, bluetooth: 'undetermined' }))).toEqual(missing('denied', false));
    expect(state('bluetooth', board({ platform: 'ios' }, { paired: true, bluetooth: 'undetermined' }))).toEqual({ kind: 'unknown' });
  });
});

describe('camera (never on Home, never requested here)', () => {
  it('undetermined is idle (asked at a scanner); denied is Settings only; unreadable is unknown', () => {
    expect(state('camera', board({}, { camera: { access: 'granted', canAskAgain: true } }))).toEqual({ kind: 'granted' });
    expect(state('camera', board({}, { camera: { access: 'undetermined', canAskAgain: true } }))).toEqual({ kind: 'idle' });
    expect(state('camera', board({}, { camera: { access: 'denied', canAskAgain: true } }))).toEqual(missing('denied', false));
    expect(state('camera', board({}, { camera: null }))).toEqual({ kind: 'unknown' });
  });
});

test('Bluetooth, the camera and the reminder need never ask the phone from here', () => {
  const reads = [
    board({ platform: 'android' }, { paired: true, bluetooth: 'denied', camera: { access: 'denied', canAskAgain: true }, reminder: reminder({ state: 'needs', missing: ['notifications'] }) }),
    board({ platform: 'ios' }, { paired: true, bluetooth: 'denied', camera: { access: 'denied', canAskAgain: true }, reminder: reminder({ state: 'needs', missing: ['locationAlways'] }) }),
  ];
  for (const read of reads) {
    for (const id of ['bluetooth', 'camera', 'reminderAccess'] as const) {
      const s = state(id, read);
      expect(s.kind).toBe('missing');
      if (s.kind === 'missing') expect(s.canAsk).toBe(false);
    }
  }
});

test("the reminder channel opened from here is the one drive-sense posts the note on (TripReminderNotifier.CHANNEL_ID)", () => {
  const src = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'modules', 'drive-sense', 'android', 'src', 'main', 'java', 'expo', 'modules', 'drivesense', 'TripReminderNotifier.kt'),
    'utf8'
  );
  expect(src).toMatch(new RegExp(`const val CHANNEL_ID = "${REMINDER_CHANNEL_ID}"`));
  expect(REMINDER_CHANNEL_ID).toBe('trip_reminder');
});

test('the signature names the reason and whether the phone can still ask', () => {
  expect(signature({ kind: 'missing', reason: 'denied', canAsk: true, target: 'app' })).toBe('denied:true');
  expect(signature({ kind: 'missing', reason: 'notYet', canAsk: false, target: 'app' })).toBe('notYet:false');
});
