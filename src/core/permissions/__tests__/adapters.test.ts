import { createFakeDriveSense } from '@drive-sense';

import {
  createPermissionsAdapter,
  type LocationAnswer,
  type NotificationAnswer,
  type PermissionsAdapterDeps,
} from '../adapters';
import type { DriveSensePort } from '../driveSensePort';
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
    sendIntentFails?: boolean;
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
      async requestBackgroundPermissionsAsync() {
        calls.push('location.requestBackground');
        if (opts.bgAfterRequest) bg = opts.bgAfterRequest;
        return bg;
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
      async sendIntent(action: string) {
        calls.push(`linking.sendIntent:${action}`);
        if (opts.sendIntentFails) throw new Error('no activity');
      },
    },
    driveSense: async () => (opts.driveSense === undefined ? null : opts.driveSense),
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
      motion: 'granted',
      notifications: 'undetermined',
      notificationsCanAskAgain: true,
      batteryOptimization: 'optimized',
      lowPowerMode: true,
      checkedAt: NOW,
    });
    expect(ds.queries).toEqual(['getState', 'isIgnoringBatteryOptimizations']);
  });

  it('never prompts', async () => {
    const { deps, calls } = makeDeps('ios', { driveSense: withBattery(createFakeDriveSense()) });
    await createPermissionsAdapter(deps).snapshot();
    expect(calls.filter((c) => c.includes('request'))).toEqual([]);
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

  it('no drive-sense (Expo Go): motion unavailable, battery unknown; low power failure → null', async () => {
    const { deps } = makeDeps('android', { driveSense: null, lowPower: new Error('x') });
    const s = await createPermissionsAdapter(deps).snapshot();
    expect(s.motion).toBe('unavailable');
    expect(s.batteryOptimization).toBe('unknown');
    expect(s.lowPowerMode).toBeNull();
  });
});

describe('requestLocationAlways', () => {
  it('makes no OS call on iOS before the first completed drive and returns the current access', async () => {
    const { deps, calls } = makeDeps('ios', { bgAfterRequest: loc() });
    const access = await createPermissionsAdapter(deps).requestLocationAlways({ firstDriveDone: false });
    expect(access).toBe('foreground');
    expect(calls.filter((c) => c.includes('request'))).toEqual([]);
  });

  it('asks on iOS after the first drive', async () => {
    const { deps, calls } = makeDeps('ios', { bgAfterRequest: loc() });
    const access = await createPermissionsAdapter(deps).requestLocationAlways({ firstDriveDone: true });
    expect(access).toBe('always');
    expect(calls.filter((c) => c.includes('request'))).toEqual(['location.requestBackground']);
  });

  it('asks on Android before any drive', async () => {
    const { deps, calls } = makeDeps('android', { bgAfterRequest: loc() });
    expect(await createPermissionsAdapter(deps).requestLocationAlways({ firstDriveDone: false })).toBe('always');
    expect(calls).toContain('location.requestBackground');
  });

  it('never asks for Always without foreground location first (one prompt per screen)', async () => {
    const { deps, calls } = makeDeps('android', { fg: loc({ status: 'undetermined' }) });
    expect(await createPermissionsAdapter(deps).requestLocationAlways({ firstDriveDone: true })).toBe('undetermined');
    expect(calls.filter((c) => c.includes('request'))).toEqual([]);
  });

  it('does not re-ask when Always is already granted', async () => {
    const { deps, calls } = makeDeps('ios', { bg: loc() });
    expect(await createPermissionsAdapter(deps).requestLocationAlways({ firstDriveDone: true })).toBe('always');
    expect(calls.filter((c) => c.includes('request'))).toEqual([]);
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

  it('no drive-sense → unavailable', async () => {
    const { deps } = makeDeps('ios', { driveSense: null });
    expect(await createPermissionsAdapter(deps).requestMotion()).toBe('unavailable');
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

describe('readiness', () => {
  it('armed only when drive-sense says armed; allowed from its location and motion', async () => {
    const ds = createFakeDriveSense({ platform: 'android' });
    ds.setState({ location: 'always', motion: 'granted', armed: true });
    const { deps } = makeDeps('android', { driveSense: withBattery(ds) });
    expect(await createPermissionsAdapter(deps).readiness()).toEqual({ allowed: true, armed: true });
    ds.setState({ armed: false, motion: 'denied' });
    expect(await createPermissionsAdapter(deps).readiness()).toEqual({ allowed: false, armed: false });
  });

  it('armed is null when it could not be checked', async () => {
    const { deps } = makeDeps('ios', { driveSense: null });
    expect(await createPermissionsAdapter(deps).readiness()).toEqual({ allowed: false, armed: null });
    const failing: DriveSensePort = {
      getState: () => Promise.reject(new Error('x')),
      requestMotionPermission: () => Promise.resolve('denied'),
    };
    const f = makeDeps('ios', { driveSense: failing });
    expect(await createPermissionsAdapter(f.deps).readiness()).toEqual({ allowed: false, armed: null });
  });
});
