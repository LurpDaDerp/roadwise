// OnboardingScreen — first run per user per device: how it works, permissions
// with reasons, camera placement + driver side, ready.
import React, { useRef, useState } from 'react';
import { View, Text, ScrollView, Dimensions, Pressable } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Screen, Card, Button, ListRow, Chip, Toggle, Banner, useTheme, Eyebrow } from '../theme';
import { useAuthContext } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { usePermissions, PERMISSION_COPY } from '../hooks/usePermissions';
import { registerForPushNotificationsAsync } from '../utils/notifications';
import { MONITORING_AVAILABLE } from '../monitoring/settings';

const { width } = Dimensions.get('window');
const PAGES = 4;

function PermissionRow({ id, status, canAsk, onRequest, onSettings, first }) {
  const t = useTheme();
  const copy = PERMISSION_COPY[id];
  const granted = status === 'granted';
  const denied = status === 'denied';
  return (
    <ListRow
      first={first}
      icon={copy.icon}
      title={copy.title}
      subtitle={copy.body}
      right={
        granted ? (
          <Chip label="Allowed" tone="success" icon="checkmark" />
        ) : (
          <Button
            title={denied && !canAsk ? 'Settings' : 'Allow'}
            variant={copy.required ? 'primary' : 'soft'}
            fullWidth={false}
            onPress={denied && !canAsk ? onSettings : onRequest}
            style={{ paddingVertical: 8, paddingHorizontal: 14 }}
          />
        )
      }
    />
  );
}

