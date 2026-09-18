// NotificationSettings — the OS permission state plus the three push categories
// RoadWise sends. Preferences are stored by SettingsContext.
import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  Button,
  Chip,
  ToggleRow,
  useTheme,
} from '../theme';
import { useSettings } from '../context/SettingsContext';
import * as Notifications from 'expo-notifications';
import { registerForPushNotificationsAsync, clearPushToken } from '../utils/notifications';
import { usePermissions, PERMISSION_COPY } from '../hooks/usePermissions';

const STATUS = {
  granted: {
    tone: 'success',
    chip: 'Allowed',
    icon: 'checkmark-circle-outline',
    body: 'RoadWise can send you alerts.',
  },
  denied: {
    tone: 'danger',
    chip: 'Blocked',
    icon: 'close-circle-outline',
    body: 'Notifications are turned off for RoadWise in your phone settings.',
  },
  undetermined: {
    tone: 'neutral',
    chip: 'Not asked yet',
    icon: 'help-circle-outline',
    body: 'Allow notifications so warnings and family alerts reach you.',
  },
  unavailable: {
    tone: 'neutral',
    chip: 'Unavailable',
    icon: 'alert-circle-outline',
    body: 'Push notifications need a physical device.',
  },
};

export default function NotificationSettings() {
  const t = useTheme();
  const { settings, update } = useSettings();
  const { notifications, requestNotifications, openSettings } = usePermissions();

  // Off: forget this device's push token (the Cloud Function then skips it).
  // On: register again once the OS permission is granted.
  const onFamilyEmergencyChange = async (v) => {
    update('notifyFamilyEmergency', v);
    try {
      if (v) {
        const { status } = await Notifications.getPermissionsAsync();
        if (status === 'granted') await registerForPushNotificationsAsync();
      } else {
        await clearPushToken();
      }
    } catch (e) {
      console.warn('Push token update failed:', e);
    }
  };

  const onAllow = async () => {
    const r = await requestNotifications();
    if (r === 'granted' && settings.notifyFamilyEmergency) {
      try {
        await registerForPushNotificationsAsync();
      } catch {}
    }
  };

  const status = STATUS[notifications] || STATUS.undetermined;

  return (
    <Screen hasHeader>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: t.spacing[8] }}
      >
        <ScreenHeader
          eyebrow="Settings"
          title="Notifications"
          subtitle="What RoadWise is allowed to interrupt you for."
        />

        <Section label="Permission">
          <Card>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              <Text style={[t.typography.bodyStrong, { color: t.colors.text }]}>
                {PERMISSION_COPY.notifications.title}
              </Text>
              <Chip label={status.chip} icon={status.icon} tone={status.tone} />
            </View>
            <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>{status.body}</Text>
            {notifications !== 'granted' && notifications !== 'unavailable' && (
              <View style={{ marginTop: 16 }}>
                {notifications === 'undetermined' ? (
                  <Button title="Allow notifications" onPress={onAllow} />
                ) : (
                  <Button title="Open Settings" variant="ghost" onPress={openSettings} />
                )}
              </View>
            )}
          </Card>
        </Section>

        <Section label="Send me">
          <Card padded={false}>
            <ToggleRow
              first
              icon="phone-portrait-outline"
              title="Distraction warnings"
              subtitle="When you leave RoadWise during a drive"
              value={settings.distractedNotificationsEnabled}
              onValueChange={(v) => update('distractedNotificationsEnabled', v)}
            />
            <ToggleRow
              icon="flag-outline"
              title="Drive ended automatically"
              subtitle="Tells you when a drive ends on its own after 2 minutes away from RoadWise."
              value={settings.notifyDriveComplete}
              onValueChange={(v) => update('notifyDriveComplete', v)}
            />
            <ToggleRow
              icon="alert-circle-outline"
              title="Family emergencies"
              subtitle="Push alerts when someone in your group signals an emergency"
              value={settings.notifyFamilyEmergency}
              onValueChange={onFamilyEmergencyChange}
            />
          </Card>
        </Section>
      </ScrollView>
    </Screen>
  );
}
