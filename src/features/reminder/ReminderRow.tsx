/**
 * Settings › Driving: the forgot-to-start reminder's switch, with one line saying what it does or
 * what it needs, and the one button that line calls for (Open Settings). Read on
 * every focus and whenever RoadWise comes back to the front (the driver may have changed a
 * permission). Where the native module is missing (Expo Go, tests) the row is not shown.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, View } from 'react-native';

import type { TripReminderStatus } from '@drive-sense';

import type { PermissionsAdapter } from '@/core/permissions';
import type { AppStateLike } from '@/data/foreground';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { Button, Text, ToggleRow, useTheme } from '@/ui';

import { reminderCopy } from './copy';
import { nativeReminder, readReminderStatus, turnOffReminder, turnOnReminder, type ReminderNative } from './enable';
import { reminderLine, type ReminderPlatform } from './line';

export interface ReminderDeps {
  adapter?: PermissionsAdapter;
  native?: ReminderNative;
  platform?: ReminderPlatform;
  appState?: AppStateLike;
}

/** The reminder's status, read on focus and on return to the front; null while unknown or unavailable to JS. */
export function useTripReminder(deps: ReminderDeps = {}) {
  const native = deps.native ?? nativeReminder;
  const appState = deps.appState ?? AppState;
  const [status, setStatus] = useState<TripReminderStatus | null>(null);

  const read = useCallback(() => {
    let live = true;
    readReminderStatus(native)
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch(() => {
        if (live) setStatus(null);
      });
    return () => {
      live = false;
    };
  }, [native]);

  useFocusEffect(read);

  useEffect(() => {
    let stop: (() => void) | null = null;
    const sub = appState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      stop?.();
      stop = read();
    });
    return () => {
      stop?.();
      sub.remove();
    };
  }, [appState, read]);

  return { status, setStatus };
}

export function ReminderRow({
  status,
  onStatus,
  deps = {},
}: {
  status: TripReminderStatus;
  onStatus: (s: TripReminderStatus) => void;
  deps?: ReminderDeps;
}) {
  const th = useTheme();
  const native = deps.native ?? nativeReminder;
  const platform = deps.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const line = reminderLine(status, platform);

  const run = async (fn: () => Promise<TripReminderStatus>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      onStatus(await fn());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const adapter = () => deps.adapter ?? defaultPermissionsAdapter();
  const onToggle = (on: boolean) => void run(() => (on ? turnOnReminder(adapter(), native) : turnOffReminder(native)));
  const onAction = () => void adapter().openAppSettings().catch(() => setFailed(true));

  return (
    <View>
      <ToggleRow
        icon="notifications-outline"
        title={reminderCopy.title}
        subtitle={line.text}
        value={status.enabled}
        // Where it cannot run, a reminder still on from before can always be turned off.
        disabled={(line.disabled && !status.enabled) || busy}
        onValueChange={onToggle}
        testID="settings-reminder"
      />
      {line.action ? (
        <View style={{ paddingHorizontal: th.space.lg, paddingBottom: th.space.md, alignItems: 'flex-start' }}>
          <Button
            size="sm"
            variant="secondary"
            label={reminderCopy.openSettings}
            onPress={onAction}
            disabled={busy}
            testID={`settings-reminder-${line.action}`}
          />
        </View>
      ) : null}
      {failed ? (
        <Text variant="footnote" tone="danger" accessibilityRole="alert" style={{ paddingHorizontal: th.space.lg, paddingBottom: th.space.md }}>
          {reminderCopy.failed}
        </Text>
      ) : null}
    </View>
  );
}