export default function OnboardingScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { completeOnboarding, username } = useAuthContext();
  const { settings, update } = useSettings();
  const perms = usePermissions();
  const scrollRef = useRef(null);
  const [page, setPage] = useState(0);

  const goTo = (i) => {
    const next = Math.max(0, Math.min(PAGES - 1, i));
    scrollRef.current?.scrollTo({ x: next * width, animated: true });
    setPage(next);
  };

  const finish = async () => {
    if (perms.notifications === 'granted') {
      try {
        await registerForPushNotificationsAsync();
      } catch {}
    }
    await completeOnboarding();
  };

  const requestNotifications = async () => {
    const r = await perms.requestNotifications();
    if (r === 'granted') {
      try {
        await registerForPushNotificationsAsync();
      } catch {}
    }
  };

  const toggleMonitoring = async (v) => {
    if (!MONITORING_AVAILABLE) return;
    await update('monitoringEnabled', v);
    if (v && perms.camera !== 'granted') await perms.requestCamera();
  };
  const monitoringOn = MONITORING_AVAILABLE && !!settings.monitoringEnabled;

  const pageStyle = { width, paddingHorizontal: t.spacing[5] };

  return (
    <Screen padded={false}>
      <View style={{ flex: 1, paddingTop: insets.top + 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: t.spacing[5], marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {Array.from({ length: PAGES }).map((_, i) => (
              <View key={i} style={{ width: i === page ? 22 : 8, height: 8, borderRadius: 4, backgroundColor: i === page ? t.colors.accent : t.colors.borderStrong }} />
            ))}
          </View>
          <Pressable onPress={finish} hitSlop={8} accessibilityRole="button" accessibilityLabel="Skip onboarding">
            <Text style={[t.typography.caption, { color: t.colors.textMuted, fontWeight: '700' }]}>Skip for now</Text>
          </Pressable>
        </View>

        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1 }}
          onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        >
          {/* 1 — How it works */}
          <ScrollView style={pageStyle} contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
            <Eyebrow style={{ marginTop: 16 }}>Welcome{username ? `, ${username}` : ''}</Eyebrow>
            <Text style={[t.typography.display, { color: t.colors.text, marginTop: 8 }]}>Drive focused.{'\n'}Earn rewards.</Text>
            <Text style={[t.typography.body, { color: t.colors.textMuted, marginTop: 10, marginBottom: 20 }]}>
              RoadWise turns every phone-free drive into points, streaks and badges.
            </Text>
            <Card padded={false}>
              <ListRow first icon="play-outline" title="Start a drive" subtitle="Mount the phone, tap Start. Speed, limits and conditions are read for you." />
              <ListRow icon="eye-outline" title="Stay focused" subtitle="Phone down, eyes on the road. Optional camera monitoring warns you before it matters." />
              <ListRow icon="trophy-outline" title="Earn" subtitle="Points for every focused minute, streaks for every focused drive, badges and a leaderboard." />
            </Card>
          </ScrollView>

          {/* 2 — Permissions */}
          <ScrollView style={pageStyle} contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
            <Eyebrow style={{ marginTop: 16 }}>Permissions</Eyebrow>
            <Text style={[t.typography.title, { color: t.colors.text, marginTop: 8 }]}>What RoadWise needs, and why</Text>
            <Text style={[t.typography.body, { color: t.colors.textMuted, marginTop: 8, marginBottom: 18 }]}>Only location is required. You can change any of these later in Settings.</Text>
            <Card padded={false}>
              <PermissionRow first id="location" status={perms.location} canAsk={perms.canAskLocation} onRequest={perms.requestLocation} onSettings={perms.openSettings} />
              <PermissionRow id="notifications" status={perms.notifications} canAsk={perms.canAskNotifications} onRequest={requestNotifications} onSettings={perms.openSettings} />
              {MONITORING_AVAILABLE && (
                <PermissionRow id="camera" status={perms.camera} canAsk={perms.canAskCamera} onRequest={perms.requestCamera} onSettings={perms.openSettings} />
              )}
            </Card>
          </ScrollView>

          {/* 3 — Monitoring (no placement or calibration step) */}
          <ScrollView style={pageStyle} contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
            <Eyebrow style={{ marginTop: 16 }}>Driver monitoring</Eyebrow>
            <Text style={[t.typography.title, { color: t.colors.text, marginTop: 8 }]}>Driver monitoring</Text>
            <Text style={[t.typography.body, { color: t.colors.textMuted, marginTop: 8, marginBottom: 18 }]}>
              Put your phone in any dash or windshield mount. The front camera works out where the road is on its own while you drive, then watches for eyes off the road and drowsiness. No setup, and nothing is recorded or uploaded.
            </Text>
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={[t.typography.bodyStrong, { color: t.colors.text }]}>Enable driver monitoring</Text>
                  <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 2 }]}>
                    {MONITORING_AVAILABLE ? 'Voice, tone and haptic alerts. Adjustable in Settings.' : 'Coming soon. Set your seat side now; the toggle unlocks when monitoring ships.'}
                  </Text>
                </View>
                {MONITORING_AVAILABLE ? <Toggle value={monitoringOn} onValueChange={toggleMonitoring} /> : <Chip label="Coming soon" tone="info" icon="time-outline" />}
              </View>
              {monitoringOn && perms.camera === 'denied' && (
                <Banner tone="warning" title="Camera access is off" body="Allow it in Settings to use monitoring." style={{ marginTop: 12 }} onPress={perms.openSettings} />
              )}
            </Card>
          </ScrollView>

          {/* 4 — Ready */}
          <ScrollView style={pageStyle} contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
            <Eyebrow style={{ marginTop: 16 }}>All set</Eyebrow>
            <Text style={[t.typography.title, { color: t.colors.text, marginTop: 8 }]}>You're ready to drive</Text>
            <Text style={[t.typography.body, { color: t.colors.textMuted, marginTop: 8, marginBottom: 18 }]}>Here is what is on.</Text>
            <Card padded={false}>
              <ListRow first icon="navigate-outline" title="Location" right={<Chip label={perms.location === 'granted' ? 'On' : 'Off'} tone={perms.location === 'granted' ? 'success' : 'danger'} />} />
              <ListRow icon="notifications-outline" title="Notifications" right={<Chip label={perms.notifications === 'granted' ? 'On' : 'Off'} tone={perms.notifications === 'granted' ? 'success' : 'neutral'} />} />
              <ListRow icon="eye-outline" title="Driver monitoring" subtitle={`${settings.monitoringDriverSide} seat`} right={<Chip label={!MONITORING_AVAILABLE ? 'Coming soon' : monitoringOn && perms.camera === 'granted' ? 'On' : 'Off'} tone={!MONITORING_AVAILABLE ? 'info' : monitoringOn && perms.camera === 'granted' ? 'success' : 'neutral'} />} />
            </Card>
            <Banner tone="info" icon="flame-outline" title="Your streak starts now" body="Every focused drive adds one. Picking up the phone resets it." style={{ marginTop: 16 }} />
          </ScrollView>
        </ScrollView>

        <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: t.spacing[5], paddingBottom: Math.max(insets.bottom, 16), paddingTop: 8 }}>
          {page > 0 && (
            <View style={{ width: 96 }}>
              <Button title="Back" variant="ghost" onPress={() => goTo(page - 1)} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            {page < PAGES - 1 ? (
              <Button
                title={page === 1 && perms.location !== 'granted' ? 'Continue without location' : 'Continue'}
                onPress={() => goTo(page + 1)}
                icon={<Ionicons name="arrow-forward" size={18} color={t.colors.accentText} />}
              />
            ) : (
              <Button title="Go to Home" onPress={finish} icon={<Ionicons name="checkmark" size={18} color={t.colors.accentText} />} />
            )}
          </View>
        </View>
      </View>
    </Screen>
  );
}
