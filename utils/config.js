// utils/config.js
//
// Single source of truth for every build-time configuration value.
//
// Values come from two places, in this order:
//   1. process.env.EXPO_PUBLIC_*  - inlined into the JS bundle by Expo at build time.
//   2. Constants.expoConfig.extra - populated by app.config.js (also from process.env),
//      which is what EAS builds and `expo export` see.
//
// Nothing here is a secret: everything in this file ships inside the app binary and is
// readable by anyone who downloads it. The Firebase web config and the Supabase anon key
// are public identifiers by design - they are protected by Firestore rules and Supabase
// Row Level Security, not by being hidden. They live in env files so the project can be
// re-pointed (staging vs production) without editing source, which is what the owner
// asked for in TODO.md item 5.
//
// Real secrets (OpenAI, HERE) are never in this file. They are Cloud Functions secrets.

import Constants from 'expo-constants';

const extra = Constants?.expoConfig?.extra ?? Constants?.manifest?.extra ?? {};

function read(envValue, extraKey) {
  const value = envValue ?? extra[extraKey];
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

export const firebaseConfig = {
  apiKey: read(process.env.EXPO_PUBLIC_FIREBASE_API_KEY, 'firebaseApiKey'),
  authDomain: read(process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN, 'firebaseAuthDomain'),
  projectId: read(process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID, 'firebaseProjectId'),
  storageBucket: read(process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET, 'firebaseStorageBucket'),
  messagingSenderId: read(
    process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    'firebaseMessagingSenderId'
  ),
  appId: read(process.env.EXPO_PUBLIC_FIREBASE_APP_ID, 'firebaseAppId'),
  measurementId: read(process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID, 'firebaseMeasurementId'),
};

export const supabaseConfig = {
  url: read(process.env.EXPO_PUBLIC_SUPABASE_URL, 'supabaseUrl'),
  anonKey: read(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY, 'supabaseAnonKey'),
};

export const googleAuthConfig = {
  webClientId: read(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID, 'googleWebClientId'),
  iosClientId: read(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID, 'googleIosClientId'),
  androidClientId: read(process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID, 'googleAndroidClientId'),
};

const REQUIRED_FIREBASE_KEYS = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
];

export function assertFirebaseConfig() {
  const missing = REQUIRED_FIREBASE_KEYS.filter((key) => !firebaseConfig[key]);
  if (missing.length === 0) return;

  throw new Error(
    `Firebase configuration is missing: ${missing.join(', ')}.\n` +
      'Copy .env.example to .env and fill it in (values are in the Firebase console under ' +
      'Project settings > Your apps > Web app), then restart the bundler with ' +
      '`npx expo start --clear`. For EAS builds set the same names as EAS environment ' +
      'variables - see docs/BACKEND_AUDIT.md.'
  );
}

export function isSupabaseConfigured() {
  return Boolean(supabaseConfig.url && supabaseConfig.anonKey);
}
