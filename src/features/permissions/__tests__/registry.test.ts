/**
 * The permission registry: each permission's state from one read of the phone (design §3.1), one
 * case per branch, on both platforms.
 */
import type { PermissionSnapshot } from '@/core/permissions';

import { snap } from '../__fixtures__/harness';
import { disclosesBackground, PERMISSIONS, permissionDef, signature, type MissingState, type PermissionBoardRead, type PermissionId, type PermState } from '../registry';

function board(over: Partial<PermissionSnapshot> = {}, rest: Partial<Omit<PermissionBoardRead, 'snapshot'>> = {}): PermissionBoardRead {
  const snapshot = snap(over);
  return {
    snapshot,
    androidApi: snapshot.platform === 'android' ? 34 : null,
    paired: false,
    bluetooth: null,
    camera: null,
    ...rest,
  };
}

const state = (id: PermissionId, read: PermissionBoardRead): PermState => permissionDef(id).state(read);
const missing = (reason: string, canAsk: boolean, target = 'app') => ({ kind: 'missing', reason, canAsk, target });

test('every permission has a unique order; only the camera and the Android unused-app tip have no Home row; location and precise are required', () => {
  const orders = PERMISSIONS.map((d) => d.order);
  expect(new Set(orders).size).toBe(orders.length);
  expect(PERMISSIONS.map((d) => [d.id, d.order])).toEqual([
    ['location', 10],
    ['precise', 20],
    ['locationAlways', 25],
    ['motion', 30],
    ['backgroundRefresh', 35],
    ['unusedApps', 37],
    ['notifications', 40],
    ['bluetooth', 60],
    ['camera', 70],
  ]);
  expect(PERMISSIONS.filter((d) => !d.homeRow).map((d) => d.id)).toEqual(['unusedApps', 'camera']);
  expect(PERMISSIONS.filter((d) => d.need === 'required').map((d) => d.id)).toEqual(['location', 'precise']);
  // Both phones list every row but the Android unused-app tip (an iPhone has no such switch).
  expect(PERMISSIONS.filter((d) => !d.platforms.includes('android')).map((d) => d.id)).toEqual([]);
  expect(PERMISSIONS.filter((d) => !d.platforms.includes('ios')).map((d) => d.id)).toEqual(['unusedApps']);
  expect(permissionDef('locationAlways').need).toBe('recommended');
  expect(permissionDef('backgroundRefresh').need).toBe('recommended');
  expect(permissionDef('unusedApps').need).toBe('optional');
});

