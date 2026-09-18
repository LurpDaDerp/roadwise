// notifications.js
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { auth } from "./firebase";
import { savePushToken } from "./firestore";

export async function requestNotificationPermissions() {
  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

//Push Notifs

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

  const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = tokenData.data;

  // The token is stored under users/{uid}/private/push. It used to sit on the public user
  // document, where any signed-in account could read it and send that device a push.
  const uid = auth.currentUser?.uid;
  if (uid && token) {
    await savePushToken(uid, token, Platform.OS);
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
// family-emergency pushes off (Settings › Notifications). The Cloud Function
// skips users without a pushToken.
export async function clearPushToken() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    await updateDoc(doc(db, "users", uid), { pushToken: null });
  } catch (err) {
    console.error("Error clearing push token:", err);
  }
}
