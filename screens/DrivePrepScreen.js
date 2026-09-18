// DrivePrepScreen — "everything ready" before the explicit Start:
// permissions with fix actions, camera placement (when monitoring is on),
// the per-drive monitoring toggle, and one big Start button.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, AppState, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';
import { useFocusEffect } from '@react-navigation/native';

import { Screen, ScreenHeader, Section, Card, Button, ListRow, Toggle, Chip, Banner, useTheme } from '../theme';
import { useSettings } from '../context/SettingsContext';
import { usePermissions, PERMISSION_COPY } from '../hooks/usePermissions';
import { CameraPlacementGuide } from '../components/monitoring/CameraPlacementGuide';
import { useDriverMonitoring } from '../monitoring/useDriverMonitoring';
import { monitoringSettingsFrom, MONITORING_AVAILABLE } from '../monitoring/settings';
import * as Notifications from 'expo-notifications';
import { registerForPushNotificationsAsync } from '../utils/notifications';

function StatusChip({ status, required }) {
  if (status === 'granted') return <Chip label="Ready" tone="success" icon="checkmark" />;
  if (status === 'denied') return <Chip label={required ? 'Required' : 'Off'} tone={required ? 'danger' : 'neutral'} icon="close" />;
  if (status === 'unavailable') return <Chip label="Unavailable" tone="neutral" />;
  return <Chip label="Not set" tone="warning" />;
}

