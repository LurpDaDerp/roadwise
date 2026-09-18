// notifications.js
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { db, auth } from "./firebase";
import { doc, updateDoc } from "firebase/firestore";

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

  const tokenData = await Notifications.getExpoPushTokenAsync({
    projectId: Constants.expoConfig.extra.eas.projectId,
  });
  const token = tokenData.data;

  const uid = auth.currentUser?.uid;
  if (uid && token) {
    try {
      await updateDoc(doc(db, "users", uid), { pushToken: token });
    } catch (err) {
      console.error("Error saving push token:", err);
    }
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
