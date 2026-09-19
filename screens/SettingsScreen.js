// SettingsScreen — the Settings tab root (route `SettingsHome`, no native header).
// A grouped list: profile → Account, Driving, Monitoring, Safety, Notifications,
// Appearance (inline) and About. Every preference is served by SettingsContext.
import React, { useCallback, useContext, useState } from 'react';
import { View, Text, ScrollView, Alert, Linking } from 'react-native';
import { Image } from 'expo-image';   // remote avatar: expo-image is the one with a disk cache
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  ListRow,
  SegmentedTabs,
  Toggle,
  useTheme,
} from '../theme';
import { ThemeContext } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import { useAuthContext } from '../context/AuthContext';
import { SENSITIVITY_OPTIONS, MONITORING_AVAILABLE } from '../monitoring/settings';
import { getTrustedContacts } from '../utils/firestore';
import { cameraPermission } from '../hooks/usePermissions';

const THEME_VALUES = ['light', 'dark', 'system'];
const THEME_LABELS = ['Light', 'Dark', 'System'];

export default function SettingsScreen() {
  const navigation = useNavigation();
  const t = useTheme();
  const { settings, update } = useSettings();
  const { uid, user, username, photoURL } = useAuthContext();

  // Driver monitoring on/off straight from the list. Turning it on asks for the camera once;
  // if the camera stays blocked the setting stays on and drives run unmonitored until allowed.
  const onToggleMonitoring = useCallback(
    async (value) => {
      if (!MONITORING_AVAILABLE) return;
      update('monitoringEnabled', value);
      if (!value) return;
      try {
        let camera = await cameraPermission();
        if (camera.status === 'undetermined' && camera.canAskAgain) camera = await cameraPermission({ request: true });
        if (camera.status !== 'granted') {
          Alert.alert(
            'Camera access is off',
            'Driver monitoring uses the front camera. Allow camera access for RoadWise in your phone settings.',
            [
              { text: 'Not now', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings().catch(() => {}) },
            ]
          );
        }
      } catch {
        // the module is unavailable (Expo Go): the setting is stored, monitoring stays inactive
      }
    },
    [update]
  );
  const { theme, updateTheme } = useContext(ThemeContext);
  const [contactCount, setContactCount] = useState(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!uid) {
        setContactCount(0);
        return undefined;
      }
      (async () => {
        const list = await getTrustedContacts(uid);
        if (!cancelled) setContactCount(Array.isArray(list) ? list.length : 0);
      })();
      return () => {
        cancelled = true;
      };
    }, [uid])
  );

  const unitLabel = settings.speedUnit === 'kph' ? 'KM/H' : 'MPH';
  const drivingSubtitle = `${unitLabel} · Speeding alerts ${
    settings.speedingWarningsEnabled ? 'on' : 'off'
  }`;

  const sensitivity =
    SENSITIVITY_OPTIONS.find((o) => o.value === settings.monitoringSensitivity) ||
    SENSITIVITY_OPTIONS[1];
  const monitoringSubtitle = !MONITORING_AVAILABLE
    ? 'Coming soon'
    : settings.monitoringEnabled
    ? `On · ${sensitivity.label} sensitivity · tap for options`
    : 'Off · tap for options';

  const safetySubtitle =
    contactCount === null
      ? 'Trusted contacts for emergencies'
      : contactCount === 1
      ? '1 trusted contact'
      : `${contactCount} trusted contacts`;

  const version = Constants.expoConfig?.version || '—';
  const themeIndex = Math.max(0, THEME_VALUES.indexOf(theme || 'system'));

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: t.spacing[8] }}
      >
        <ScreenHeader eyebrow="Menu" title="Settings" />

        <Section>
          <Card padded={false}>
            <ListRow
              first
              chevron
              onPress={() => navigation.navigate('AccountSettings')}
              title={username || 'Your profile'}
              subtitle={user?.email || 'Signed in'}
              icon={
                photoURL ? (
                  <Image
                    source={{ uri: photoURL }}
                    style={{ width: 36, height: 36, borderRadius: 18 }}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    transition={0}
                  />
                ) : (
                  <Text style={{ color: t.colors.accent, fontSize: 16, fontWeight: '800' }}>
                    {(username || user?.email || '?')[0].toUpperCase()}
                  </Text>
                )
              }
            />
          </Card>
        </Section>

        <Section label="Driving">
          <Card padded={false}>
            <ListRow
              first
              chevron
              icon="speedometer-outline"
              title="Driving"
              subtitle={drivingSubtitle}
              onPress={() => navigation.navigate('DriveScreenSettings')}
            />
            <ListRow
              icon="eye-outline"
              title="Driver monitoring"
              subtitle={monitoringSubtitle}
              onPress={() => navigation.navigate('MonitoringSettings')}
              right={
                <Toggle
                  value={MONITORING_AVAILABLE && !!settings.monitoringEnabled}
                  onValueChange={onToggleMonitoring}
                  disabled={!MONITORING_AVAILABLE}
                />
              }
            />
          </Card>
        </Section>

        <Section label="Safety">
          <Card padded={false}>
            <ListRow
              first
              chevron
              icon="shield-checkmark-outline"
              title="Safety"
              subtitle={safetySubtitle}
              onPress={() => navigation.navigate('SafetySettings')}
            />
            <ListRow
              chevron
              icon="notifications-outline"
              title="Notifications"
              subtitle="Distraction warnings, drive summaries, family alerts"
              onPress={() => navigation.navigate('NotificationSettings')}
            />
          </Card>
        </Section>

        <Section label="Appearance">
          <Card>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginBottom: 14,
                gap: 10,
              }}
            >
              <Ionicons name="contrast-outline" size={18} color={t.colors.accent} />
              <View style={{ flex: 1 }}>
                <Text style={[t.typography.bodyStrong, { color: t.colors.text }]}>Theme</Text>
                <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 2 }]}>
                  System follows your phone's setting.
                </Text>
              </View>
            </View>
            <SegmentedTabs
              values={THEME_LABELS}
              selectedIndex={themeIndex}
              onChange={(i) => updateTheme(THEME_VALUES[i])}
            />
          </Card>
        </Section>

        <Section label="About">
          <Card padded={false}>
            <ListRow
              first
              chevron
              icon="information-circle-outline"
              title="About RoadWise"
              subtitle={`Version ${version}`}
              onPress={() => navigation.navigate('About')}
            />
          </Card>
        </Section>
      </ScrollView>
    </Screen>
  );
}
