// useAutoStartDrive — the zero-tap start. While Home is on screen with the app in the
// foreground, and location is ALREADY allowed (this hook never asks), it watches GPS. Two fixes
// in a row at driving speed mean the car is moving: `detected` turns true and Home shows a short
// countdown that starts the drive unless the user taps "Not driving" (a passenger, a bus).
//
// Battery: the watch runs only while Home is focused and the app is active, stops as soon as
// the drive starts, and gives up after WATCH_LIMIT_MS on a Home screen left open while parked.
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { useIsFocused } from '@react-navigation/native';

import { distanceMeters } from '../utils/geo';

export const AUTO_START_KMH = 20;            // ~12 mph: faster than running, slower than any road
const CONSECUTIVE_FIXES = 2;                 // one noisy GPS jump must not start a drive
const FIX_INTERVAL_MS = 3000;
const WATCH_LIMIT_MS = 15 * 60 * 1000;
const SNOOZE_MS = 10 * 60 * 1000;

// Module state so a snooze survives Home re-mounting within one app run.
let snoozedUntil = 0;

/** Suppress auto-start for a while: after "Not driving", and whenever a drive starts. */
export function snoozeAutoStart(ms = SNOOZE_MS) {
  snoozedUntil = Math.max(snoozedUntil, Date.now() + ms);
}

// Metres per second from the fix itself, or from the distance to the previous fix when the
// platform does not report a speed (iOS reports -1, some Android fixes report null or 0).
function fixSpeedMps(previous, location) {
  const reported = location?.coords?.speed;
  if (Number.isFinite(reported) && reported > 0) return reported;
  if (!previous) return null;
  const dt = (location.timestamp - previous.timestamp) / 1000;
  if (!(dt > 0.5 && dt < 30)) return null;
  const accuracy = location.coords.accuracy;
  if (!Number.isFinite(accuracy) || accuracy > 50) return null;
  const d = distanceMeters(
    previous.coords.latitude,
    previous.coords.longitude,
    location.coords.latitude,
    location.coords.longitude
  );
  return Number.isFinite(d) ? d / dt : null;
}

export function useAutoStartDrive({ enabled }) {
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [detected, setDetected] = useState(false);
  const [wake, setWake] = useState(0); // re-evaluates once a snooze runs out

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  const watching = !!enabled && focused && appActive && !detected;

  useEffect(() => {
    if (!watching) return undefined;
    const snoozeLeft = snoozedUntil - Date.now();
    if (snoozeLeft > 0) {
      const id = setTimeout(() => setWake((n) => n + 1), snoozeLeft + 50);
      return () => clearTimeout(id);
    }

    let cancelled = false;
    let subscription = null;
    let previous = null;
    let hits = 0;
    const stop = () => {
      if (subscription) subscription.remove();
      subscription = null;
    };
    const limit = setTimeout(stop, WATCH_LIMIT_MS);

    (async () => {
      try {
        const permission = await Location.getForegroundPermissionsAsync();
        if (cancelled || permission.status !== 'granted') return;
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: FIX_INTERVAL_MS, distanceInterval: 0 },
          (location) => {
            if (cancelled) return;
            const mps = fixSpeedMps(previous, location);
            previous = location;
            if (mps == null) return;
            hits = mps * 3.6 >= AUTO_START_KMH ? hits + 1 : 0;
            if (hits >= CONSECUTIVE_FIXES && Date.now() >= snoozedUntil) {
              stop();
              setDetected(true);
            }
          }
        );
        if (cancelled) sub.remove();
        else subscription = sub;
      } catch {
        // no location service: nothing to do, the Start button still works
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(limit);
      stop();
    };
  }, [watching, wake]);

  // "Not driving": hide the countdown and stay quiet for SNOOZE_MS.
  const cancel = useCallback(() => {
    snoozeAutoStart();
    setDetected(false);
  }, []);

  // The countdown finished or "Start now" was tapped.
  const consume = useCallback(() => setDetected(false), []);

  return { detected, cancel, consume };
}

export default useAutoStartDrive;
