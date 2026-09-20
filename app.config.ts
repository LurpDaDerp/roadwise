import type { ConfigContext, ExpoConfig } from 'expo/config';

const EAS_PROJECT_ID = 'eb9c484d-45ef-4125-b146-3132b49af806';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'RoadWise',
  slug: 'SafeDriveApp',
  scheme: 'roadwise',
  version: '2.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  updates: { url: `https://u.expo.dev/${EAS_PROJECT_ID}` },
  runtimeVersion: { policy: 'appVersion' },
  ios: {
    bundleIdentifier: 'com.lurp.safedrive',
    supportsTablet: false,
    usesAppleSignIn: true,
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSLocationWhenInUseUsageDescription:
        'RoadWise reads your speed and the road you are on while you drive so it can coach you and score the drive.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'With Always access, RoadWise can start recording a drive by itself when your phone senses you are in a moving car, so you never have to open the app.',
      NSMotionUsageDescription:
        'Motion data tells RoadWise when a drive starts and ends, and helps spot hard braking or phone handling.',
      NSCameraUsageDescription:
        'Optional camera coaching looks for eyes off the road. Frames are processed on your phone and never saved or uploaded.',
      NSPhotoLibraryUsageDescription: 'Choose a profile photo.',
      UIBackgroundModes: ['location'],
    },
  },
  android: {
    package: 'com.lurp.safedrive',
    // A driver's whole local record — `roadwise.db` and the raw second-by-second traces beside it
    // — lives in the app's files directory, which Android auto-backup and `adb backup` would
    // otherwise copy off the device (security review I-4). On a family phone that backup is often
    // keyed to the parent's account, and it survives the uninstall and the in-app delete that are
    // supposed to be final. Nothing this app stores locally is worth restoring: every synced drive
    // comes back from the server on the next sign-in.
    allowBackup: false,
    // The trip map needs a Google Maps key at build time; without one Android draws a blank grey
    // tile and nothing crashes. iOS uses Apple Maps and needs no key.
    config: { googleMaps: { apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY } },
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#000000' },
    permissions: ['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS', 'android.permission.RECEIVE_BOOT_COMPLETED'],
  },
  extra: { eas: { projectId: EAS_PROJECT_ID } },
  plugins: [
    'expo-router',
    'expo-apple-authentication',
    'expo-secure-store',
    'expo-sqlite',
    'expo-audio',
    'expo-notifications',
    'expo-font',
    'expo-web-browser',
    [
      'expo-location',
      {
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        isAndroidMotionActivityEnabled: true,
      },
    ],
    ['expo-splash-screen', { image: './assets/splash.png', imageWidth: 160, resizeMode: 'contain', backgroundColor: '#000000' }],
  ],
  experiments: { typedRoutes: true },
});
