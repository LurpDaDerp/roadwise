/**
 * Task 18 round 1: the FCM credential is optional. With neither the EAS file variable nor a local
 * `google-services.json`, `android.googleServicesFile` is left out, so an Android build still
 * works (push stays off until Firebase is set up). The notification icon is always configured.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

import appConfig, { googleServicesFile, PERMISSION_COPY } from '../../app.config';

// Local shapes: the app's tsconfig carries no Node types.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the same module app.config reads
const fs = require('node:fs') as { existsSync(file: string): boolean };

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

// v3: every drive starts in the app. "While Using" location only, never Always; a started drive keeps
// running in the background (iOS location mode, Android foreground service); no microphone.
describe('permissions (v3)', () => {
  const plugin = (name: string) => {
    const entry = build().plugins?.find((p) => Array.isArray(p) && p[0] === name);
    return Array.isArray(entry) ? (entry[1] as Record<string, unknown>) : undefined;
  };

  test('location is While Using only, and the Always strings are removed', () => {
    const location = plugin('expo-location');
    expect(location).toMatchObject({
      locationWhenInUsePermission: PERMISSION_COPY.location,
      locationAlwaysAndWhenInUsePermission: false,
      locationAlwaysPermission: false,
      isIosBackgroundLocationEnabled: true,
      isAndroidBackgroundLocationEnabled: false,
      isAndroidForegroundServiceEnabled: true,
      isAndroidMotionActivityEnabled: true,
      motionUsagePermission: PERMISSION_COPY.motion,
    });
    const plist = build().ios?.infoPlist ?? {};
    expect(plist).not.toHaveProperty('NSLocationAlwaysAndWhenInUseUsageDescription');
    expect(plist).not.toHaveProperty('NSLocationAlwaysUsageDescription');
  });

  test('Android never gets background location or audio recording', () => {
    expect(build().android?.blockedPermissions).toEqual(
      expect.arrayContaining(['android.permission.ACCESS_BACKGROUND_LOCATION', 'android.permission.RECORD_AUDIO'])
    );
    expect(build().android?.permissions).not.toContain('android.permission.RECEIVE_BOOT_COMPLETED');
  });

  test('the camera is for DMS and QR codes, with no microphone', () => {
    expect(plugin('expo-camera')).toEqual({
      cameraPermission: PERMISSION_COPY.camera,
      microphonePermission: false,
      recordAudioAndroid: false,
    });
  });

  test('the strings are plain and mention nothing v3 removed', () => {
    const words = Object.values(PERMISSION_COPY).join(' ').toLowerCase();
    for (const word of ['family', 'automatically', 'always', 'background', 'closed']) {
      expect(words).not.toContain(word);
    }
  });

  test('the deep link scheme stays roadwise', () => {
    expect(build().scheme).toBe('roadwise');
  });
});
