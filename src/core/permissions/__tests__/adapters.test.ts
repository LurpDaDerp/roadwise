import { createFakeDriveDetect, createFakeDriveSense } from '@drive-sense';

import {
  createPermissionsAdapter,
  type LocationAnswer,
  type NotificationAnswer,
  type PermissionsAdapterDeps,
  type RadioState,
} from '../adapters';
import type { DriveDetectPort, DriveSensePort } from '../driveSensePort';
import type { PermissionPlatform } from '../types';

const NOW = 1_700_000_000_000;

const loc = (over: Partial<LocationAnswer> = {}): LocationAnswer => ({
  status: 'granted',
  canAskAgain: true,
  ...over,
});

function makeDeps(
  platform: PermissionPlatform,
  opts: {
    fg?: LocationAnswer;
    bg?: LocationAnswer;
    fgAfterRequest?: LocationAnswer;
    bgAfterRequest?: LocationAnswer;
    notif?: NotificationAnswer;
    notifAfterRequest?: NotificationAnswer;
    lowPower?: boolean | Error;
    driveSense?: DriveSensePort | null;
    driveDetect?: DriveDetectPort | null;
    sendIntentFails?: boolean;
    services?: boolean | Error;
    enableProvider?: Error;
  } = {}
) {
  const calls: string[] = [];
  let fg = opts.fg ?? loc({ ios: { scope: 'whenInUse', accuracy: 'full' }, android: { accuracy: 'fine' } });
  let bg = opts.bg ?? loc({ status: 'denied' });
  let notif = opts.notif ?? { status: 'granted', canAskAgain: true };
  const deps: PermissionsAdapterDeps = {
    platform,
    now: () => NOW,
    location: {
      async getForegroundPermissionsAsync() {
        calls.push('location.getForeground');
        return fg;
      },
      async getBackgroundPermissionsAsync() {
        calls.push('location.getBackground');
        return bg;
      },
      async requestForegroundPermissionsAsync() {
        calls.push('location.requestForeground');
        if (opts.fgAfterRequest) fg = opts.fgAfterRequest;
        return fg;
      },
      async hasServicesEnabledAsync() {
        calls.push('location.hasServices');
        if (opts.services instanceof Error) throw opts.services;
        return opts.services ?? true;
      },
      async enableNetworkProviderAsync() {
        calls.push('location.enableNetworkProvider');
        if (opts.enableProvider) throw opts.enableProvider;
      },
    },
    notifications: {
      async getPermissionsAsync() {
        calls.push('notifications.get');
        return notif;
      },
      async requestPermissionsAsync(req) {
        calls.push(`notifications.request:${JSON.stringify(req ?? null)}`);
        if (opts.notifAfterRequest) notif = opts.notifAfterRequest;
        return notif;
      },
    },
    battery: {
      async isLowPowerModeEnabledAsync() {
        calls.push('battery.lowPower');
        if (opts.lowPower instanceof Error) throw opts.lowPower;
        return opts.lowPower ?? false;
      },
    },
    linking: {
      async openSettings() {
        calls.push('linking.openSettings');
      },
      async sendIntent(action: string, extras?: { key: string; value: unknown }[]) {
        calls.push(`linking.sendIntent:${action}${extras ? `:${JSON.stringify(extras)}` : ''}`);
        if (opts.sendIntentFails) throw new Error('no activity');
      },
    },
    driveSense: async () => (opts.driveSense === undefined ? null : opts.driveSense),
    driveDetect: async () => (opts.driveDetect === undefined ? null : opts.driveDetect),
  };
  return { deps, calls };
}

const withBattery = (ds: ReturnType<typeof createFakeDriveSense>): DriveSensePort => ({
  getState: () => ds.getState(),
  requestMotionPermission: () => ds.requestMotionPermission(),
  isIgnoringBatteryOptimizations: () => ds.isIgnoringBatteryOptimizations(),
});
const withoutBattery = (ds: ReturnType<typeof createFakeDriveSense>): DriveSensePort => ({
  getState: () => ds.getState(),
  requestMotionPermission: () => ds.requestMotionPermission(),
});

