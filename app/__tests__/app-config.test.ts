/**
 * Task 18 round 1: the FCM credential is optional. With neither the EAS file variable nor a local
 * `google-services.json`, `android.googleServicesFile` is left out, so an Android build still
 * works (push stays off until Firebase is set up). The notification icon is always configured.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

import { HOST_RE } from '@/lib/linkDomain';

import appConfig, { ALWAYS_LOCATION_COPY, androidAppLinks, googleServicesFile, LINK_HOST_RE, PERMISSION_COPY } from '../../app.config';

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

// Drives start on their own with "Always" ("Allow all the time" on Android: the drive detector),
// and Start drive needs "While Using"; a drive records in the background (iOS location mode,
// Android foreground service); no microphone.
describe('permissions', () => {
  const plugin = (name: string) => {
    const entry = build().plugins?.find((p) => Array.isArray(p) && p[0] === name);
    return Array.isArray(entry) ? (entry[1] as Record<string, unknown>) : undefined;
  };

  test('iOS: the Always strings say drives are noticed and recorded with the app closed, and that the location is never sold', () => {
    const location = plugin('expo-location');
    expect(location).toMatchObject({
      locationWhenInUsePermission: PERMISSION_COPY.location,
      locationAlwaysAndWhenInUsePermission: ALWAYS_LOCATION_COPY,
      locationAlwaysPermission: ALWAYS_LOCATION_COPY,
      isIosBackgroundLocationEnabled: true,
      isAndroidBackgroundLocationEnabled: true,
      isAndroidForegroundServiceEnabled: true,
      isAndroidMotionActivityEnabled: true,
      motionUsagePermission: PERMISSION_COPY.motion,
    });
    // The plugin writes the usage strings; the app's own plist adds none of its own.
    const plist = build().ios?.infoPlist ?? {};
    expect(plist).not.toHaveProperty('NSLocationAlwaysAndWhenInUseUsageDescription');
    expect(plist).not.toHaveProperty('NSLocationAlwaysUsageDescription');
    expect(ALWAYS_LOCATION_COPY).toBe(
      'RoadWise notices when you start driving and records the drive, even when the app is closed. Your location is never sold.'
    );
    // plain copy: no em dash, no exclamation mark, no reminder
    for (const s of [ALWAYS_LOCATION_COPY, ...Object.values(PERMISSION_COPY)]) expect(s).not.toMatch(/\u2014|!|reminder|forgot/i);
  });

  test('Android: background location for automatic drives (not blocked, declared by drive-sense), never audio recording', () => {
    expect(build().android?.blockedPermissions).toContain('android.permission.RECORD_AUDIO');
    expect(build().android?.blockedPermissions).not.toContain('android.permission.ACCESS_BACKGROUND_LOCATION');
    const ROOT_DIR = path.join(__dirname, '..', '..');
    const manifest = fs.readFileSync(path.join(ROOT_DIR, 'modules/drive-sense/android/src/main/AndroidManifest.xml'), 'utf8');
    expect(manifest).toContain('<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />');
  });

  test('Android: no drawing over other apps, no media-playback foreground service (alerts play on the drive and DashPal services)', () => {
    expect(build().android?.blockedPermissions).toEqual(
      expect.arrayContaining(['android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK'])
    );
    expect(build().plugins).toContain('./plugins/withAndroidNoMediaPlaybackService');
    // iOS keeps expo-audio's background playback (the `audio` background mode).
    expect(plugin('expo-audio')).toMatchObject({ enableBackgroundPlayback: true });
  });

  test('Android never gets photo access: expo-screen-capture only keeps the aiming picture out of screenshots', () => {
    expect(build().android?.blockedPermissions).toContain('android.permission.READ_MEDIA_IMAGES');
    // Nor shared storage on Android 12 and older (expo-file-system, expo-image and expo-screen-capture declare it).
    expect(build().android?.blockedPermissions).toEqual(
      expect.arrayContaining(['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'])
    );
    // Its Android 14 screen-capture callback needs this install-time permission: never blocked.
    expect(build().android?.blockedPermissions).not.toContain('android.permission.DETECT_SCREEN_CAPTURE');
  });

  test("the boot permission comes from drive-sense's manifest only (the drive detector's boot receiver), not the app config", () => {
    expect(build().android?.permissions).not.toContain('android.permission.RECEIVE_BOOT_COMPLETED');
    const ROOT_DIR = path.join(__dirname, '..', '..');
    const manifest = fs.readFileSync(path.join(ROOT_DIR, 'modules/drive-sense/android/src/main/AndroidManifest.xml'), 'utf8');
    expect(manifest).toContain('<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />');
  });

  test('the camera is for friends’ QR codes only, with no microphone', () => {
    expect(plugin('expo-camera')).toEqual({
      cameraPermission: PERMISSION_COPY.camera,
      microphonePermission: false,
      recordAudioAndroid: false,
    });
    expect(PERMISSION_COPY.camera).toBe("RoadWise uses the camera only to scan your friends' QR codes. Nothing is recorded.");
    expect(PERMISSION_COPY.camera).not.toMatch(/dashpal/i);
  });

  test('the strings are plain and mention nothing v3 removed', () => {
    const words = Object.values(PERMISSION_COPY).join(' ').toLowerCase();
    for (const word of ['family', 'automatically', 'always', 'background', 'closed', 'driver monitoring', 'dms']) {
      expect(words).not.toContain(word);
    }
  });

  test('the Motion & Fitness string says what motion is for (driving, parking, walking away), and claims no braking or speed', () => {
    expect(PERMISSION_COPY.motion).toBe("RoadWise uses motion to tell when you're driving and when you've parked and walked away.");
    expect(PERMISSION_COPY.motion).not.toMatch(/brak|speed|detect/i);
  });

  test('the location string names every use: the drives and the local weather (Home’s alert and the sky)', () => {
    expect(PERMISSION_COPY.location).toBe('RoadWise measures speed and distance on your drives and checks the local weather.');
  });

  test('the deep link scheme stays roadwise', () => {
    expect(build().scheme).toBe('roadwise');
  });
});

// The share sheet's Save Image (drive card, Wrapped card) writes to Photos: iOS ends an app that does
// that without the add-only string. Nothing reads the library, so the read string stays out.
test('iOS: the add-to-Photos usage string, and no photo-library read string', () => {
  const plist = build().ios?.infoPlist ?? {};
  expect(plist.NSPhotoLibraryAddUsageDescription).toBe(PERMISSION_COPY.photosAdd);
  expect(PERMISSION_COPY.photosAdd).toBe('RoadWise saves the picture you share to your photo library when you choose Save Image.');
  expect(plist).not.toHaveProperty('NSPhotoLibraryUsageDescription');
});

// DashPal (plan §7.1): react-native-ble-manager with no config plugin. iOS gets the Bluetooth usage
// string and the `bluetooth-central` background mode. On Android the library's manifest never
// reaches the build (AGP 7.3+ points it at a file the package doesn't ship), so the scan permissions
// come from plugins/withAndroidBluetoothScan.js and the rest from drive-sense; nothing may put a
// maxSdkVersion on fine location (drive location on Android 12+ depends on it).
describe('Bluetooth (DashPal and the car check)', () => {
  const ROOT_DIR = path.join(__dirname, '..', '..');
  const manifest = (rel: string) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');

  test('iOS: the usage string and the bluetooth-central background mode', () => {
    const plist = build().ios?.infoPlist ?? {};
    expect(plist.NSBluetoothAlwaysUsageDescription).toBe(PERMISSION_COPY.bluetooth);
    expect(PERMISSION_COPY.bluetooth).toBe(
      "RoadWise connects to your DashPal dashcam over Bluetooth to play its alerts and add its events to your drives. It also checks that Bluetooth is on before asking whether you're driving."
    );
    expect(plist.UIBackgroundModes).toEqual(['bluetooth-central']);
  });

  test('no ble-manager config plugin; Bluetooth is not blocked on Android', () => {
    const names = (build().plugins ?? []).map((p) => (Array.isArray(p) ? p[0] : p));
    expect(names).not.toContain('react-native-ble-manager');
    expect(build().android?.blockedPermissions?.some((p) => /BLUETOOTH/.test(p))).toBe(false);
  });

  test("the library's manifest never reaches the build: the app declares SCAN never-for-location and ADMIN capped at 30", () => {
    // AGP 7.3+: ble-manager's build.gradle switches to a manifest the package doesn't ship.
    expect(manifest('node_modules/react-native-ble-manager/android/build.gradle')).toContain('manifest.srcFile "src/main/AndroidManifestNew.xml"');
    expect(fs.existsSync(path.join(ROOT_DIR, 'node_modules/react-native-ble-manager/android/src/main/AndroidManifestNew.xml'))).toBe(false);
    expect(build().plugins).toContain('./plugins/withAndroidBluetoothScan');
    type Perm = { $: Record<string, string> };
    type Manifest = { manifest: { $: Record<string, string>; 'uses-permission'?: Perm[] } };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the plugin is CommonJS, run by prebuild
    const scan = require('../../plugins/withAndroidBluetoothScan') as { addBluetoothScan(m: Manifest): Manifest };
    const fine = { $: { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' } };
    const out = scan.addBluetoothScan({ manifest: { $: {}, 'uses-permission': [fine, { $: { 'android:name': 'android.permission.BLUETOOTH_SCAN' } }] } });
    expect(out.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
    expect(out.manifest['uses-permission']).toEqual([
      fine,
      { $: { 'android:name': 'android.permission.BLUETOOTH_SCAN', 'android:usesPermissionFlags': 'neverForLocation', 'tools:targetApi': 's' } },
      { $: { 'android:name': 'android.permission.BLUETOOTH_ADMIN', 'android:maxSdkVersion': '30' } },
    ]);
    // CONNECT and legacy BLUETOOTH (capped at 30): the drive-sense module manifest.
    const ds = manifest('modules/drive-sense/android/src/main/AndroidManifest.xml');
    expect(ds).toContain('<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />');
    expect(ds).toMatch(/android\.permission\.BLUETOOTH"\s+android:maxSdkVersion="30"/);
  });

  test('fine location uncapped in every manifest that reaches the build', () => {
    for (const rel of [
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

// No DashPal link: the app declares no DashPal domain. The one link domain is the share links'
// (`ROADWISE_LINK_DOMAIN`): unset, there is no associated domain, no Android App Link and no
// extra.linkDomain; set, all three name it.
describe('the link domain', () => {
  const keys = ['DASHPAL_LINK_DOMAIN', 'ROADWISE_LINK_DOMAIN'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('unset: no associated domain, no App Link intent filter, no extra.linkDomain, whatever DASHPAL_LINK_DOMAIN says', () => {
    delete process.env.ROADWISE_LINK_DOMAIN;
    process.env.DASHPAL_LINK_DOMAIN = 'pair.example.com';
    const c = build();
    expect(c.ios).not.toHaveProperty('associatedDomains');
    expect(c.android).not.toHaveProperty('intentFilters');
    expect(c.extra).not.toHaveProperty('linkDomain');
  });

  test('blank counts as unset', () => {
    process.env.ROADWISE_LINK_DOMAIN = '  ';
    const c = build();
    expect(c.ios).not.toHaveProperty('associatedDomains');
    expect(c.android).not.toHaveProperty('intentFilters');
    expect(c.extra).not.toHaveProperty('linkDomain');
  });

  test('set: both phones open its links in the app (iOS applinks, an Android verified App Link) and the app reads it as extra.linkDomain', () => {
    process.env.ROADWISE_LINK_DOMAIN = ' RoadWise.app ';
    const c = build();
    expect(c.ios?.associatedDomains).toEqual(['applinks:roadwise.app']);
    expect(c.extra?.linkDomain).toBe('roadwise.app');
    expect(c.extra?.eas).toEqual({ projectId: expect.any(String) });
    // https only, the one host, the /w/ paths the apple-app-site-association names, verified.
    expect(c.android?.intentFilters).toEqual([
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: 'roadwise.app', pathPrefix: '/w/' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ]);
    expect(androidAppLinks(undefined)).toBeUndefined();
  });

  test("the link site's association files name the same paths for both phones, and ship no real fingerprint", () => {
    const ROOT_DIR = path.join(__dirname, '..', '..');
    const site = (rel: string) => fs.readFileSync(path.join(ROOT_DIR, 'web', 'link-site', '.well-known', rel), 'utf8');
    const aasa = JSON.parse(site('apple-app-site-association')) as {
      applinks: { details: { components: { '/': string }[] }[] };
    };
    expect(aasa.applinks.details[0]!.components[0]!['/']).toBe('/w/*');
    const links = JSON.parse(site('assetlinks.json')) as {
      relation: string[];
      target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
    }[];
    expect(links).toHaveLength(1);
    expect(links[0]!.relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(links[0]!.target.namespace).toBe('android_app');
    expect(links[0]!.target.package_name).toBe(build().android?.package);
    // Each entry is a placeholder the owner replaces (web/link-site/README.md) or a real SHA-256
    // certificate fingerprint (32 colon-separated upper-case hex pairs), never anything in between.
    const fingerprints = links[0]!.target.sha256_cert_fingerprints;
    expect(fingerprints).toHaveLength(2);
    for (const f of fingerprints) expect(f).toMatch(/^(PLAY_APP_SIGNING_SHA256|UPLOAD_KEY_SHA256|([0-9A-F]{2}:){31}[0-9A-F]{2})$/);
  });

  test.each(['https://roadwise.app', 'roadwise.app/', 'roadwise.app:443', 'roadwise', 'road wise.app'])('a value that is not a bare host name (%s) fails the config', (v) => {
    process.env.ROADWISE_LINK_DOMAIN = v;
    expect(() => build()).toThrow(/ROADWISE_LINK_DOMAIN must be a bare host name/);
  });

  test('the config checks the host with the same rule the app reads it with', () => {
    expect(LINK_HOST_RE.source).toBe(HOST_RE.source);
  });
});

// App Store Connect rejects an upload whose "required reason" API use has no declared reason
// (ITMS-91053). The declared categories follow what the native Swift sources actually call.
describe('iOS privacy manifest', () => {
  const ROOT_DIR = path.join(__dirname, '..', '..');
  const IOS_DIR = path.join(ROOT_DIR, 'modules', 'drive-sense', 'ios');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
  const { readdirSync } = require('node:fs') as { readdirSync(dir: string): string[] };
  const swift = readdirSync(IOS_DIR)
    .filter((f) => f.endsWith('.swift'))
    .map((f) => fs.readFileSync(path.join(IOS_DIR, f), 'utf8'))
    .join('\n');
  const declared = () =>
    Object.fromEntries(
      (build().ios?.privacyManifests?.NSPrivacyAccessedAPITypes ?? []).map((t) => [
        t.NSPrivacyAccessedAPIType,
        t.NSPrivacyAccessedAPITypeReasons,
      ])
    );

  test('UserDefaults (app-only, CA92.1) and system boot time (elapsed time, 35F9.1) are declared', () => {
    expect(declared()).toEqual({
      NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1'],
      NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1'],
    });
  });

  test('the declared categories match what drive-sense Swift calls', () => {
    expect(swift).toMatch(/UserDefaults\.standard/);
    expect(swift).toMatch(/systemUptime/);
    // An app-group suite would need reason 1C8F.1, and these categories need their own entries.
    expect(swift).not.toMatch(/UserDefaults\(suiteName/);
    expect(swift).not.toMatch(/creationDate|modificationDate|attributesOfItem|volumeAvailableCapacity|activeInputModes|mach_absolute_time/);
  });
});

// Android's own pieces of the config (Play readiness): the themed icon, the backup rules and the
// removed media-playback service. Each plugin only touches the Android project.
describe('Android: themed icon, no backup or phone-to-phone copy, no media service', () => {
  const ROOT_DIR = path.join(__dirname, '..', '..');
  type Service = { $: Record<string, string> };
  type Manifest = { manifest: { $: Record<string, string>; application: { $: Record<string, string>; service?: Service[] }[] } };
  const manifest = (service?: Service[]): Manifest => ({
    manifest: {
      $: {},
      application: [{ $: { 'android:name': '.MainApplication', 'android:allowBackup': 'false' }, ...(service ? { service } : {}) }],
    },
  });
  /* eslint-disable @typescript-eslint/no-require-imports -- the plugins are CommonJS, run by prebuild */
  const noData = require('../../plugins/withAndroidNoDataExtraction') as {
    applyNoDataExtraction(m: Manifest): Manifest;
    BACKUP_XML: string;
    EXTRACTION_XML: string;
    DOMAINS: string[];
  };
  const noMedia = require('../../plugins/withAndroidNoMediaPlaybackService') as {
    removeMediaPlaybackService(m: Manifest): Manifest;
    SERVICE: string;
  };
  /* eslint-enable @typescript-eslint/no-require-imports */

  test('the monochrome icon: a 1024 x 1024 PNG with alpha, the same canvas as the foreground', () => {
    expect(build().android?.adaptiveIcon).toEqual({
      foregroundImage: './assets/adaptive-icon.png',
      backgroundImage: './assets/adaptive-icon-background.png',
      monochromeImage: './assets/adaptive-icon-monochrome.png',
      backgroundColor: '#000814',
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
    const { readFileSync } = require('node:fs') as { readFileSync(file: string): Uint8Array };
    const ihdr = (file: string) => {
      const b = readFileSync(path.join(ROOT_DIR, 'assets', file));
      const u32 = (at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
      return { width: u32(16), height: u32(20), colourType: b[25] };
    };
    // Colour type 6: RGBA.
    expect(ihdr('adaptive-icon-monochrome.png')).toEqual({ width: 1024, height: 1024, colourType: 6 });
    expect(ihdr('adaptive-icon.png')).toMatchObject({ width: 1024, height: 1024 });
  });

  test('the backup rules: allowBackup stays false, and every domain is excluded from cloud backup, the device transfer and the old full backup', () => {
    expect(build().android?.allowBackup).toBe(false);
    expect(build().plugins).toContain('./plugins/withAndroidNoDataExtraction');
    // expo-secure-store's rules (which copy every other preference) are off.
    expect(build().plugins).toContainEqual(['expo-secure-store', { configureAndroidBackup: false }]);
    const app = noData.applyNoDataExtraction(manifest()).manifest.application[0]!.$;
    expect(app).toMatchObject({
      'android:allowBackup': 'false',
      'android:fullBackupContent': '@xml/roadwise_backup_rules',
      'android:dataExtractionRules': '@xml/roadwise_data_extraction_rules',
    });
    const cloud = noData.EXTRACTION_XML.split('<cloud-backup>')[1]!.split('</cloud-backup>')[0]!;
    const transfer = noData.EXTRACTION_XML.split('<device-transfer>')[1]!.split('</device-transfer>')[0]!;
    for (const part of [cloud, transfer, noData.BACKUP_XML]) {
      expect(part).not.toContain('<include');
      for (const d of noData.DOMAINS) expect(part).toContain(`<exclude domain="${d}" path="." />`);
    }
    expect(noData.DOMAINS).toEqual(expect.arrayContaining(['root', 'file', 'database', 'sharedpref', 'external']));
  });

  test("expo-audio's lock-screen service is removed whichever plugin runs first", () => {
    const marker = { $: { 'android:name': noMedia.SERVICE, 'tools:node': 'remove' } };
    const listed = noMedia.removeMediaPlaybackService(
      manifest([{ $: { 'android:name': noMedia.SERVICE, 'android:foregroundServiceType': 'mediaPlayback' } }])
    );
    expect(listed.manifest.application[0]!.service).toEqual([marker]);
    expect(listed.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
    expect(noMedia.removeMediaPlaybackService(manifest()).manifest.application[0]!.service).toEqual([marker]);
    const other = { $: { 'android:name': '.Other' } };
    expect(noMedia.removeMediaPlaybackService(manifest([other])).manifest.application[0]!.service).toEqual([other, marker]);
  });
});
