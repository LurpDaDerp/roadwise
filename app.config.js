// app.config.js
//
// Extends the static app.json with values read from the environment so that no project
// identifier is hard-coded in source. app.json stays the base config; this file only adds
// `extra` (consumed by utils/config.js) and the iOS URL scheme that Google sign-in needs.
//
// Local development: values come from .env (see .env.example).
// EAS builds: values come from EAS environment variables / secrets of the same name.
//
// This file must never throw - `expo export`, `eas build` and `expo start` all evaluate it,
// and a missing variable has to surface as a readable runtime error (utils/config.js), not
// as an unreadable config crash.

// The Expo CLI loads .env / .env.local into process.env before evaluating this file, so
// no dotenv dependency is needed locally. EAS builds do not upload .env - set the same
// names as EAS environment variables instead (see docs/BACKEND_AUDIT.md).

const REQUIRED = [
  'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'EXPO_PUBLIC_FIREBASE_APP_ID',
];

function warnAboutMissing() {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.warn(
      `[app.config.js] Missing environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env (local) or set them as EAS environment variables.'
    );
  }
}

// The Google iOS OAuth client requires the app to handle its reversed-client-id URL
// scheme. Deriving it from the client id keeps the two from drifting apart.
function reversedIosClientScheme() {
  const id = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  if (!id || !id.endsWith('.apps.googleusercontent.com')) return null;
  return `com.googleusercontent.apps.${id.replace('.apps.googleusercontent.com', '')}`;
}

module.exports = ({ config }) => {
  warnAboutMissing();

  const schemes = ['roadcash'];
  const googleScheme = reversedIosClientScheme();
  if (googleScheme) schemes.push(googleScheme);

  return {
    ...config,
    ios: {
      ...config.ios,
      infoPlist: {
        ...config.ios?.infoPlist,
        CFBundleURLTypes: [{ CFBundleURLSchemes: schemes }],
      },
    },
    android: {
      ...config.android,
      package: 'com.lurp.safedrive',
    },
    extra: {
      ...config.extra,
      firebaseApiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? null,
      firebaseAuthDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? null,
      firebaseProjectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? null,
      firebaseStorageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? null,
      firebaseMessagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? null,
      firebaseAppId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? null,
      firebaseMeasurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID ?? null,
      supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? null,
      supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? null,
      googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? null,
      googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? null,
      googleAndroidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? null,
    },
  };
};