describe('snapshot', () => {
  it('reads location, precise, motion from drive-sense, notifications, battery and low power', async () => {
    const ds = createFakeDriveSense({ platform: 'android' });
    ds.setState({ motion: 'granted' });
    ds.setIgnoringBatteryOptimizations(false);
    const { deps } = makeDeps('android', {
      fg: loc({ android: { accuracy: 'coarse' } }),
      bg: loc({ status: 'denied', canAskAgain: false }),
      notif: { status: 'undetermined', canAskAgain: true },
      lowPower: true,
      driveSense: withBattery(ds),
    });
    expect(await createPermissionsAdapter(deps).snapshot()).toEqual({
      platform: 'android',
      location: 'foreground',
      precise: false,
      locationCanAskAgain: false,
      locationServices: true,
      motion: 'granted',
      notifications: 'undetermined',
      notificationsCanAskAgain: true,
      batteryOptimization: 'optimized',
      lowPowerMode: true,
      backgroundRefresh: null,
      canAskAlways: null,
      liveActivities: null,
      checkedAt: NOW,
    });
    expect(ds.queries).toEqual(['getState', 'isIgnoringBatteryOptimizations']);
  });

  it('never prompts', async () => {
    const { deps, calls } = makeDeps('ios', { driveSense: withBattery(createFakeDriveSense()) });
    await createPermissionsAdapter(deps).snapshot();
    expect(calls.filter((c) => c.includes('request') || c.includes('enable'))).toEqual([]);
  });

  it("reads the phone's Location Services switch; an unreadable switch is null", async () => {
    expect((await createPermissionsAdapter(makeDeps('android', { services: false }).deps).snapshot()).locationServices).toBe(false);
    expect((await createPermissionsAdapter(makeDeps('ios', { services: true }).deps).snapshot()).locationServices).toBe(true);
    const failing = await createPermissionsAdapter(makeDeps('ios', { services: new Error('x') }).deps).snapshot();
    expect(failing.locationServices).toBeNull();
    expect(failing.location).toBe('foreground');
  });

  it('always: background granted; iOS provisional notifications; iOS reads no battery optimisation', async () => {
    const ds = createFakeDriveSense({ platform: 'ios' });
    const { deps } = makeDeps('ios', {
      bg: loc(),
      notif: { status: 'granted', canAskAgain: true, ios: { status: 3 } },
      driveSense: withBattery(ds),
    });
    const s = await createPermissionsAdapter(deps).snapshot();
    expect(s.location).toBe('always');
    expect(s.precise).toBe(true);
    expect(s.notifications).toBe('provisional');
    expect(s.batteryOptimization).toBe('exempt');
    expect(ds.queries).not.toContain('isIgnoringBatteryOptimizations');
  });

  it('denied location: precise null, can-ask-again from the foreground answer', async () => {
    const { deps } = makeDeps('ios', {
      fg: loc({ status: 'denied', canAskAgain: false, ios: { scope: 'none', accuracy: 'full' } }),
    });
    const s = await createPermissionsAdapter(deps).snapshot();
    expect(s).toMatchObject({ location: 'denied', precise: null, locationCanAskAgain: false });
  });

  it('iOS reduced accuracy is not precise', async () => {
    const { deps } = makeDeps('ios', { fg: loc({ ios: { scope: 'whenInUse', accuracy: 'reduced' } }) });
    expect((await createPermissionsAdapter(deps).snapshot()).precise).toBe(false);
  });

  it('Android battery is unknown when drive-sense lacks the method (feature-detected)', async () => {
    const ds = createFakeDriveSense({ platform: 'android' });
    const { deps } = makeDeps('android', { driveSense: withoutBattery(ds) });
    expect((await createPermissionsAdapter(deps).snapshot()).batteryOptimization).toBe('unknown');
  });

  it('Android battery is unknown when the method rejects', async () => {
    const ds = createFakeDriveSense({ platform: 'android' });
    const port: DriveSensePort = {
      ...withoutBattery(ds),
      isIgnoringBatteryOptimizations: () => Promise.reject(new Error('boom')),
    };
    const { deps } = makeDeps('android', { driveSense: port });
    expect((await createPermissionsAdapter(deps).snapshot()).batteryOptimization).toBe('unknown');
  });

  it("a failing drive-sense read: motion null (can't check), not unavailable", async () => {
    const port: DriveSensePort = {
      getState: () => Promise.reject(new Error('bridge')),
      requestMotionPermission: () => Promise.resolve('denied'),
    };
    const { deps } = makeDeps('ios', { driveSense: port });
    expect((await createPermissionsAdapter(deps).snapshot()).motion).toBeNull();
  });

  it('no drive-sense (Expo Go): motion null, battery unknown; low power failure → null', async () => {
    const { deps } = makeDeps('android', { driveSense: null, lowPower: new Error('x') });
    const s = await createPermissionsAdapter(deps).snapshot();
    expect(s.motion).toBeNull();
    expect(s.batteryOptimization).toBe('unknown');
    expect(s.lowPowerMode).toBeNull();
  });
});

