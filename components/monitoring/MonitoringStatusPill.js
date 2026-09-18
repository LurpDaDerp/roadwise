// MonitoringStatusPill — [MP-1] tiny status readout for the drive top bar.
// ≤ 3 words, colour-coded; never requires reading a sentence.
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme';
import { CALIBRATION_STATE, MONITOR_STATUS } from '../../monitoring/types';

function describe(status, calibration, enabled) {
  if (!enabled) return { label: 'Monitoring off', icon: 'videocam-off-outline', tone: 'neutral' };
  switch (status) {
    case MONITOR_STATUS.STARTING:
      return { label: 'Starting camera', icon: 'videocam-outline', tone: 'neutral' };
    case MONITOR_STATUS.CALIBRATING:
      return { label: `Calibrating ${Math.round((calibration?.progress || 0) * 100)}%`, icon: 'scan-outline', tone: 'info' };
    case MONITOR_STATUS.ACTIVE:
      if (calibration?.state === CALIBRATION_STATE.PROVISIONAL) return { label: 'Monitoring · refining', icon: 'eye-outline', tone: 'accent' };
      if (calibration?.state === CALIBRATION_STATE.LOST) return { label: 'Recalibrating', icon: 'scan-outline', tone: 'warning' };
      return { label: 'Monitoring', icon: 'eye-outline', tone: 'accent' };
    case MONITOR_STATUS.NO_FACE:
      return { label: 'Driver not visible', icon: 'videocam-off-outline', tone: 'warning' };
    case MONITOR_STATUS.CAMERA_ERROR:
      return { label: 'Camera error', icon: 'warning-outline', tone: 'danger' };
    case MONITOR_STATUS.PERMISSION_DENIED:
      return { label: 'Camera blocked', icon: 'lock-closed-outline', tone: 'danger' };
    case MONITOR_STATUS.OFF:
    default:
      return { label: 'Monitoring off', icon: 'videocam-off-outline', tone: 'neutral' };
  }
}

export const MonitoringStatusPill = React.memo(function MonitoringStatusPill({
  status, calibration, enabled, onPress, style,
}) {
  const t = useTheme();
  const d = describe(status, calibration, enabled);
  const tones = {
    neutral: { bg: t.colors.surfaceAlt, fg: t.colors.textMuted },
    accent: { bg: t.colors.accentFaint, fg: t.colors.accent },
    info: { bg: t.colors.infoFaint, fg: t.colors.info },
    warning: { bg: t.colors.warningFaint, fg: t.colors.warning },
    danger: { bg: t.colors.dangerFaint, fg: t.colors.danger },
  };
  const c = tones[d.tone] || tones.neutral;
  const inner = (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          backgroundColor: c.bg,
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: t.radius.pill,
        },
        style,
      ]}
      accessibilityLabel={`Driver monitoring: ${d.label}`}
    >
      <Ionicons name={d.icon} size={14} color={c.fg} />
      <Text style={{ color: c.fg, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 }} numberOfLines={1}>
        {d.label}
      </Text>
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable onPress={onPress} hitSlop={8} style={pressedStyle}>
      {inner}
    </Pressable>
  );
});

const pressedStyle = ({ pressed }) => (pressed ? { opacity: 0.8 } : null);

export default MonitoringStatusPill;
