/**
 * Task 18 round 1: the FCM credential is optional. With neither the EAS file variable nor a local
 * `google-services.json`, `android.googleServicesFile` is left out, so an Android build still
 * works (push stays off until Firebase is set up). The notification icon is always configured.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

import appConfig, { googleServicesFile } from '../../app.config';

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
      { icon: './assets/notification-icon.png', color: '#1C3F94' },
    ]);
  });
});
