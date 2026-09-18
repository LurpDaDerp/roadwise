// utils/LocationService.js
//
// Background location sharing for the family-group feature.
//
// What changed and why (TODO.md item 3, "optimize location updates to stop cooking the
// backend"):
//
// 1. The OS was asked for high-accuracy updates with no distance or time interval, so it
//    delivered a fix as fast as the GPS could produce one - several per second while
//    driving - and every one of them woke the JS task. The task now asks the OS for the
//    same cadence it actually writes at, and batches with deferred updates, so most fixes
//    never reach JavaScript at all.
// 2. The de-duplication state (`lastLocation`, `lastUpdateTime`) lived in module globals.
//    The background JS context is torn down between wake-ups, so every cold start looked
//    like a first update and wrote immediately. It is now persisted.
// 3. Tracking started unconditionally at app launch, which asked every user for
//    always-on location permission and burned battery even with no group to share with.
//    It now starts only for users who are actually in a group, and stops itself when the
//    user leaves one.
// 4. The write used setDoc(merge) on the whole group document and included
//    `emergency: false`, so restarting the app cleared an active emergency. It now writes
//    only the caller's own coordinate fields.

import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onAuthStateChanged } from 'firebase/auth';

import { auth } from './firebase';
import { getCachedGroupId, updateCachedGroupId, clearCachedGroupId } from './groupCache';
import { updateMemberLocation } from './groups';

const LOCATION_TASK_NAME = 'BACKGROUND_LOCATION_TASK';
const LAST_FIX_STORAGE_KEY = 'locationService.lastFix';

// Write gate. A member only needs to move on the map, not to stream a track.
const MIN_DISTANCE_METERS = 25;
const MIN_TIME_SECONDS = 20;
const MIN_SPEED_MPS = 1;
// Hard floor that also applies to the first fix after a cold start, which used to bypass
// the gate entirely.
const MIN_WRITE_INTERVAL_MS = 15_000;

// Re-exported so existing callers (screens/LocationScreen.js) keep working unchanged.
export { updateCachedGroupId, clearCachedGroupId };

function getDistance(loc1, loc2) {
  const R = 6371e3;
  const lat1 = (loc1.latitude * Math.PI) / 180;
  const lat2 = (loc2.latitude * Math.PI) / 180;
  const dLat = ((loc2.latitude - loc1.latitude) * Math.PI) / 180;
  const dLon = ((loc2.longitude - loc1.longitude) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// In-memory copy of the persisted gate state, so the common case costs no storage read.
let lastFix = null;

async function loadLastFix() {
  if (lastFix) return lastFix;
  try {
    const raw = await AsyncStorage.getItem(LAST_FIX_STORAGE_KEY);
    if (raw) lastFix = JSON.parse(raw);
  } catch {}
  return lastFix;
}

async function saveLastFix(fix) {
  lastFix = fix;
  try {
    await AsyncStorage.setItem(LAST_FIX_STORAGE_KEY, JSON.stringify(fix));
  } catch {}
}

/** Decide whether a fix is worth a Firestore write. Exported for testing/diagnostics. */
export function shouldWriteLocation(previous, coords, now) {
  if (!previous) return true;

  const sinceLast = now - (previous.at ?? 0);
  if (sinceLast < MIN_WRITE_INTERVAL_MS) return false;

  const moved = getDistance(previous, coords);
  const speed = coords.speed ?? 0;

  return moved >= MIN_DISTANCE_METERS && sinceLast / 1000 >= MIN_TIME_SECONDS && speed >= MIN_SPEED_MPS;
}

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('Background location task error:', error);
    return;
  }
  if (!data?.locations?.length) return;

  // Deferred updates deliver a batch; only the newest fix matters.
  const latest = data.locations[data.locations.length - 1];
  const coords = latest?.coords;
  if (!coords) return;

  const now = Date.now();
  const previous = await loadLastFix();
  if (!shouldWriteLocation(previous, coords, now)) return;

  const user = auth.currentUser;
  if (!user) return;

  const groupId = await getCachedGroupId(user.uid);
  if (!groupId) {
    // Nothing to share with: stop burning battery until the user joins a group again.
    await stopLocationUpdates();
    return;
  }

  const written = await updateMemberLocation(user.uid, groupId, {
    latitude: coords.latitude,
    longitude: coords.longitude,
    speed: coords.speed ?? 0,
  });

  if (written) {
    await saveLastFix({
      latitude: coords.latitude,
      longitude: coords.longitude,
      at: now,
    });
  }
});

export function waitForSignedInUser(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (auth.currentUser) return resolve(auth.currentUser);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      unsub();
      resolve(value);
    };

    const unsub = onAuthStateChanged(
      auth,
      (u) => {
        if (u) finish(u);
      },
      (err) => {
        if (settled) return;
        settled = true;
        unsub();
        reject(err);
      }
    );

    if (timeoutMs) {
      setTimeout(() => finish(null), timeoutMs);
    }
  });
}

export async function isLocationSharingActive() {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  } catch {
    return false;
  }
}

/**
 * Start background location sharing.
 *
 * No-ops (and never prompts for permission) unless the signed-in user is in a group, so
 * the always-on location prompt is only shown to people who asked for the feature.
 */
export async function startLocationUpdates({ requireGroup = true } = {}) {
  const user = await waitForSignedInUser(15000);
  if (!user) return false;

  const groupId = await getCachedGroupId(user.uid);
  if (requireGroup && !groupId) {
    await stopLocationUpdates();
    return false;
  }

  const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
  if (fgStatus !== 'granted') {
    console.warn('Foreground location permission denied');
    return false;
  }

  const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
  if (bgStatus !== 'granted') {
    console.warn('Background location permission denied');
    return false;
  }

  try {
    const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    if (groupId) {
      const ok = await updateMemberLocation(user.uid, groupId, {
        latitude: current.coords.latitude,
        longitude: current.coords.longitude,
        speed: current.coords.speed ?? 0,
      });
      if (ok) {
        await saveLastFix({
          latitude: current.coords.latitude,
          longitude: current.coords.longitude,
          at: Date.now(),
        });
      }
    }
  } catch (err) {
    console.warn('Could not push the initial location:', err);
  }

  if (!TaskManager.isTaskDefined(LOCATION_TASK_NAME)) return false;
  if (await isLocationSharingActive()) return true;

  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.High,
      // Ask the OS for the cadence we actually write at instead of filtering a firehose
      // in JavaScript.
      distanceInterval: MIN_DISTANCE_METERS,
      timeInterval: MIN_TIME_SECONDS * 1000,
      // iOS: let the system batch fixes and wake the app once per batch.
      deferredUpdatesInterval: MIN_TIME_SECONDS * 1000,
      deferredUpdatesDistance: MIN_DISTANCE_METERS,
      activityType: Location.ActivityType.AutomotiveNavigation,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Sharing your location',
        notificationBody: 'Your group can see where you are.',
      },
    });
    return true;
  } catch (err) {
    console.error('Error starting location updates:', err);
    return false;
  }
}

export async function stopLocationUpdates() {
  try {
    if (await isLocationSharingActive()) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    }
  } catch (err) {
    console.warn('Error stopping location updates:', err);
  }
  lastFix = null;
  try {
    await AsyncStorage.removeItem(LAST_FIX_STORAGE_KEY);
  } catch {}
}