describe('requestLocationForeground', () => {
  it('asks once and returns the resulting access', async () => {
    const { deps, calls } = makeDeps('android', {
      fg: loc({ status: 'undetermined' }),
      fgAfterRequest: loc({ status: 'denied', canAskAgain: true }),
    });
    expect(await createPermissionsAdapter(deps).requestLocationForeground()).toBe('denied');
    expect(calls.filter((c) => c.includes('request'))).toEqual(['location.requestForeground']);
  });

  it('Android 9 and lower with the drive detector asks only right after the disclosure (allowing location allows it in the background there)', async () => {
    const detect = () => createFakeDriveDetect({ platform: 'android', permissions: { location: 'none', canAskAlways: false } });
    const ask = async (platform: PermissionPlatform, api: number, driveDetect: DriveDetectPort | null, disclosed?: boolean) => {
      const { deps, calls } = makeDeps(platform, { fg: loc({ status: 'undetermined' }), fgAfterRequest: loc(), driveDetect });
      const answer = await createPermissionsAdapter({ ...deps, androidApiLevel: () => api }).requestLocationForeground(disclosed === undefined ? undefined : { disclosed });
      return { answer, asked: calls.includes('location.requestForeground') };
    };
    expect(await ask('android', 28, detect())).toEqual({ answer: 'undetermined', asked: false });
    expect(await ask('android', 28, detect(), false)).toEqual({ answer: 'undetermined', asked: false });
    expect(await ask('android', 28, detect(), true)).toEqual({ answer: 'foreground', asked: true });
    // Android 10 and later (background location is its own permission), a phone without the
    // detector, and an iPhone ask as before.
    expect(await ask('android', 29, detect())).toEqual({ answer: 'foreground', asked: true });
    expect(await ask('android', 28, null)).toEqual({ answer: 'foreground', asked: true });
    expect(await ask('ios', 0, createFakeDriveDetect({ permissions: { location: 'none', canAskAlways: false } }))).toEqual({ answer: 'foreground', asked: true });
    // Fails closed: Google Play services unavailable (updating, too old: the detector arms once they
    // come back) or the detector unreadable still need the disclosure first.
    const noPlay = createFakeDriveDetect({ platform: 'android', permissions: { location: 'none', motion: 'unavailable', canAskAlways: false } });
    expect(await ask('android', 28, noPlay)).toEqual({ answer: 'undetermined', asked: false });
    const unreadable = createFakeDriveDetect({ platform: 'android', permissions: { location: 'none', canAskAlways: false } });
    unreadable.getState = async () => {
      throw new Error('read failed');
    };
    expect(await ask('android', 28, unreadable)).toEqual({ answer: 'undetermined', asked: false });
    expect(await ask('android', 28, noPlay, true)).toEqual({ answer: 'foreground', asked: true });
  });
});

describe('requestMotion — through the drive-sense port on both platforms', () => {
  it.each(['ios', 'android'] as const)('%s: undetermined → requestMotionPermission', async (platform) => {
    const ds = createFakeDriveSense({ platform });
    const { deps } = makeDeps(platform, { driveSense: withBattery(ds) });
    expect(await createPermissionsAdapter(deps).requestMotion()).toBe('granted');
    expect(ds.calls).toEqual(['requestMotionPermission']);
  });

  it('unavailable stays unavailable without a request', async () => {
    const ds = createFakeDriveSense({ platform: 'android' });
    ds.setState({ motion: 'unavailable' });
    const { deps } = makeDeps('android', { driveSense: withBattery(ds) });
    expect(await createPermissionsAdapter(deps).requestMotion()).toBe('unavailable');
    expect(ds.calls).toEqual([]);
  });

  it('granted is returned without a request', async () => {
    const ds = createFakeDriveSense({ platform: 'ios' });
    ds.setState({ motion: 'granted' });
    const { deps } = makeDeps('ios', { driveSense: withBattery(ds) });
    expect(await createPermissionsAdapter(deps).requestMotion()).toBe('granted');
    expect(ds.calls).toEqual([]);
  });

  it('no drive-sense → null (could not ask), not unavailable', async () => {
    const { deps } = makeDeps('ios', { driveSense: null });
    expect(await createPermissionsAdapter(deps).requestMotion()).toBeNull();
  });

  it('a failed request whose re-read also fails → null', async () => {
    const port: DriveSensePort = {
      getState: () => Promise.reject(new Error('x')),
      requestMotionPermission: () => Promise.reject(new Error('y')),
    };
    const { deps } = makeDeps('android', { driveSense: port });
    expect(await createPermissionsAdapter(deps).requestMotion()).toBeNull();
  });

  it('a failed request re-reads the state rather than inventing an answer', async () => {
    const ds = createFakeDriveSense({ platform: 'android' });
    ds.setState({ motion: 'denied' });
    const port: DriveSensePort = {
      getState: () => ds.getState(),
      requestMotionPermission: () => Promise.reject(new Error('bridge')),
    };
    const { deps } = makeDeps('android', { driveSense: port });
    expect(await createPermissionsAdapter(deps).requestMotion()).toBe('denied');
  });
});

