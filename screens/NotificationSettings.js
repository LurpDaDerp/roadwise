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
                  <Button title="Allow notifications" onPress={requestNotifications} />
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
              title="Drive complete"
              subtitle="A summary of your points and score when a drive ends."
              value={settings.notifyDriveComplete}
              onValueChange={(v) => update('notifyDriveComplete', v)}
            />
            <ToggleRow
              icon="alert-circle-outline"
              title="Family emergencies"
              subtitle="Push alerts from your group"
              value={settings.notifyFamilyEmergency}
              onValueChange={(v) => update('notifyFamilyEmergency', v)}
            />
          </Card>
        </Section>
      </ScrollView>
    </Screen>
  );
}
