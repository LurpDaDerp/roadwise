// CalibrationGate — [MP-2] banner shown in the alert slot while the monitoring
// learns the driver's "looking forward" pose (label-free, first ~1–2 min).
// Never blocks driving; it only informs and offers a manual recalibration.
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme, ProgressBar } from '../../theme';
import { CALIBRATION_STATE } from '../../monitoring/types';

export function shouldShowCalibrationGate(calibration) {
  const s = calibration?.state;
  return s === CALIBRATION_STATE.CALIBRATING || s === CALIBRATION_STATE.PROVISIONAL || s === CALIBRATION_STATE.LOST;
}

export function CalibrationGate({ calibration, onRecalibrate, compact = false, style }) {
  const t = useTheme();
  if (!shouldShowCalibrationGate(calibration)) return null;
  const state = calibration.state;
  const progress = Number(calibration.progress) || 0;
  const copy = {
    [CALIBRATION_STATE.CALIBRATING]: {
      title: 'Learning your forward view',
      body: 'Drive normally and look at the road.',
      tone: t.colors.info,
      bg: t.colors.infoFaint,
      icon: 'scan-outline',
    },
    [CALIBRATION_STATE.PROVISIONAL]: {
      title: 'Monitoring active · refining',
      body: 'Alerts are on. Calibration keeps improving.',
      tone: t.colors.accent,
      bg: t.colors.accentFaint,
      icon: 'eye-outline',
    },
    [CALIBRATION_STATE.LOST]: {
      title: 'Camera moved · recalibrating',
      body: 'Keep the phone steady and look ahead.',
      tone: t.colors.warning,
      bg: t.colors.warningFaint,
      icon: 'warning-outline',
    },
  }[state];

  return (
    <View
      style={[
        {
          backgroundColor: copy.bg,
          borderRadius: t.radius.md,
          paddingVertical: compact ? 10 : 12,
          paddingHorizontal: 14,
          borderWidth: 1,
          borderColor: copy.tone,
        },
        style,
      ]}
      accessibilityLiveRegion="polite"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Ionicons name={copy.icon} size={20} color={copy.tone} />
        <View style={{ flex: 1 }}>
          <Text style={[t.typography.bodyStrong, { color: t.colors.text }]} numberOfLines={1}>
            {copy.title}
          </Text>
          {!compact && (
            <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 1 }]} numberOfLines={1}>
              {copy.body}
            </Text>
          )}
        </View>
        {state !== CALIBRATION_STATE.CALIBRATING && !!onRecalibrate && (
          <Pressable
            onPress={onRecalibrate}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Recalibrate"
            style={({ pressed }) => [
              {
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: t.radius.pill,
                backgroundColor: t.colors.surface,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text style={{ color: copy.tone, fontSize: 12, fontWeight: '700' }}>Recalibrate</Text>
          </Pressable>
        )}
      </View>
      {state === CALIBRATION_STATE.CALIBRATING && (
        <ProgressBar value={progress} tone="info" height={6} style={{ marginTop: 10 }} />
      )}
    </View>
  );
}

export default CalibrationGate;
