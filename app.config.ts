import type { ConfigContext, ExpoConfig } from 'expo/config';

// The app's tsconfig carries no Node types: local shapes, as the repo's other Node reads do.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config runs in Node only
const fs = require('node:fs') as { existsSync(file: string): boolean };

const EAS_PROJECT_ID = 'eb9c484d-45ef-4125-b146-3132b49af806';

/**
 * FCM, for server pushes (Task 18, round 1 ruling): the EAS file variable, else a local
 * `google-services.json` beside this file (git-ignored, never committed), else nothing. Without
 * one, Android builds still work and Android push stays off until Firebase is set up.
 */
export function googleServicesFile(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
  exists: (file: string) => boolean = (file) => fs.existsSync(file)
): string | undefined {
  const fromEnv = env.GOOGLE_SERVICES_JSON;
  if (fromEnv) return fromEnv;
  const local = `${projectRoot.replace(/[\\/]+$/, '')}/google-services.json`;
  return exists(local) ? './google-services.json' : undefined;
}

/**
 * The permission strings, in plain words. Location measures the drive and reads the rough area for
 * the weather; Motion & Fitness tells driving from parking and walking away (iOS: drives start and
 * end on their own with it).
 */
export const PERMISSION_COPY = {
  location: 'RoadWise measures speed and distance on your drives and checks the local weather.',
  motion: "RoadWise uses motion to tell when you're driving and when you've parked and walked away.",
  camera: "RoadWise uses the camera only to scan your friends' QR codes. Nothing is recorded.",
  bluetooth: 'RoadWise connects to your DashPal dashcam over Bluetooth to play its alerts on your phone and add its events to your drives.',
} as const;

/**
 * The iOS "Always" string: drives start and record on their own (the drive detector in
 * modules/drive-sense). Asked once, from While Using, at onboarding (`DriveDetect.requestAlways`).
 */
export const ALWAYS_LOCATION_COPY =
  'RoadWise notices when you start driving and records the drive, even when the app is closed. Your location is never sold.';

/** `{ [key]: value }`, or nothing when the value is undefined (the key is left out entirely). */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

