// usePermissions — one place that knows the state of every permission the app
// asks for, with the reason copy used by Onboarding and DrivePrep.
//
// Camera: the camera permission is requested through expo-image-picker's
// camera permission API (already installed, maps to the same OS permission).
// The driver-monitoring branch may swap this for expo-camera's request; keep
// the returned shape ('granted' | 'denied' | 'undetermined' | 'unavailable').
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as ImagePicker from 'expo-image-picker';
import * as Device from 'expo-device';

export const PERMISSION_COPY = {
  location: {
    title: 'Location',
    required: true,
    body: 'Reads your speed, looks up speed limits and measures distance. Only while you drive, unless you share your location with a family group.',
    icon: 'navigate-outline',
  },
  background: {
    title: 'Background location',
    required: false,
    body: 'Lets your family group see where you are between drives. Only asked for when you join a group.',
    icon: 'people-outline',
  },
  notifications: {
    title: 'Notifications',
    required: false,
    body: 'A heads-up when you pick up the phone during a drive, and when a family member signals an emergency.',
    icon: 'notifications-outline',
  },
  camera: {
    title: 'Camera',
    required: false,
    body: 'Optional. Driver monitoring watches for eyes off the road and drowsiness with the front camera. Frames are processed on your phone and never uploaded.',
    icon: 'videocam-outline',
  },
};

function normalize(status) {
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  if (status === 'undetermined') return 'undetermined';
  return status || 'undetermined';
}

export function usePermissions() {
  const [state, setState] = useState({
    location: 'undetermined',
    background: 'undetermined',
    notifications: 'undetermined',
    camera: 'undetermined',
    canAskLocation: true,
    canAskNotifications: true,
    canAskCamera: true,
    loaded: false,
  });

  const refresh = useCallback(async () => {
    const next = { loaded: true };
    try {
      const fg = await Location.getForegroundPermissionsAsync();
      next.location = normalize(fg.status);
      next.canAskLocation = fg.canAskAgain !== false;
    } catch {
      next.location = 'unavailable';
    }
    try {
      const bg = await Location.getBackgroundPermissionsAsync();
      next.background = normalize(bg.status);
    } catch {
      next.background = 'unavailable';
    }
    try {
      const n = await Notifications.getPermissionsAsync();
      next.notifications = normalize(n.status);
      next.canAskNotifications = n.canAskAgain !== false;
    } catch {
      next.notifications = 'unavailable';
    }
    try {
      const c = await ImagePicker.getCameraPermissionsAsync();
      next.camera = normalize(c.status);
      next.canAskCamera = c.canAskAgain !== false;
    } catch {
      next.camera = 'unavailable';
    }
    setState((prev) => ({ ...prev, ...next }));
    return next;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const requestLocation = useCallback(async () => {
    try {
      const r = await Location.requestForegroundPermissionsAsync();
      await refresh();
      return normalize(r.status);
    } catch {
      return 'unavailable';
    }
  }, [refresh]);

  const requestBackground = useCallback(async () => {
    try {
      const fg = await Location.getForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        const r = await Location.requestForegroundPermissionsAsync();
        if (r.status !== 'granted') {
          await refresh();
          return normalize(r.status);
        }
      }
      const r = await Location.requestBackgroundPermissionsAsync();
      await refresh();
      return normalize(r.status);
    } catch {
      return 'unavailable';
    }
  }, [refresh]);

  const requestNotifications = useCallback(async () => {
    try {
      if (!Device.isDevice) {
        await refresh();
        return 'unavailable';
      }
      const r = await Notifications.requestPermissionsAsync();
      await refresh();
      return normalize(r.status);
    } catch {
      return 'unavailable';
    }
  }, [refresh]);

  const requestCamera = useCallback(async () => {
    try {
      const r = await ImagePicker.requestCameraPermissionsAsync();
      await refresh();
      return normalize(r.status);
    } catch {
      return 'unavailable';
    }
  }, [refresh]);

  const openSettings = useCallback(() => {
    if (Platform.OS === 'ios') Linking.openURL('app-settings:');
    else Linking.openSettings();
  }, []);

  return useMemo(
    () => ({
      ...state,
      refresh,
      requestLocation,
      requestBackground,
      requestNotifications,
      requestCamera,
      openSettings,
    }),
    [state, refresh, requestLocation, requestBackground, requestNotifications, requestCamera, openSettings]
  );
}

export default usePermissions;
