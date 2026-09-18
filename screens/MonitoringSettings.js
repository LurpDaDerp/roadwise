// MONITORING MOUNT POINT [settings]
// Every driver-monitoring preference lives here and is stored by
// context/SettingsContext.js under these names:
//   monitoringEnabled        — master switch (needs the camera permission)
//   monitoringVoiceAlerts    — spoken alert phrases
//   monitoringToneAlerts     — alert tone
//   monitoringHapticAlerts   — vibration on alerts
//   monitoringSensitivity    — 'low' | 'medium' | 'high'  (SENSITIVITY_OPTIONS)
//   monitoringDriverSide     — 'left' | 'right'           (DRIVER_SIDE_OPTIONS)
//   monitoringShowPreview    — show the live camera preview during a drive
// The monitoring branch reads them through monitoringSettingsFrom(settings).
import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  Banner,
  Button,
  Chip,
  ToggleRow,
  useTheme,
} from '../theme';
import { useSettings } from '../context/SettingsContext';
import { usePermissions, PERMISSION_COPY } from '../hooks/usePermissions';
import { SENSITIVITY_OPTIONS } from '../monitoring/settings';
import { CameraPlacementGuide } from '../components/monitoring/CameraPlacementGuide';

const CAMERA_CHIP = {
  granted: { tone: 'success', label: 'Camera allowed', icon: 'checkmark-circle-outline' },
  denied: { tone: 'danger', label: 'Camera blocked', icon: 'close-circle-outline' },
  undetermined: { tone: 'neutral', label: 'Camera not asked yet', icon: 'help-circle-outline' },
  unavailable: { tone: 'neutral', label: 'Camera unavailable', icon: 'alert-circle-outline' },
};

export default function MonitoringSettings() {
  const t = useTheme();
  const { settings, update } = useSettings();
  const { camera, requestCamera, openSettings } = usePermissions();

  const enabled = !!settings.monitoringEnabled;
  const chip = CAMERA_CHIP[camera] || CAMERA_CHIP.undetermined;
  const needsPermission = enabled && camera !== 'granted';

  const onToggleEnabled = async (value) => {
    update('monitoringEnabled', value);
    if (value && camera !== 'granted') await requestCamera();
  };

  const dimmed = {
    opacity: enabled ? 1 : 0.5,
  };

  return (
    <Screen hasHeader>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: t.spacing[8] }}
      >
        <ScreenHeader
          eyebrow="Settings"
          title="Driver monitoring"
          subtitle="Watches for eyes off the road while you drive."
        />

        <Section>
          <Banner tone="info" icon="videocam-outline" body={PERMISSION_COPY.camera.body} />
        </Section>

        <Section>
          <Card padded={false}>
            <ToggleRow
              first
              icon="eye-outline"
              title="Enable driver monitoring"
              subtitle="Uses the front camera during a drive."
              value={enabled}
              onValueChange={onToggleEnabled}
            />
          </Card>
          <View style={{ marginTop: 12 }}>
            <Chip label={chip.label} icon={chip.icon} tone={chip.tone} />
          </View>
          {needsPermission && (
            <View style={{ marginTop: 12 }}>
              <Banner
                tone="danger"
                title="Camera access is off"
                body={
                  camera === 'undetermined'
                    ? 'Monitoring stays off until you allow the camera.'
                    : 'Allow camera access for RoadWise in your phone settings, then come back.'
                }
              />
              <View style={{ height: 10 }} />
              {camera === 'undetermined' ? (
                <Button title="Allow camera" variant="ghost" onPress={requestCamera} />
              ) : (
                <Button title="Open Settings" variant="ghost" onPress={openSettings} />
              )}
            </View>
          )}
        </Section>

        <View style={dimmed} pointerEvents={enabled ? 'auto' : 'none'}>
          <Section label="Alerts">
            <Card padded={false}>
              <ToggleRow
                first
                icon="chatbox-ellipses-outline"
                title="Voice"
                subtitle="Speaks what went wrong."
                value={settings.monitoringVoiceAlerts}
                onValueChange={(v) => update('monitoringVoiceAlerts', v)}
                disabled={!enabled}
              />
              <ToggleRow
                icon="musical-note-outline"
                title="Tone"
                subtitle="Plays an alert sound."
                value={settings.monitoringToneAlerts}
                onValueChange={(v) => update('monitoringToneAlerts', v)}
                disabled={!enabled}
              />
              <ToggleRow
                icon="phone-portrait-outline"
                title="Haptic"
                subtitle="Vibrates the phone."
                value={settings.monitoringHapticAlerts}
                onValueChange={(v) => update('monitoringHapticAlerts', v)}
                disabled={!enabled}
              />
            </Card>
            <Text
              style={[
                t.typography.caption,
                { color: t.colors.textMuted, marginTop: 10, paddingHorizontal: 4 },
              ]}
            >
              Low-priority alerts are shown on screen only. A warning plays once when it starts. A
              critical alert repeats until it clears.
            </Text>
          </Section>

          <Section label="Sensitivity">
            <View style={{ gap: 10 }}>
              {SENSITIVITY_OPTIONS.map((opt) => {
                const active = settings.monitoringSensitivity === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => update('monitoringSensitivity', opt.value)}
                    disabled={!enabled}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active, disabled: !enabled }}
                    accessibilityLabel={`${opt.label} sensitivity`}
                    style={({ pressed }) => [
                      {
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        padding: 16,
                        borderRadius: t.radius.lg,
                        borderWidth: 1.5,
                        borderColor: active ? t.colors.accent : t.colors.border,
                        backgroundColor: active ? t.colors.accentFaint : t.colors.surface,
                        opacity: pressed ? 0.85 : 1,
                      },
                    ]}
                  >
                    <View
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 10,
                        borderWidth: 2,
                        borderColor: active ? t.colors.accent : t.colors.borderStrong,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {active && (
                        <View
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            backgroundColor: t.colors.accent,
                          }}
                        />
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          t.typography.bodyStrong,
                          { color: active ? t.colors.accent : t.colors.text },
                        ]}
                      >
                        {opt.label}
                      </Text>
                      <Text
                        style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 2 }]}
                      >
                        {opt.body}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </Section>

          <Section label="Camera placement">
            <Card>
              <CameraPlacementGuide
                driverSide={settings.monitoringDriverSide}
                onDriverSideChange={(side) => update('monitoringDriverSide', side)}
              />
            </Card>
            <View style={{ height: 12 }} />
            <Card padded={false}>
              <ToggleRow
                first
                icon="scan-outline"
                title="Show camera preview while driving"
                subtitle="A small live view so you can check the framing."
                value={settings.monitoringShowPreview}
                onValueChange={(v) => update('monitoringShowPreview', v)}
                disabled={!enabled}
              />
            </Card>
          </Section>
        </View>
      </ScrollView>
    </Screen>
  );
}
