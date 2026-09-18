// DriveTopBar — SOS (left), monitoring status pill (centre, [MP-1]), elapsed time (right).
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../../theme';
import { MonitoringStatusPill } from '../monitoring/MonitoringStatusPill';
import { formatClock } from '../../utils/format';

/**
 * The drive clock owns its own 1 Hz timer so the tick re-renders 40 characters of text and
 * nothing else. It used to live in useDriveSession as a piece of state, which re-rendered the
 * whole drive screen - speed hero, points card, conditions strip, alert slot - once a second.
 */
const ElapsedClock = React.memo(function ElapsedClock({ startedAt, running = true }) {
  const t = useTheme();
  const [elapsed, setElapsed] = useState(() =>
    startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0);

  useEffect(() => {
    if (!startedAt || !running) return undefined;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt, running]);

  const text = formatClock(elapsed);
  return (
    <View style={styles.clock} accessibilityLabel={`Elapsed ${text}`}>
      <Text style={[styles.clockText, { color: t.colors.text }]}>{text}</Text>
    </View>
  );
});

export const DriveTopBar = React.memo(function DriveTopBar({
  onSos, monitoring, monitoringEnabled, showMonitoring = true, startedAt, running = true, onPillPress,
}) {
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

      <ElapsedClock startedAt={startedAt} running={running} />
    </View>
  );
});

const styles = StyleSheet.create({
  clock: { minWidth: 64, alignItems: 'flex-end' },
  clockText: { fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
});

export default DriveTopBar;
