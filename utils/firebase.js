// utils/firebase.js
import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeAuth,
  getAuth,
  getReactNativePersistence,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { firebaseConfig, firebaseConfigError } from "./config";

// Reported, not thrown: see utils/config.js. App.js renders this message.
export const configError = firebaseConfigError();
if (configError) console.error(configError);

// Guard against double initialization: Fast Refresh and the background location task can
// both evaluate this module, and initializeAuth throws if called twice on the same app.
// With an incomplete config the SDK still initializes; every call simply fails, which is
// what the configuration screen in App.js is there to explain.
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

let auth;
try {
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(AsyncStorage),
  });
} catch (err) {
  auth = getAuth(app);
}

const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app);

export { app, auth, db, storage, functions };