describe('requestNotifications', () => {
  it('asks for alert, badge and sound — never provisional', async () => {
    const { deps, calls } = makeDeps('ios', {
      notif: { status: 'undetermined', canAskAgain: true },
      notifAfterRequest: { status: 'granted', canAskAgain: true, ios: { status: 2 } },
    });
    expect(await createPermissionsAdapter(deps).requestNotifications()).toBe('granted');
    const req = calls.find((c) => c.startsWith('notifications.request:'));
    expect(req).toBe('notifications.request:{"ios":{"allowAlert":true,"allowBadge":true,"allowSound":true}}');
    expect(req).not.toContain('Provisional');
  });
});

describe('settings links', () => {
  it('openAppSettings opens the app page', async () => {
    const { deps, calls } = makeDeps('ios');
    await createPermissionsAdapter(deps).openAppSettings();
    expect(calls).toEqual(['linking.openSettings']);
  });

  it('openBatterySettings sends the Android intent', async () => {
    const { deps, calls } = makeDeps('android');
    await createPermissionsAdapter(deps).openBatterySettings();
    expect(calls).toEqual(['linking.sendIntent:android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS']);
  });

  it('falls back to the app page when the intent cannot be sent, and on iOS', async () => {
    const a = makeDeps('android', { sendIntentFails: true });
    await createPermissionsAdapter(a.deps).openBatterySettings();
    expect(a.calls).toEqual([
      'linking.sendIntent:android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
      'linking.openSettings',
    ]);
    const i = makeDeps('ios');
    await createPermissionsAdapter(i.deps).openBatterySettings();
    expect(i.calls).toEqual(['linking.openSettings']);
  });
});

describe('Location Services', () => {
  it('Android: the Play-services dialog once, a refusal swallowed; iOS: nothing', async () => {
    const a = makeDeps('android');
    await createPermissionsAdapter(a.deps).requestLocationServices();
    expect(a.calls).toEqual(['location.enableNetworkProvider']);
    const refused = makeDeps('android', { enableProvider: new Error('declined') });
    await expect(createPermissionsAdapter(refused.deps).requestLocationServices()).resolves.toBeUndefined();
    expect(refused.calls).toEqual(['location.enableNetworkProvider']);
    const i = makeDeps('ios');
    await createPermissionsAdapter(i.deps).requestLocationServices();
    expect(i.calls).toEqual([]);
  });

  it("the Location page on Android, falling back to the app's page; iOS opens the app's page", async () => {
    const a = makeDeps('android');
    await createPermissionsAdapter(a.deps).openLocationServicesSettings();
    expect(a.calls).toEqual(['linking.sendIntent:android.settings.LOCATION_SOURCE_SETTINGS']);
    const f = makeDeps('android', { sendIntentFails: true });
    await createPermissionsAdapter(f.deps).openLocationServicesSettings();
    expect(f.calls).toEqual(['linking.sendIntent:android.settings.LOCATION_SOURCE_SETTINGS', 'linking.openSettings']);
    const i = makeDeps('ios');
    await createPermissionsAdapter(i.deps).openLocationServicesSettings();
    expect(i.calls).toEqual(['linking.openSettings']);
  });
});

describe('Battery Saver page', () => {
  it("Android opens Battery Saver, falling back to the app's page; iOS opens the app's page", async () => {
    const a = makeDeps('android');
    await createPermissionsAdapter(a.deps).openBatterySaverSettings();
    expect(a.calls).toEqual(['linking.sendIntent:android.settings.BATTERY_SAVER_SETTINGS']);
    const f = makeDeps('android', { sendIntentFails: true });
    await createPermissionsAdapter(f.deps).openBatterySaverSettings();
    expect(f.calls).toEqual(['linking.sendIntent:android.settings.BATTERY_SAVER_SETTINGS', 'linking.openSettings']);
    const i = makeDeps('ios');
    await createPermissionsAdapter(i.deps).openBatterySaverSettings();
    expect(i.calls).toEqual(['linking.openSettings']);
  });
});

