// SettingsContext — every user preference, AsyncStorage-backed, loaded once.
// Keys are listed in utils/storageKeys.js; the historical keys are unchanged so
// preferences stored before the UX rework are still honoured.
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KEYS } from '../utils/storageKeys';
import { MONITORING_DEFAULTS } from '../monitoring/settings';

const SettingsContext = createContext(null);

export const DEFAULT_SETTINGS = {
  // Driving
  speedUnit: 'mph',                 // 'mph' | 'kph'
  speedingWarningsEnabled: true,
  showSpeedLimit: true,
  displayTotalPoints: false,
  distractedNotificationsEnabled: true,
  audioSpeedUpdatesEnabled: true,
  // Notifications
  notifyDriveComplete: true,
  notifyFamilyEmergency: true,
  // Driver monitoring
  ...MONITORING_DEFAULTS,
};

// setting name → [storage key, parser]
const SPEC = {
  speedUnit: [KEYS.speedUnit, (v) => (v === 'mph' || v === 'kph' ? v : null)],
  speedingWarningsEnabled: [KEYS.speedingWarningsEnabled, parseBool],
  showSpeedLimit: [KEYS.showSpeedLimit, parseBool],
  displayTotalPoints: [KEYS.displayTotalPoints, parseBool],
  distractedNotificationsEnabled: [KEYS.distractedNotificationsEnabled, parseBool],
  audioSpeedUpdatesEnabled: [KEYS.audioSpeedUpdatesEnabled, parseBool],
  notifyDriveComplete: [KEYS.notifyDriveComplete, parseBool],
  notifyFamilyEmergency: [KEYS.notifyFamilyEmergency, parseBool],
  monitoringEnabled: [KEYS.monitoringEnabled, parseBool],
  monitoringVoiceAlerts: [KEYS.monitoringVoiceAlerts, parseBool],
  monitoringToneAlerts: [KEYS.monitoringToneAlerts, parseBool],
  monitoringHapticAlerts: [KEYS.monitoringHapticAlerts, parseBool],
  monitoringSensitivity: [KEYS.monitoringSensitivity, (v) => (['low', 'medium', 'high'].includes(v) ? v : null)],
  monitoringDriverSide: [KEYS.monitoringDriverSide, (v) => (['left', 'right'].includes(v) ? v : null)],
  // monitoringShowPreview is deliberately absent: the native module renders no preview
  // (docs/dms/DETECTION_DESIGN.md §3 - running without one is most of the battery saving), so
  // the setting could never do anything. monitoringSettingsFrom() still tolerates the missing
  // key, and the stored value is left in AsyncStorage for whenever a preview exists.
};

function parseBool(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const names = Object.keys(SPEC);
        const pairs = await AsyncStorage.multiGet(names.map((n) => SPEC[n][0]));
        const next = { ...DEFAULT_SETTINGS };
        pairs.forEach(([, raw], i) => {
          const name = names[i];
          const parsed = SPEC[name][1](raw);
          if (parsed !== null && parsed !== undefined) next[name] = parsed;
        });
        if (!cancelled) setSettings(next);
      } catch (e) {
        console.warn('Failed to load settings:', e);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (name, value) => {
    if (!SPEC[name]) return;
    setSettings((prev) => ({ ...prev, [name]: value }));
    try {
      await AsyncStorage.setItem(SPEC[name][0], String(value));
    } catch (e) {
      console.warn('Failed to save setting', name, e);
    }
  }, []);

  const updateMany = useCallback(async (patch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    try {
      const entries = Object.entries(patch)
        .filter(([name]) => SPEC[name])
        .map(([name, value]) => [SPEC[name][0], String(value)]);
      if (entries.length) await AsyncStorage.multiSet(entries);
    } catch (e) {
      console.warn('Failed to save settings', e);
    }
  }, []);

  const value = useMemo(() => ({ settings, ready, update, updateMany }), [settings, ready, update, updateMany]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    // Allows components to render outside the provider (tests, storybook-style previews).
    return { settings: DEFAULT_SETTINGS, ready: true, update: async () => {}, updateMany: async () => {} };
  }
  return ctx;
}