export default function DrivePrepScreen({ navigation }) {
  const t = useTheme();
  const { settings, update } = useSettings();
  const perms = usePermissions();
  // Per-drive choice only: it seeds from the global setting but never writes it back.
  const [monitoringOn, setMonitoringOn] = useState(MONITORING_AVAILABLE && !!settings.monitoringEnabled);
  const [gps, setGps] = useState('checking'); // 'checking' | 'ok' | 'weak' | 'off'
  const [starting, setStarting] = useState(false);

  // The monitoring branch may expose a live preview for the placement guide.
  const monitoringSettings = useMemo(() => monitoringSettingsFrom(settings), [settings]);
  const monitoring = useDriverMonitoring({ enabled: false, driveActive: false, settings: monitoringSettings });

  useEffect(() => setMonitoringOn(MONITORING_AVAILABLE && !!settings.monitoringEnabled), [settings.monitoringEnabled]);

  // Notifications granted from here (or from the OS settings): register the
  // push token now, not only at cold start.
  const registeredRef = React.useRef(false);
  useEffect(() => {
    if (perms.notifications !== 'granted' || registeredRef.current || !settings.notifyFamilyEmergency) return;
    registeredRef.current = true;
    (async () => {
      try {
        const { status } = await Notifications.getPermissionsAsync();
        if (status === 'granted') await registerForPushNotificationsAsync();
      } catch {}
    })();
  }, [perms.notifications, settings.notifyFamilyEmergency]);

  // Re-check permissions when returning from the OS settings.
  useFocusEffect(
    useCallback(() => {
      perms.refresh();
      const sub = AppState.addEventListener('change', (s) => s === 'active' && perms.refresh());
      return () => sub.remove();
    }, [perms.refresh])
  );

  // GPS fix probe (only once location is granted).
  useEffect(() => {
    let cancelled = false;
    if (perms.location !== 'granted') {
      setGps('off');
      return undefined;
    }
    setGps('checking');
    (async () => {
      try {
        const enabled = await Location.hasServicesEnabledAsync();
        if (!enabled) {
          if (!cancelled) setGps('off');
          return;
        }
        const pos = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
        ]);
        if (cancelled) return;
        if (!pos) setGps('weak');
        else setGps((pos.coords.accuracy ?? 0) > 100 ? 'weak' : 'ok');
      } catch {
        if (!cancelled) setGps('weak');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [perms.location]);

  const cameraNeeded = MONITORING_AVAILABLE && monitoringOn;
  const cameraOk = !cameraNeeded || perms.camera === 'granted';
  const canStart = perms.location === 'granted' && !starting;

  const start = () => {
    if (!canStart) return;
    setStarting(true);
    navigation.replace('Drive', {
      monitoringEnabled: MONITORING_AVAILABLE && monitoringOn && perms.camera === 'granted',
      driverSide: settings.monitoringDriverSide,
    });
  };

  const fixLocation = () => (perms.location === 'denied' && !perms.canAskLocation ? perms.openSettings() : perms.requestLocation());
  const fixNotifications = () => (perms.notifications === 'denied' && !perms.canAskNotifications ? perms.openSettings() : perms.requestNotifications());
  const fixCamera = () => (perms.camera === 'denied' && !perms.canAskCamera ? perms.openSettings() : perms.requestCamera());

  const unitLabel = settings.speedUnit === 'kph' ? 'km/h' : 'mph';
  const alertsLabel = [
    settings.speedingWarningsEnabled ? 'speeding: tone + banner' : 'speeding alerts off',
    settings.audioSpeedUpdatesEnabled ? 'limit changes spoken' : null,
  ].filter(Boolean).join(' · ');

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 140 }}>
        <ScreenHeader
          eyebrow="Before you go"
          title="Ready to drive?"
          subtitle="Mount the phone, then start. RoadWise does the rest."
          right={
            <View style={{ paddingBottom: 4 }}>
              <Button title="Not now" variant="ghost" fullWidth={false} onPress={() => navigation.goBack()} style={{ paddingVertical: 8 }} />
            </View>
          }
        />

        <Section label="Checks">
          <Card padded={false}>
            <ListRow
              first
              icon={PERMISSION_COPY.location.icon}
              title="Location"
              subtitle={perms.location === 'granted' ? (gps === 'ok' ? 'GPS locked' : gps === 'checking' ? 'Finding GPS…' : gps === 'weak' ? 'Weak GPS signal — start anyway, it improves as you move' : 'Turn on location services') : PERMISSION_COPY.location.body}
              right={perms.location === 'granted' ? <StatusChip status="granted" required /> : <Button title={perms.location === 'denied' && !perms.canAskLocation ? 'Settings' : 'Allow'} fullWidth={false} onPress={fixLocation} style={{ paddingVertical: 8, paddingHorizontal: 14 }} />}
            />
            <ListRow
              icon={PERMISSION_COPY.notifications.icon}
              title="Notifications"
              subtitle={perms.notifications === 'granted' ? 'Distraction and emergency alerts on' : 'Recommended: warns you when you leave the app'}
              right={perms.notifications === 'granted' ? <StatusChip status="granted" /> : <Button title={perms.notifications === 'denied' && !perms.canAskNotifications ? 'Settings' : 'Allow'} variant="soft" fullWidth={false} onPress={fixNotifications} style={{ paddingVertical: 8, paddingHorizontal: 14 }} />}
            />
            <ListRow
              icon="eye-outline"
              title="Driver monitoring"
              subtitle={
                !MONITORING_AVAILABLE
                  ? 'Coming soon'
                  : monitoringOn
                  ? perms.camera === 'granted'
                    ? 'Front camera watches for eyes off the road'
                    : 'Needs camera access'
                  : 'Off for this drive'
              }
              right={
                <Toggle
                  value={monitoringOn}
                  disabled={!MONITORING_AVAILABLE}
                  onValueChange={(v) => {
                    if (!MONITORING_AVAILABLE) return;
                    setMonitoringOn(v); // this drive only; the global setting lives in Settings
                    if (v && perms.camera !== 'granted') fixCamera();
                  }}
                />
              }
            />
            {cameraNeeded && perms.camera !== 'granted' && (
              <ListRow
                icon={PERMISSION_COPY.camera.icon}
                title="Camera"
                subtitle={PERMISSION_COPY.camera.body}
                right={<Button title={perms.camera === 'denied' && !perms.canAskCamera ? 'Settings' : 'Allow'} variant="soft" fullWidth={false} onPress={fixCamera} style={{ paddingVertical: 8, paddingHorizontal: 14 }} />}
              />
            )}
          </Card>
        </Section>

        {MONITORING_AVAILABLE && monitoringOn && (
          <Section label="Mount your phone">
            <Card>
              <CameraPlacementGuide
                driverSide={settings.monitoringDriverSide}
                onDriverSideChange={(v) => update('monitoringDriverSide', v)}
                preview={monitoring.previewComponent}
                compact
              />
              {!cameraOk && (
                <Banner tone="warning" title="Monitoring will stay off" body="Allow camera access above to use it on this drive." style={{ marginTop: 12 }} />
              )}
            </Card>
          </Section>
        )}

        <Section label="This drive">
          <Card padded={false}>
            <ListRow first icon="speedometer-outline" title={`Speed in ${unitLabel}`} subtitle={settings.speedingWarningsEnabled ? 'Speeding alerts on' : 'Speeding alerts off'} chevron onPress={() => navigation.navigate('Main', { screen: 'Settings', params: { screen: 'DriveScreenSettings' } })} />
            <ListRow icon="volume-high-outline" title="Alerts" subtitle={alertsLabel} chevron onPress={() => navigation.navigate('Main', { screen: 'Settings', params: { screen: 'DriveScreenSettings' } })} />
          </Card>
        </Section>

        <Banner
          tone="info"
          icon="phone-portrait-outline"
          title="Leave the phone alone"
          body="Leaving RoadWise for more than 5 seconds counts as a distraction and resets your streak. After 2 minutes the drive ends."
        />
      </ScrollView>

      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          paddingHorizontal: t.spacing[5],
          paddingTop: 12,
          paddingBottom: 28,
          backgroundColor: t.colors.bg,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: t.colors.border,
        }}
      >
        <Button
          title={perms.location === 'granted' ? 'Start drive' : 'Allow location to start'}
          onPress={perms.location === 'granted' ? start : fixLocation}
          loading={starting}
          icon={<Ionicons name="play" size={20} color={t.colors.accentText} />}
          style={{ paddingVertical: 18 }}
        />
        <Text style={[t.typography.caption, { color: t.colors.textSubtle, textAlign: 'center', marginTop: 8 }]}>
          Points start once you are moving over 10 {unitLabel}.
        </Text>
      </View>
    </Screen>
  );
}
