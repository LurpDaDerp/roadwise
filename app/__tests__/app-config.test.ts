/**
 * Task 18 round 1: the FCM credential is optional. With neither the EAS file variable nor a local
 * `google-services.json`, `android.googleServicesFile` is left out, so an Android build still
 * works (push stays off until Firebase is set up). The notification icon is always configured.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

import appConfig, { googleServicesFile, PERMISSION_COPY, REMINDER_LOCATION_COPY } from '../../app.config';

// Local shapes: the app's tsconfig carries no Node types.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the same module app.config reads
const fs = require('node:fs') as { existsSync(file: string): boolean; readFileSync(file: string, enc: 'utf8'): string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
const path = require('node:path') as { join(...parts: string[]): string };
declare const __dirname: string;

const ROOT = '/work/roadwise';
const LOCAL = `${ROOT}/google-services.json`;

function build(): ExpoConfig {
  return appConfig({ config: {}, projectRoot: ROOT } as unknown as ConfigContext);
}

const saved = process.env.GOOGLE_SERVICES_JSON;
afterEach(() => {
  if (saved === undefined) delete process.env.GOOGLE_SERVICES_JSON;
  else process.env.GOOGLE_SERVICES_JSON = saved;
  jest.restoreAllMocks();
});

describe('googleServicesFile', () => {
  test('the EAS file variable wins', () => {
    expect(googleServicesFile(ROOT, { GOOGLE_SERVICES_JSON: '/eas/tmp/gs.json' }, () => false)).toBe(
      '/eas/tmp/gs.json'
    );
  });

  test('else a local google-services.json at the project root', () => {
    const seen: string[] = [];
    const exists = (f: string) => {
      seen.push(f);
      return true;
    };
    expect(googleServicesFile(`${ROOT}/`, {}, exists)).toBe('./google-services.json');
    expect(seen).toEqual([LOCAL]);
  });

  test('else nothing (an empty variable counts as unset)', () => {
    expect(googleServicesFile(ROOT, {}, () => false)).toBeUndefined();
    expect(googleServicesFile(ROOT, { GOOGLE_SERVICES_JSON: '' }, () => false)).toBeUndefined();
  });
});

describe('the Android config', () => {
  test('no credential: the key is left out entirely', () => {
    delete process.env.GOOGLE_SERVICES_JSON;
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(build().android).not.toHaveProperty('googleServicesFile');
  });

  test('with the EAS file variable: it is the path', () => {
    process.env.GOOGLE_SERVICES_JSON = '/eas/tmp/gs.json';
    expect(build().android?.googleServicesFile).toBe('/eas/tmp/gs.json');
  });

  test('with a local file: the relative path', () => {
    delete process.env.GOOGLE_SERVICES_JSON;
    jest.spyOn(fs, 'existsSync').mockImplementation((f: string) => f === LOCAL);
    expect(build().android?.googleServicesFile).toBe('./google-services.json');
  });

  test('the notification icon and its tint are configured either way', () => {
    delete process.env.GOOGLE_SERVICES_JSON;
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(build().plugins).toContainEqual([
      'expo-notifications',
      { icon: './assets/notification-icon.png', color: '#FFC300' },
    ]);
  });
});

// C0 round 1 (review-C0 C0-I1): the release gate for the row-contract change. With the appVersion
// policy, a later OTA published from a pre-C0 commit would reach a C0 binary of the same version, and
// that old bundle's strict parseRow would drop every row of every drive. The fingerprint policy gives
// each native state its own runtime, so JS only ever reaches a binary built from the same native code.
describe('the runtime version (release gate, C0-I1)', () => {
  test('is the fingerprint policy, never appVersion', () => {
    expect(build().runtimeVersion).toEqual({ policy: 'fingerprint' });
  });

  test('EAS Update is configured (the policy is only meaningful with an update URL)', () => {
    expect(build().updates?.url).toMatch(/^https:\/\/u\.expo\.dev\//);
  });
});

// v3: every drive starts in the app and needs "While Using" location only; a started drive keeps
// running in the background (iOS location mode, Android foreground service); no microphone. The iOS
// "Always" strings exist for the optional forgot-to-start reminder alone (asked only when the driver
// turns it on); Android never gets background location.
describe('permissions (v3)', () => {
  const plugin = (name: string) => {
    const entry = build().plugins?.find((p) => Array.isArray(p) && p[0] === name);
    return Array.isArray(entry) ? (entry[1] as Record<string, unknown>) : undefined;
  };

  test('a drive needs While Using; the Always strings name the forgot-to-start reminder and nothing else', () => {
    const location = plugin('expo-location');
    expect(location).toMatchObject({
      locationWhenInUsePermission: PERMISSION_COPY.location,
      locationAlwaysAndWhenInUsePermission: REMINDER_LOCATION_COPY,
      locationAlwaysPermission: REMINDER_LOCATION_COPY,
      isIosBackgroundLocationEnabled: true,
      isAndroidBackgroundLocationEnabled: false,
      isAndroidForegroundServiceEnabled: true,
      isAndroidMotionActivityEnabled: true,
      motionUsagePermission: PERMISSION_COPY.motion,
    });
    // The plugin writes the usage strings; the app's own plist adds none of its own.
    const plist = build().ios?.infoPlist ?? {};
    expect(plist).not.toHaveProperty('NSLocationAlwaysAndWhenInUseUsageDescription');
    expect(plist).not.toHaveProperty('NSLocationAlwaysUsageDescription');
    expect(REMINDER_LOCATION_COPY.startsWith('Only if you turn on the forgot-to-start reminder')).toBe(true);
    expect(REMINDER_LOCATION_COPY).toContain('stays on your phone');
  });

  test('Android never gets background location or audio recording', () => {
    expect(build().android?.blockedPermissions).toEqual(
      expect.arrayContaining(['android.permission.ACCESS_BACKGROUND_LOCATION', 'android.permission.RECORD_AUDIO'])
    );
  });

  test("the boot permission comes from drive-sense's manifest only (the reminder's boot receiver), not the app config", () => {
    expect(build().android?.permissions).not.toContain('android.permission.RECEIVE_BOOT_COMPLETED');
    const ROOT_DIR = path.join(__dirname, '..', '..');
    const manifest = fs.readFileSync(path.join(ROOT_DIR, 'modules/drive-sense/android/src/main/AndroidManifest.xml'), 'utf8');
    expect(manifest).toContain('<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />');
  });

  test('the camera is for QR codes only, with no microphone', () => {
    expect(plugin('expo-camera')).toEqual({
      cameraPermission: PERMISSION_COPY.camera,
      microphonePermission: false,
      recordAudioAndroid: false,
    });
  });

  test('the strings are plain and mention nothing v3 removed', () => {
    const words = Object.values(PERMISSION_COPY).join(' ').toLowerCase();
    for (const word of ['family', 'automatically', 'always', 'background', 'closed', 'driver monitoring', 'dms']) {
      expect(words).not.toContain(word);
    }
  });

  test('the Motion & Fitness string says what motion activity is for, and claims no braking or speed', () => {
    expect(PERMISSION_COPY.motion).toBe(
      'RoadWise uses motion activity to tell when you walk away from your car, so a drive you forgot to end stops where you parked, and so the optional forgot-to-start reminder can notice a trip.'
    );
    expect(PERMISSION_COPY.motion).not.toMatch(/brak|speed|detect/i);
  });

  test('the deep link scheme stays roadwise', () => {
    expect(build().scheme).toBe('roadwise');
  });
});

// DashPal (plan §7.1): react-native-ble-manager with no config plugin. iOS gets the Bluetooth usage
// string and the `bluetooth-central` background mode; Android takes its permissions from the
// library's manifest, which must never put a maxSdkVersion on fine location (drive location on
// Android 12+ depends on it).
describe('Bluetooth (DashPal)', () => {
  const ROOT_DIR = path.join(__dirname, '..', '..');
  const manifest = (rel: string) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');

  test('iOS: the usage string and the bluetooth-central background mode', () => {
    const plist = build().ios?.infoPlist ?? {};
    expect(plist.NSBluetoothAlwaysUsageDescription).toBe(PERMISSION_COPY.bluetooth);
    expect(PERMISSION_COPY.bluetooth).toBe(
      'RoadWise connects to your DashPal dashcam over Bluetooth to play its alerts on your phone and add its events to your drives.'
    );
    expect(plist.UIBackgroundModes).toEqual(['bluetooth-central']);
  });

  test('no ble-manager config plugin; Bluetooth is not blocked on Android', () => {
    const names = (build().plugins ?? []).map((p) => (Array.isArray(p) ? p[0] : p));
    expect(names).not.toContain('react-native-ble-manager');
    expect(build().android?.blockedPermissions?.some((p) => /BLUETOOTH/.test(p))).toBe(false);
  });

  test('the library manifest: SCAN never-for-location, CONNECT, legacy BLUETOOTH capped at 30, fine location uncapped everywhere', () => {
    const ble = manifest('node_modules/react-native-ble-manager/android/src/main/AndroidManifest.xml');
    expect(ble).toMatch(/android\.permission\.BLUETOOTH_SCAN"\s+android:usesPermissionFlags="neverForLocation"/);
    expect(ble).toContain('android.permission.BLUETOOTH_CONNECT');
    expect(ble).toMatch(/android\.permission\.BLUETOOTH"\s+android:maxSdkVersion="30"/);
    for (const rel of [
      'node_modules/react-native-ble-manager/android/src/main/AndroidManifest.xml',
      'node_modules/expo-location/android/src/main/AndroidManifest.xml',
      'modules/drive-sense/android/src/main/AndroidManifest.xml',
    ]) {
      const fine = manifest(rel)
        .split('<uses-permission')
        .filter((chunk) => chunk.includes('ACCESS_FINE_LOCATION'));
      expect(fine.length).toBeGreaterThan(0);
      for (const chunk of fine) expect(chunk.split('/>')[0]).not.toContain('maxSdkVersion');
    }
  });
});