describe("automatic drives' rows on Android", () => {
  const listed = (id: PermissionId, read: PermissionBoardRead) => permissionDef(id).listed?.(read) ?? true;

  it('listed once the drive detector answered (every iPhone lists them)', () => {
    for (const id of ['locationAlways', 'backgroundRefresh', 'unusedApps'] as const) {
      expect(listed(id, board({ platform: 'android', canAskAlways: true }))).toBe(true);
      expect(listed(id, board({ platform: 'android', canAskAlways: null }))).toBe(false);
    }
    expect(listed('locationAlways', board({ platform: 'ios', canAskAlways: null }))).toBe(true);
    expect(listed('backgroundRefresh', board({ platform: 'ios', canAskAlways: null }))).toBe(true);
  });

  it('Allow all the time: idle without location, granted, else always askable (the detector shows the dialog or its page)', () => {
    expect(state('locationAlways', board({ platform: 'android', location: 'denied', precise: null, canAskAlways: true }))).toEqual({ kind: 'idle' });
    expect(state('locationAlways', board({ platform: 'android', location: 'always', canAskAlways: false }))).toEqual({ kind: 'granted' });
    expect(state('locationAlways', board({ platform: 'android', location: 'foreground', canAskAlways: true }))).toEqual(missing('notYet', true));
    expect(state('locationAlways', board({ platform: 'android', location: 'foreground', canAskAlways: false }))).toEqual(missing('denied', true));
  });

  it('battery: Restricted is missing (the app page), and so is Battery Saver limiting location (its own page); Settings only', () => {
    expect(state('backgroundRefresh', board({ platform: 'android', backgroundRefresh: 'available', canAskAlways: false }))).toEqual({ kind: 'granted' });
    expect(state('backgroundRefresh', board({ platform: 'android', backgroundRefresh: 'denied', canAskAlways: false }))).toEqual(missing('denied', false));
    expect(state('backgroundRefresh', board({ platform: 'android', backgroundRefresh: 'restricted', canAskAlways: false }))).toEqual(missing('denied', false, 'batterySaver'));
    expect(state('backgroundRefresh', board({ platform: 'android', backgroundRefresh: null, canAskAlways: false }))).toEqual({ kind: 'unknown' });
  });

  it('the background-location disclosure: every Location Always fix; the location fix only on Android 9 and lower with the detector', () => {
    const always = missing('notYet', true) as MissingState;
    const loc = missing('notYet', true) as MissingState;
    const services = missing('servicesOff', true, 'locationServices') as MissingState;
    const old = (over: Partial<PermissionSnapshot> = {}) => board({ platform: 'android', location: 'undetermined', canAskAlways: false, ...over }, { androidApi: 28 });
    expect(disclosesBackground('locationAlways', always, board({ platform: 'android', canAskAlways: true }))).toBe(true);
    expect(disclosesBackground('location', loc, old())).toBe(true);
    expect(disclosesBackground('location', services, old())).toBe(false);
    expect(disclosesBackground('location', loc, old({ canAskAlways: null }))).toBe(false);
    expect(disclosesBackground('location', loc, board({ platform: 'android', location: 'undetermined', canAskAlways: false }, { androidApi: 29 }))).toBe(false);
    expect(disclosesBackground('motion', loc, old())).toBe(false);
    for (const id of ['location', 'locationAlways'] as const) {
      expect(disclosesBackground(id, loc, board({ platform: 'ios', location: 'undetermined', canAskAlways: true }))).toBe(false);
    }
  });

  it('Pause app activity if unused: off is granted, on is missing (Settings only: the page with its switch), unread is unknown', () => {
    expect(state('unusedApps', board({ platform: 'android', unusedAppPause: 'off' }))).toEqual({ kind: 'granted' });
    expect(state('unusedApps', board({ platform: 'android', unusedAppPause: 'on' }))).toEqual(missing('denied', false, 'unusedApps'));
    expect(state('unusedApps', board({ platform: 'android', unusedAppPause: null }))).toEqual({ kind: 'unknown' });
    expect(state('unusedApps', board({ platform: 'android' }))).toEqual({ kind: 'unknown' });
  });
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

describe('Location Always (iPhone)', () => {
  it('not in use until location is allowed, so the location row comes first', () => {
    expect(state('locationAlways', board({ platform: 'ios', location: 'denied', precise: null }))).toEqual({ kind: 'idle' });
    expect(state('locationAlways', board({ platform: 'ios', location: 'undetermined', precise: null }))).toEqual({ kind: 'idle' });
    expect(state('locationAlways', board({ platform: 'ios', location: 'always', locationServices: false }))).toEqual({ kind: 'idle' });
  });

  it('Always: granted', () => {
    expect(state('locationAlways', board({ platform: 'ios', location: 'always' }))).toEqual({ kind: 'granted' });
  });

  it('While Using: asks while iOS still can, then Settings only', () => {
    expect(state('locationAlways', board({ platform: 'ios', location: 'foreground', canAskAlways: true }))).toEqual(missing('notYet', true));
    expect(state('locationAlways', board({ platform: 'ios', location: 'foreground', canAskAlways: false }))).toEqual(missing('denied', false));
    expect(state('locationAlways', board({ platform: 'ios', location: 'foreground', canAskAlways: null }))).toEqual(missing('denied', false));
  });
});

describe('Background App Refresh (iPhone)', () => {
  it('available: granted; denied: Settings only; restricted or unread: unknown', () => {
    expect(state('backgroundRefresh', board({ platform: 'ios', backgroundRefresh: 'available' }))).toEqual({ kind: 'granted' });
    expect(state('backgroundRefresh', board({ platform: 'ios', backgroundRefresh: 'denied' }))).toEqual(missing('denied', false));
    expect(state('backgroundRefresh', board({ platform: 'ios', backgroundRefresh: 'restricted' }))).toEqual({ kind: 'unknown' });
    expect(state('backgroundRefresh', board({ platform: 'ios', backgroundRefresh: null }))).toEqual({ kind: 'unknown' });
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

  it('a paired car (iPhone, no DashPal) puts it in use: On, Off (Settings only), or not in use before the phone answered', () => {
    expect(state('bluetooth', board({ platform: 'ios' }, { carPaired: true, bluetooth: 'granted' }))).toEqual({ kind: 'granted' });
    expect(state('bluetooth', board({ platform: 'ios' }, { carPaired: true, bluetooth: 'denied' }))).toEqual(missing('denied', false));
    expect(state('bluetooth', board({ platform: 'ios' }, { carPaired: true, bluetooth: 'undetermined' }))).toEqual({ kind: 'idle' });
    expect(state('bluetooth', board({ platform: 'ios' }, { carPaired: true, bluetooth: null }))).toEqual({ kind: 'unknown' });
    expect(state('bluetooth', board({ platform: 'ios' }, { carPaired: false, bluetooth: 'denied' }))).toEqual({ kind: 'idle' });
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

test('Bluetooth, the camera, Background App Refresh (and Android battery) and the unused-app tip never ask the phone from here', () => {
  const reads = [
    board({ platform: 'android' }, { paired: true, bluetooth: 'denied', camera: { access: 'denied', canAskAgain: true } }),
    board({ platform: 'ios', backgroundRefresh: 'denied' }, { paired: true, bluetooth: 'denied', camera: { access: 'denied', canAskAgain: true } }),
    board({ platform: 'android', backgroundRefresh: 'denied', canAskAlways: true, unusedAppPause: 'on' }, { paired: true, bluetooth: 'denied', camera: { access: 'denied', canAskAgain: true } }),
  ];
  for (const read of reads) {
    const ids = read.snapshot.platform === 'ios' || read.snapshot.backgroundRefresh !== null ? (['bluetooth', 'camera', 'backgroundRefresh', 'unusedApps'] as const) : (['bluetooth', 'camera'] as const);
    for (const id of ids) {
      if (id === 'unusedApps' && read.snapshot.platform === 'ios') continue;
      const s = state(id, read);
      expect(s.kind).toBe('missing');
      if (s.kind === 'missing') expect(s.canAsk).toBe(false);
    }
  }
});

test('the signature names the reason and whether the phone can still ask', () => {
  expect(signature({ kind: 'missing', reason: 'denied', canAsk: true, target: 'app' })).toBe('denied:true');
  expect(signature({ kind: 'missing', reason: 'notYet', canAsk: false, target: 'app' })).toBe('notYet:false');
});