export default ({ config, projectRoot }: ConfigContext): ExpoConfig => {
  return {
    ...config,
    name: 'RoadWise',
    slug: 'SafeDriveApp',
    scheme: 'roadwise',
    version: '2.0.0',
    // Not locked at the app level: the root Stack pins every screen to portrait and only the drive
    // HUD route opts into landscape, for a phone mounted sideways on the dash (plan rev1: I17).
    orientation: 'default',
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    updates: { url: `https://u.expo.dev/${EAS_PROJECT_ID}` },
    // The fingerprint of the native project, not the app version (C0 round 1, review-C0 C0-I1): the row
    // contract changes with native code, and under appVersion a later OTA from an older commit could
    // reach a new binary whose rows the old bundle's parser rejects. Each native state
    // is its own runtime, so an update only ever reaches binaries built from the same native code.
    runtimeVersion: { policy: 'fingerprint' },
    ios: {
      bundleIdentifier: 'com.lurp.safedrive',
      supportsTablet: false,
      usesAppleSignIn: true,
      config: { usesNonExemptEncryption: false },
      // Drives start on their own with "Always" and record in the background (the `location`
      // background mode, from expo-location below; a Start-card drive keeps recording on "While
      // Using"); alerts play with the screen locked (`audio`, from expo-audio). The usage strings are
      // set by the plugins below.
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        // The Live Activity / Dynamic Island for a drive in progress (modules/live-drive +
        // targets/live-drive-widget), started locally or by RoadWise's push-to-start.
        NSSupportsLiveActivities: true,
        // The DashPal dashcam (react-native-ble-manager, no config plugin: its plugin can add
        // location permissions with a maxSdkVersion that would break drive location on Android 12+).
        // The usage string is shown only to a driver who sets up a DashPal (the BLE manager is never
        // created otherwise); `bluetooth-central` keeps the link and state restoration while the app
        // is in the background. expo-location and expo-audio append `location` and `audio` to this
        // list (both dedupe).
        NSBluetoothAlwaysUsageDescription: PERMISSION_COPY.bluetooth,
        UIBackgroundModes: ['bluetooth-central'],
        // The driving screen's navigation button finds the navigation apps installed with
        // canOpenURL, which answers false for any scheme not listed here. Exactly the iOS schemes of
        // src/features/navigation/catalog.ts, in order (src/features/navigation/__tests__/apps.test.ts holds them equal).
        LSApplicationQueriesSchemes: ['maps', 'comgooglemaps', 'waze', 'here-route', 'com.sygic.aura', 'tomtomgo', 'magicearth', 'osmandmaps', 'om', 'mapquest', 'yandexnavi'],
      },
      // App Attest (@expo/app-integrity, src/data/devices/appAttest.ts): every drive upload is signed by a
      // key Apple attested, and the server checks it. Production in every build: App Store and
      // TestFlight builds use production whatever this says, and one value keeps the native
      // fingerprint (and so the OTA updates' runtime) the same for every EAS profile and for
      // `eas update`. EAS turns the App Attest capability on for the App ID from this entitlement.
      entitlements: { 'com.apple.developer.devicecheck.appattest-environment': 'production' },
      // Signing for the widget extension target (@bacons/apple-targets reads it). Set
      // EXPO_APPLE_TEAM_ID (EAS: an environment variable) or replace it with the team ID from Xcode.
      ...optional('appleTeamId', process.env.EXPO_APPLE_TEAM_ID),
      // The app's privacy manifest: the "required reason" APIs drive-sense's Swift calls
      // (UserDefaults.standard in CaptureController, DetectStateRecord and DriveDetectAccess, read and
      // written by this app only; ProcessInfo.systemUptime in TimeBase, to time events within the
      // app). The row journal reads no file timestamps or disk space. App Store
      // Connect rejects an upload without them (ITMS-91053). app/__tests__/app-config.test.ts holds
      // this list to the APIs the Swift sources use.
      privacyManifests: {
        NSPrivacyAccessedAPITypes: [
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
        ],
      },
    },
    android: {
      package: 'com.lurp.safedrive',
      // A driver's whole local record — `roadwise.db` and the raw second-by-second traces beside it
      // — lives in the app's files directory, which Android auto-backup and `adb backup` would
      // otherwise copy off the device (security review I-4), and it survives the uninstall and the
      // in-app delete that are supposed to be final. Nothing this app stores locally is worth restoring: every synced drive
      // comes back from the server on the next sign-in.
      allowBackup: false,
      // The trip map needs a Google Maps key at build time; without one Android draws a blank grey
      // tile and nothing crashes. iOS uses Apple Maps and needs no key.
      // Left out when unset or empty, so a local `.env` with a blank key and an EAS build with no key
      // produce the same config — and the same fingerprint runtime version.
      ...optional(
        'config',
        process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY
          ? { googleMaps: { apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY } }
          : undefined
      ),
      adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#000814' },
      // Left out when there is no FCM credential: see `googleServicesFile` above.
      ...optional('googleServicesFile', googleServicesFile(projectRoot)),
      // Bluetooth (DashPal): BLUETOOTH_SCAN (neverForLocation) and BLUETOOTH_CONNECT on Android 12+,
      // BLUETOOTH/BLUETOOTH_ADMIN (maxSdkVersion 30) below, come from react-native-ble-manager's own
      // manifest. The DashPal link service (connectedDevice, with FOREGROUND_SERVICE_CONNECTED_DEVICE,
      // both in the drive-sense module manifest) keeps the process alive while a DashPal is paired, so
      // the phone plays the dashcam's alerts in the background; the drive's location service does so
      // during a drive.
      permissions: ['android.permission.POST_NOTIFICATIONS', 'android.permission.VIBRATE'],
      // Every drive starts in the app and the forgot-to-start reminder uses activity recognition
      // only, so background ("all the time") location is never asked for, whatever a library's
      // manifest declares. The camera never records sound. expo-screen-capture (the DashPal aiming
      // picture kept out of screenshots, FLAG_SECURE) declares photo access for a screenshot
      // listener RoadWise never adds: blocked. Its DETECT_SCREEN_CAPTURE stays (an install-time
      // permission its Android 14 callback needs). Shared storage (Android 12 and older, declared by
      // expo-file-system, expo-image and expo-screen-capture) is blocked too: the data export goes
      // to the app's cache or a folder the driver picks (the system picker needs no permission).
      blockedPermissions: [
        'android.permission.ACCESS_BACKGROUND_LOCATION',
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ],
    },
    extra: { eas: { projectId: EAS_PROJECT_ID } },
    plugins: [
      'expo-router',
      'expo-apple-authentication',
      'expo-secure-store',
      'expo-sqlite',
      // Alerts must sound with the screen locked (plan R14): background playback adds the iOS
      // `audio` background mode. The app never records, so no microphone prompt and no
      // RECORD_AUDIO permission.
      ['expo-audio', { microphonePermission: false, recordAudioAndroid: false, enableBackgroundPlayback: true }],
      // The Android status-bar icon: the app mark as a white glyph on transparent (96 x 96), tinted
      // school-bus yellow in the shade.
      ['expo-notifications', { icon: './assets/notification-icon.png', color: '#FFC300' }],
      'expo-font',
      'expo-web-browser',
      [
        'expo-location',
        {
          locationWhenInUsePermission: PERMISSION_COPY.location,
          // iOS: "Always" lets drives start on their own; Start drive needs "While Using" only.
          locationAlwaysAndWhenInUsePermission: ALWAYS_LOCATION_COPY,
          locationAlwaysPermission: ALWAYS_LOCATION_COPY,
          motionUsagePermission: PERMISSION_COPY.motion,
          // iOS: a drive records in the background (on its own with Always, from Start with While Using).
          isIosBackgroundLocationEnabled: true,
          isAndroidBackgroundLocationEnabled: false,
          // Android keeps a started drive running through its location foreground service.
          isAndroidForegroundServiceEnabled: true,
          isAndroidMotionActivityEnabled: true,
        },
      ],
      // QR codes: friend codes only. No microphone, on either platform.
      [
        'expo-camera',
        { cameraPermission: PERMISSION_COPY.camera, microphonePermission: false, recordAudioAndroid: false },
      ],
      ['expo-splash-screen', { image: './assets/splash.png', imageWidth: 160, resizeMode: 'contain', backgroundColor: '#000814' }],
      // Apple extension targets from /targets: the Live Activity widget (targets/live-drive-widget).
      '@bacons/apple-targets',
    ],
    experiments: { typedRoutes: true },
  };
};
