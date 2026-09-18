// DriveTopBar — SOS (left), monitoring status pill (centre, [MP-1]), elapsed time (right).
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme';
import { MonitoringStatusPill } from '../monitoring/MonitoringStatusPill';
import { formatClock } from '../../utils/format';

export function DriveTopBar({ onSos, monitoring, monitoringEnabled, showMonitoring = true, elapsed, onPillPress }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Pressable
        onPress={onSos}
        accessibilityRole="button"
        accessibilityLabel="Emergency"
        hitSlop={8}
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: t.colors.danger,
            paddingHorizontal: 14,
            height: 44,
            borderRadius: 22,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Ionicons name="alert-circle" size={20} color="#fff" />
        <Text style={{ color: '#fff', fontWeight: '900', fontSize: 15, letterSpacing: 1 }}>SOS</Text>
      </Pressable>

      {/* MONITORING MOUNT POINT [MP-1]: status pill (hidden while MONITORING_AVAILABLE is false) */}
      {showMonitoring ? (
        <MonitoringStatusPill
          status={monitoring?.status}
          calibration={monitoring?.calibration}
          enabled={monitoringEnabled}
          onPress={onPillPress}
          style={{ maxWidth: 190 }}
        />
      ) : (
        <View />
      )}

      <View style={{ minWidth: 64, alignItems: 'flex-end' }} accessibilityLabel={`Elapsed ${formatClock(elapsed)}`}>
        <Text style={{ color: t.colors.text, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{formatClock(elapsed)}</Text>
      </View>
    </View>
  );
}

export default DriveTopBar;
