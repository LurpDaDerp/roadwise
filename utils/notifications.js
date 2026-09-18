// notifications.js
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { doc, deleteDoc, updateDoc, deleteField } from "firebase/firestore";
import { auth, db } from "./firebase";
import { savePushToken } from "./firestore";
import { KEYS } from "./storageKeys";

export async function requestNotificationPermissions() {
  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

//Push Notifs

// One registration per app RUN. RootNavigator registers at start-up and DrivePrepScreen
// registers before every drive; without this the second and later calls each cost an HTTP
// round trip to Expo for a token that cannot have changed since the first one minutes ago.
let registeredThisRun = null;   // `${uid}:${token}` of the last successful registration

export async function registerForPushNotificationsAsync() {
  const { status } = await Notifications.getPermissionsAsync();
  let finalStatus = status;

  if (finalStatus !== "granted") {
    const { status: askStatus } = await Notifications.requestPermissionsAsync();
    finalStatus = askStatus;
  }

  if (finalStatus !== "granted") {
    console.warn("Push notifications permission not granted.");
    return null;
  }

  const projectId =
    Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId ?? null;
  if (!projectId) {
    console.warn("No EAS project id available; cannot register for push notifications.");
    return null;
  }

  const uid = auth.currentUser?.uid;

  // An Expo push token changes about as often as the app is reinstalled, but this ran on every
  // launch AND before every drive: one HTTP request to Expo plus a Firestore write plus a read.
  // Remember what was last written for this account and skip all three when nothing changed.
  let cached = null;
  if (uid) {
    if (registeredThisRun && registeredThisRun.startsWith(`${uid}:`)) {
      return registeredThisRun.slice(uid.length + 1);
    }
    try {
      cached = await AsyncStorage.getItem(KEYS.pushTokenSent(uid));
    } catch {
      cached = null;
    }
  }

  const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = tokenData.data;

  // The token is stored under users/{uid}/private/push. It used to sit on the public user
  // document, where any signed-in account could read it and send that device a push.
  if (uid && token) {
    if (`${Platform.OS}:${token}` !== cached) {
      await savePushToken(uid, token, Platform.OS);
      try {
        await AsyncStorage.setItem(KEYS.pushTokenSent(uid), `${Platform.OS}:${token}`);
      } catch {
        // A failed cache write only costs one redundant save next launch.
      }
    }
    registeredThisRun = `${uid}:${token}`;
  }

  return token;
}

//Local notifications 

export async function scheduleDistractedNotification() {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'You got distracted!',
      body: 'Your streak has been reset.',
    },
    trigger: null,
  });
}

export async function scheduleFirstDistractedNotification() {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'You are distracted!',
      body: 'Return to the app now to avoid losing your streak.',
    },
    trigger: null,
  });
}


// Added by the UX rework: forget this device's push token when the user turns
// family-emergency pushes off (Settings › Notifications). The token lives in
// users/{uid}/private/push; the Cloud Function (functions/lib/push.js) skips a
// member whose private document is missing AND whose legacy public field is
// absent, so both are removed. Deleting the legacy field is the one write the
// rules still allow on it.
export async function clearPushToken() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    await deleteDoc(doc(db, "users", uid, "private", "push"));
  } catch (err) {
    console.error("Error clearing push token:", err);
  }
  try {
    await updateDoc(doc(db, "users", uid), { pushToken: deleteField() });
  } catch {}
}