describe('"Pause app activity if unused" page', () => {
  const ds = createFakeDriveSense({ platform: 'android' });
  const port = (open?: () => Promise<boolean>): DriveSensePort => ({ ...withBattery(ds), ...(open ? { openUnusedAppRestrictionsSettings: open } : {}) });
  const open = async (platform: PermissionPlatform, p: DriveSensePort | null) => {
    const { deps, calls } = makeDeps(platform, { driveSense: p });
    await createPermissionsAdapter(deps).openUnusedAppSettings();
    return calls;
  };

  it("Android opens the switch's own page through the native build; the app's page where it can't, and on iOS", async () => {
    const opened = jest.fn(async () => true);
    expect(await open('android', port(opened))).toEqual([]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(await open('android', port(async () => false))).toEqual(['linking.openSettings']);
    expect(await open('android', port(() => Promise.reject(new Error('x'))))).toEqual(['linking.openSettings']);
    expect(await open('android', port())).toEqual(['linking.openSettings']);
    expect(await open('android', null)).toEqual(['linking.openSettings']);
    const never = jest.fn(async () => true);
    expect(await open('ios', port(never))).toEqual(['linking.openSettings']);
    expect(never).not.toHaveBeenCalled();
  });
});

describe('notification channel page', () => {
  const extras = JSON.stringify([
    { key: 'android.provider.extra.APP_PACKAGE', value: 'app.roadwise' },
    { key: 'android.provider.extra.CHANNEL_ID', value: 'trip_reminder' },
  ]);

  it('Android: the channel page of this app, with its package and the channel id', async () => {
    const a = makeDeps('android');
    await createPermissionsAdapter({ ...a.deps, androidPackage: () => 'app.roadwise' }).openNotificationChannelSettings('trip_reminder');
    expect(a.calls).toEqual([`linking.sendIntent:android.settings.CHANNEL_NOTIFICATION_SETTINGS:${extras}`]);
  });

  it("falls back to the app's page when the intent fails or the package is unknown, and on iOS", async () => {
    const f = makeDeps('android', { sendIntentFails: true });
    await createPermissionsAdapter({ ...f.deps, androidPackage: () => 'app.roadwise' }).openNotificationChannelSettings('trip_reminder');
    expect(f.calls).toEqual([`linking.sendIntent:android.settings.CHANNEL_NOTIFICATION_SETTINGS:${extras}`, 'linking.openSettings']);
    const n = makeDeps('android');
    await createPermissionsAdapter({ ...n.deps, androidPackage: () => null }).openNotificationChannelSettings('trip_reminder');
    expect(n.calls).toEqual(['linking.openSettings']);
    const i = makeDeps('ios');
    await createPermissionsAdapter({ ...i.deps, androidPackage: () => 'app.roadwise' }).openNotificationChannelSettings('trip_reminder');
    expect(i.calls).toEqual(['linking.openSettings']);
  });
});

describe('camera (read only)', () => {
  it('maps the three statuses and passes canAskAgain; anything else reads denied', async () => {
    const read = async (status: string, canAskAgain: boolean) => {
      const { deps } = makeDeps('ios');
      return createPermissionsAdapter({ ...deps, camera: { getCameraPermissionsAsync: async () => ({ status, canAskAgain }) } }).camera();
    };
    expect(await read('granted', true)).toEqual({ access: 'granted', canAskAgain: true });
    expect(await read('undetermined', true)).toEqual({ access: 'undetermined', canAskAgain: true });
    expect(await read('denied', false)).toEqual({ access: 'denied', canAskAgain: false });
    expect(await read('restricted', false)).toEqual({ access: 'denied', canAskAgain: false });
  });
});

describe('automatic drives: Location Always, Background App Refresh, Live Activities (and their Android counterparts)', () => {
  it('the snapshot reads them from the drive detector on both phones; null without one and when unreadable', async () => {
    const detect = createFakeDriveDetect({ permissions: { backgroundRefresh: 'denied', canAskAlways: true, liveActivities: false } });
    const ios = await createPermissionsAdapter(makeDeps('ios', { driveDetect: detect }).deps).snapshot();
    expect(ios).toMatchObject({ backgroundRefresh: 'denied', canAskAlways: true, liveActivities: false });
    const androidDetect = createFakeDriveDetect({ platform: 'android', permissions: { backgroundRefresh: 'denied', canAskAlways: true, liveActivities: false } });
    const android = await createPermissionsAdapter(makeDeps('android', { driveDetect: androidDetect }).deps).snapshot();
    expect(android).toMatchObject({ backgroundRefresh: 'denied', canAskAlways: true, liveActivities: false });
    expect(await createPermissionsAdapter(makeDeps('android', { driveDetect: null }).deps).snapshot()).toMatchObject({ backgroundRefresh: null, canAskAlways: null, liveActivities: null });
    const failing: DriveDetectPort = { getState: () => Promise.reject(new Error('x')), requestAlways: () => Promise.reject(new Error('x')) };
    expect(await createPermissionsAdapter(makeDeps('ios', { driveDetect: failing }).deps).snapshot()).toMatchObject({ backgroundRefresh: null, canAskAlways: null });
  });

  it('an Android phone without Google Play services (motion unavailable) reads as one without the detector; an iPhone reads as it is', async () => {
    const perms = { motion: 'unavailable', backgroundRefresh: 'available', canAskAlways: true, liveActivities: true } as const;
    const android = createFakeDriveDetect({ platform: 'android', permissions: perms });
    expect(await createPermissionsAdapter(makeDeps('android', { driveDetect: android }).deps).snapshot()).toMatchObject({ backgroundRefresh: null, canAskAlways: null, liveActivities: null });
    const ios = createFakeDriveDetect({ permissions: perms });
    expect(await createPermissionsAdapter(makeDeps('ios', { driveDetect: ios }).deps).snapshot()).toMatchObject({ backgroundRefresh: 'available', canAskAlways: true, liveActivities: true });
  });

  it("Android's Battery Saver limiting location comes through as restricted", async () => {
    const detect = createFakeDriveDetect({ platform: 'android', permissions: { backgroundRefresh: 'restricted', canAskAlways: false } });
    expect(await createPermissionsAdapter(makeDeps('android', { driveDetect: detect }).deps).snapshot()).toMatchObject({ backgroundRefresh: 'restricted' });
  });

  it('iOS: the one Always request through the detector', async () => {
    const detect = createFakeDriveDetect({ permissions: { location: 'whenInUse', canAskAlways: true } });
    detect.setAlwaysAnswer('always');
    const ios = makeDeps('ios', { driveDetect: detect });
    expect(await createPermissionsAdapter(ios.deps).requestLocationAlways()).toBe('always');
    expect(detect.calls).toEqual(['requestAlways']);
  });

  it('Android asks for Allow all the time only right after the disclosure; without it, nothing is asked', async () => {
    const detect = createFakeDriveDetect({ platform: 'android', permissions: { location: 'whenInUse', canAskAlways: true } });
    detect.setAlwaysAnswer('always');
    const undisclosed = makeDeps('android', { driveDetect: detect });
    expect(await createPermissionsAdapter(undisclosed.deps).requestLocationAlways()).toBe('whenInUse');
    expect(await createPermissionsAdapter(undisclosed.deps).requestLocationAlways({ disclosed: false })).toBe('whenInUse');
    expect(detect.calls).toEqual([]);
    expect(undisclosed.calls).toEqual(['location.getForeground', 'location.getBackground', 'location.getForeground', 'location.getBackground']);
    const disclosed = makeDeps('android', { driveDetect: detect });
    expect(await createPermissionsAdapter(disclosed.deps).requestLocationAlways({ disclosed: true })).toBe('always');
    expect(detect.calls).toEqual(['requestAlways']);
    // A phone without the detector: the answer as it stands.
    expect(await createPermissionsAdapter(makeDeps('android', { driveDetect: null }).deps).requestLocationAlways({ disclosed: true })).toBe('whenInUse');
  });

  it("Android 11+: Pause app activity if unused, read from drive-sense where the build has it", async () => {
    const ds = createFakeDriveSense({ platform: 'android' });
    const port = (answer: () => Promise<'enabled' | 'disabled' | 'unavailable'>): DriveSensePort => ({ ...withBattery(ds), getUnusedAppRestrictions: answer });
    const read = async (p: DriveSensePort, platform: PermissionPlatform = 'android', api = 34) =>
      (await createPermissionsAdapter({ ...makeDeps(platform, { driveSense: p }).deps, androidApiLevel: () => api }).snapshot()).unusedAppPause;
    expect(await read(port(async () => 'enabled'))).toBe('on');
    expect(await read(port(async () => 'disabled'))).toBe('off');
    expect(await read(port(async () => 'unavailable'))).toBeUndefined();
    expect(await read(port(() => Promise.reject(new Error('x'))))).toBeUndefined();
    expect(await read(withBattery(ds))).toBeUndefined();
    expect(await read(port(async () => 'enabled'), 'android', 29)).toBeUndefined();
    expect(await read(port(async () => 'enabled'), 'ios')).toBeUndefined();
  });

  it('with no detector, or a failed request, the answer as it stands', async () => {
    expect(await createPermissionsAdapter(makeDeps('ios', { driveDetect: null }).deps).requestLocationAlways()).toBe('whenInUse');
    const failing: DriveDetectPort = { getState: () => Promise.reject(new Error('x')), requestAlways: () => Promise.reject(new Error('x')) };
    expect(await createPermissionsAdapter(makeDeps('ios', { driveDetect: failing, bg: loc({ status: 'granted' }) }).deps).requestLocationAlways()).toBe('always');
    expect(await createPermissionsAdapter(makeDeps('ios', { driveDetect: null, fg: loc({ status: 'denied' }) }).deps).requestLocationAlways()).toBe('denied');
  });
});

describe('readiness', () => {
  it('allowed from the drive-sense location (While Using is enough) and motion', async () => {
    const ds = createFakeDriveSense({ platform: 'android' });
    ds.setState({ location: 'whenInUse', motion: 'granted' });
    const { deps } = makeDeps('android', { driveSense: withBattery(ds) });
    expect(await createPermissionsAdapter(deps).readiness()).toEqual({ allowed: true });
    ds.setState({ motion: 'denied' });
    expect(await createPermissionsAdapter(deps).readiness()).toEqual({ allowed: false });
  });

  it('not allowed when it could not be checked', async () => {
    const { deps } = makeDeps('ios', { driveSense: null });
    expect(await createPermissionsAdapter(deps).readiness()).toEqual({ allowed: false });
    const failing: DriveSensePort = {
      getState: () => Promise.reject(new Error('x')),
      requestMotionPermission: () => Promise.resolve('denied'),
    };
    const f = makeDeps('ios', { driveSense: failing });
    expect(await createPermissionsAdapter(f.deps).readiness()).toEqual({ allowed: false });
  });
});

// DashPal (plan §7.9, §10 row 22): Bluetooth is asked only on the driver's DashPal tap, and a read
// never prompts — on iOS it never even creates the BLE manager.
describe('Bluetooth (DashPal)', () => {
  function bt(
    platform: PermissionPlatform,
    o: { radio?: RadioState | null; started?: RadioState; level?: number; checks?: Record<string, boolean>; answers?: Record<string, string>; driveDetect?: DriveDetectPort | null; fg?: LocationAnswer } = {}
  ) {
    const { deps, calls } = makeDeps(platform, { driveDetect: o.driveDetect, fg: o.fg });
    const full: PermissionsAdapterDeps = {
      ...deps,
      bluetooth: {
        radio: async () => {
          calls.push('bt.radio');
          return o.radio === undefined ? null : o.radio;
        },
        startRadio: async () => {
          calls.push('bt.startRadio');
          return o.started ?? 'on';
        },
      },
      androidPermissions: {
        check: async (p) => {
          calls.push(`check:${p}`);
          return o.checks?.[p] ?? false;
        },
        requestMultiple: async (ps) => {
          calls.push(`request:${ps.join(',')}`);
          return Object.fromEntries(ps.map((p) => [p, o.answers?.[p] ?? 'granted']));
        },
      },
      androidApiLevel: () => o.level ?? 34,
    };
    return { adapter: createPermissionsAdapter(full), calls };
  }

  it('iOS read: never creates the manager — undetermined before it exists; then the radio state', async () => {
    const a = bt('ios');
    expect(await a.adapter.bluetooth()).toBe('undetermined');
    expect(a.calls).toEqual(['bt.radio']);
    expect(await bt('ios', { radio: 'unauthorized' }).adapter.bluetooth()).toBe('denied');
    expect(await bt('ios', { radio: 'off' }).adapter.bluetooth()).toBe('off');
    expect(await bt('ios', { radio: 'on' }).adapter.bluetooth()).toBe('granted');
    expect(await bt('ios', { radio: 'unsupported' }).adapter.bluetooth()).toBe('unavailable');
  });

  it('iOS request: creates the manager and answers from its first settled state', async () => {
    const a = bt('ios', { started: 'unauthorized' });
    expect(await a.adapter.requestBluetooth()).toBe('denied');
    expect(a.calls).toEqual(['bt.startRadio']);
    expect(await bt('ios', { started: 'on' }).adapter.requestBluetooth()).toBe('granted');
  });

  it('Android 12+: Nearby devices (scan + connect); a refusal is denied; granted then reads the radio', async () => {
    const a = bt('android', { level: 31, started: 'off' });
    expect(await a.adapter.requestBluetooth()).toBe('off');
    expect(a.calls).toEqual(['request:android.permission.BLUETOOTH_SCAN,android.permission.BLUETOOTH_CONNECT', 'bt.startRadio']);
    const refused = bt('android', { level: 33, answers: { 'android.permission.BLUETOOTH_CONNECT': 'never_ask_again' } });
    expect(await refused.adapter.requestBluetooth()).toBe('denied');
    expect(refused.calls).not.toContain('bt.startRadio');
  });

  it('Android 11 and below: fine location (scans need it there)', async () => {
    const a = bt('android', { level: 30 });
    expect(await a.adapter.requestBluetooth()).toBe('granted');
    expect(a.calls[0]).toBe('request:android.permission.ACCESS_FINE_LOCATION');
  });

  it('Android 9 and lower with the drive detector: fine location only right after the disclosure, while location is not allowed', async () => {
    const detect = () => createFakeDriveDetect({ platform: 'android', permissions: { location: 'none', canAskAlways: false } });
    const notAsked = loc({ status: 'undetermined' });
    const undisclosed = bt('android', { level: 28, driveDetect: detect(), fg: notAsked });
    expect(await undisclosed.adapter.locationAskIsBackground()).toBe(true);
    expect(await undisclosed.adapter.requestBluetooth()).toBe('undetermined');
    expect(await undisclosed.adapter.requestBluetooth({ disclosed: false })).toBe('undetermined');
    expect(undisclosed.calls.some((c) => c.startsWith('request') || c.startsWith('bt.'))).toBe(false);
    const disclosed = bt('android', { level: 28, driveDetect: detect(), fg: notAsked });
    expect(await disclosed.adapter.requestBluetooth({ disclosed: true })).toBe('granted');
    expect(disclosed.calls).toContain('request:android.permission.ACCESS_FINE_LOCATION');
    // Location already allowed (nothing new is allowed), Android 10 and later, a build without the
    // detector and an iPhone: no disclosure. A phone reading no Play services still has one (fails closed).
    const allowed = bt('android', { level: 28, driveDetect: detect() });
    expect(await allowed.adapter.locationAskIsBackground()).toBe(false);
    expect(await allowed.adapter.requestBluetooth()).toBe('granted');
    expect(await bt('android', { level: 29, driveDetect: detect(), fg: notAsked }).adapter.locationAskIsBackground()).toBe(false);
    expect(await bt('android', { level: 28, driveDetect: null, fg: notAsked }).adapter.locationAskIsBackground()).toBe(false);
    const noPlay = createFakeDriveDetect({ platform: 'android', permissions: { location: 'none', motion: 'unavailable', canAskAlways: false } });
    expect(await bt('android', { level: 28, driveDetect: noPlay, fg: notAsked }).adapter.locationAskIsBackground()).toBe(true);
    expect(await bt('ios', { driveDetect: createFakeDriveDetect({ permissions: { location: 'none', canAskAlways: false } }), fg: notAsked }).adapter.locationAskIsBackground()).toBe(false);
  });

  it('Android read: not granted is undetermined with no prompt and no radio; granted reads the radio', async () => {
    const no = bt('android', { level: 34 });
    expect(await no.adapter.bluetooth()).toBe('undetermined');
    expect(no.calls.some((c) => c.startsWith('request') || c.startsWith('bt.'))).toBe(false);
    const yes = bt('android', { level: 34, checks: { 'android.permission.BLUETOOTH_SCAN': true, 'android.permission.BLUETOOTH_CONNECT': true }, started: 'on' });
    expect(await yes.adapter.bluetooth()).toBe('granted');
  });

  it('the permission read never starts the radio: Android checks scan + connect (fine location on 11 and below)', async () => {
    const both = { 'android.permission.BLUETOOTH_SCAN': true, 'android.permission.BLUETOOTH_CONNECT': true };
    const yes = bt('android', { level: 31, checks: both });
    expect(await yes.adapter.bluetoothPermission()).toBe('granted');
    expect(yes.calls).toEqual(['check:android.permission.BLUETOOTH_SCAN', 'check:android.permission.BLUETOOTH_CONNECT']);
    const one = bt('android', { level: 34, checks: { 'android.permission.BLUETOOTH_SCAN': true } });
    expect(await one.adapter.bluetoothPermission()).toBe('undetermined');
    const old = bt('android', { level: 30, checks: { 'android.permission.ACCESS_FINE_LOCATION': true } });
    expect(await old.adapter.bluetoothPermission()).toBe('granted');
    expect(old.calls).toEqual(['check:android.permission.ACCESS_FINE_LOCATION']);
    for (const c of [...yes.calls, ...one.calls, ...old.calls]) expect(c.startsWith('bt.') || c.startsWith('request')).toBe(false);
  });

  it('iOS permission read: allowed or not (a radio switched off is still allowed), never creating the manager', async () => {
    const none = bt('ios');
    expect(await none.adapter.bluetoothPermission()).toBe('undetermined');
    expect(none.calls).toEqual(['bt.radio']);
    expect(await bt('ios', { radio: 'unauthorized' }).adapter.bluetoothPermission()).toBe('denied');
    expect(await bt('ios', { radio: 'unsupported' }).adapter.bluetoothPermission()).toBe('unavailable');
    expect(await bt('ios', { radio: 'on' }).adapter.bluetoothPermission()).toBe('granted');
    expect(await bt('ios', { radio: 'off' }).adapter.bluetoothPermission()).toBe('granted');
    expect(await bt('ios', { radio: 'turning_off' }).adapter.bluetoothPermission()).toBe('granted');
  });
});
