import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { isStationary } from '@/drive/policy';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import { Button, Text, useTheme } from '@/ui';

import { DRIVE_ROUTES, driveHref, hudCopy } from './hudCopy';

/**
 * The strip Home (and any other in-app screen) shows while a drive is open and the lockout is off
 * (rev1: I10) — typically an auto-detected or pocket drive, with RoadWise opened at a stop.
 *
 * - *Open HUD* opens the HUD **without** changing the trip's mode: a passenger or a pocket driver
 *   glancing at it must not turn on the mounted app-switch rule.
 * - *Use as mounted HUD* is the only control that sets `mounted`, and only while stationary (SR7:
 *   setup only while stopped).
 * - *I'm a passenger* / *I'm driving* and *End drive* appear only while stationary.
 *
 * It says "Drive in progress" only while the engine is recording or in its gap window: not for a
 * candidate that may yet be discarded, nor while the drive is being saved.
 */
export function DriveInProgressBanner() {
  const th = useTheme();
  const router = useRouter();
  const host = useDriveHost();
  const s = useDrive((d) => ({
    status: d.status,
    lockedOut: d.lockedOut,
    passenger: d.role === 'passenger',
    mode: d.mode,
    stationary: isStationary(d),
    alertsUnavailable: d.alertsAvailable === false,
  }));

  const open = (s.status === 'recording' || s.status === 'ending') && !s.lockedOut;
  if (!open) return null;

  const openHud = () => router.push(driveHref(DRIVE_ROUTES.hud));
  const switchToMounted = async () => {
    await host.setMode('mounted');
    router.push(driveHref(DRIVE_ROUTES.hud));
  };
  // The end screen captures the trip it waits for as it mounts, so it opens before the drive ends.
  const endDrive = () => {
    router.push(driveHref(DRIVE_ROUTES.end));
    void host.end();
  };

  return (
    <View
      testID="drive-in-progress"
      style={{
        backgroundColor: th.colors.surface,
        borderRadius: th.radius.lg,
        borderWidth: 1.5,
        borderColor: th.colors.accent,
        padding: th.space.lg,
        gap: th.space.md,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }}>
        <MaterialCommunityIcons name="record-circle" size={20} color={th.colors.accent} />
        <Text variant="headline" accessibilityRole="header" style={{ flex: 1 }}>
          {hudCopy.banner.title}
        </Text>
        {s.passenger ? (
          <Text
            variant="caption"
            style={{
              color: th.colors.stamp,
              borderColor: th.colors.stamp,
              borderWidth: 1.5,
              borderRadius: th.radius.sm,
              paddingHorizontal: th.space.sm,
              paddingVertical: 2,
              letterSpacing: 1,
              fontWeight: '700',
            }}
          >
            {hudCopy.banner.passengerStamp}
          </Text>
        ) : null}
      </View>
      {s.alertsUnavailable ? (
        <View
          testID="banner-alerts-unavailable"
          accessible
          accessibilityLabel={hudCopy.alerts.label}
          style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }}
        >
          <MaterialCommunityIcons name="volume-off" size={18} color={th.colors.textMuted} />
          <Text variant="subhead" tone="muted">
            {hudCopy.alerts.unavailable}
          </Text>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.sm }}>
        <Button label={hudCopy.banner.openHud} size="md" onPress={openHud} />
        {s.stationary && s.mode !== 'mounted' ? (
          <Button
            label={hudCopy.banner.useMounted}
            size="md"
            variant="secondary"
            onPress={() => void switchToMounted()}
          />
        ) : null}
        {s.stationary ? (
          <Button
            label={s.passenger ? hudCopy.banner.driving : hudCopy.banner.passenger}
            size="md"
            variant="secondary"
            onPress={() => void host.setPassenger(!s.passenger)}
          />
        ) : null}
        {s.stationary ? (
          <Button label={hudCopy.banner.endDrive} size="md" variant="ghost" onPress={endDrive} />
        ) : null}
      </View>
    </View>
  );
}
