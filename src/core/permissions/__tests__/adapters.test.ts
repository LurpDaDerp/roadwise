import { createFakeDriveSense } from '@drive-sense';

import {
  createPermissionsAdapter,
  type LocationAnswer,
  type NotificationAnswer,
  type PermissionsAdapterDeps,
  type RadioState,
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
  function bt(platform: PermissionPlatform, o: { radio?: RadioState | null; started?: RadioState; level?: number; checks?: Record<string, boolean>; answers?: Record<string, string> } = {}) {
    const { deps, calls } = makeDeps(platform);
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

  it('Android read: not granted is undetermined with no prompt and no radio; granted reads the radio', async () => {
    const no = bt('android', { level: 34 });
    expect(await no.adapter.bluetooth()).toBe('undetermined');
    expect(no.calls.some((c) => c.startsWith('request') || c.startsWith('bt.'))).toBe(false);
    const yes = bt('android', { level: 34, checks: { 'android.permission.BLUETOOTH_SCAN': true, 'android.permission.BLUETOOTH_CONNECT': true }, started: 'on' });
    expect(await yes.adapter.bluetooth()).toBe('granted');
  });
});
