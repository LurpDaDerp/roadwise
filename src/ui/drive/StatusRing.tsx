import { MaterialCommunityIcons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { hudPalette } from './hudTokens';

export type HudStatusLevel = 'calm' | 'attention' | 'critical';

export type StatusRingProps = {
  /** calm: all good; attention: an L1/L2 alert is active; critical: an L3 alert is active. */
  level: HudStatusLevel;
  night: boolean;
};

/** Thickness and mark per level: the strip reads in peripheral vision and without colour. */
const STRIP: Record<HudStatusLevel, { height: number; mark: 'alert' | 'alert-octagon' | null }> = {
  calm: { height: 4, mark: null },
  attention: { height: 10, mark: 'alert' },
  critical: { height: 16, mark: 'alert-octagon' },
};

const LABEL: Record<HudStatusLevel, string> = {
  calm: 'Recording',
  attention: 'Recording, alert active',
  critical: 'Recording, urgent alert',
};

/**
 * Zone 3 of the HUD (C3): the status strip, which doubles as the recording indicator — a steady
 * recording mark and a full-width strip. It is calm when all is well, then thickens and gains a
 * mark for an active alert. Static: no pulse, no blink, nothing that pulls the eye while moving.
 * Place it at the top or bottom edge; it spans the width it is given.
 */
function StatusRingView({ level, night }: StatusRingProps) {
  const p = hudPalette(night);
  const { height, mark } = STRIP[level];
  const color = level === 'calm' ? p.inkMuted : level === 'attention' ? p.attention : p.critical;

  return (
    <View
      testID="hud-status"
      accessible
      accessibilityRole="text"
      accessibilityLabel={LABEL[level]}
      style={styles.row}
    >
      <MaterialCommunityIcons name="record-circle" size={22} color={color} />
      {mark ? (
        <MaterialCommunityIcons testID="hud-status-mark" name={mark} size={24} color={color} />
      ) : null}
      <View testID="hud-status-strip" style={[styles.strip, { height, backgroundColor: color }]} />
    </View>
  );
}

export const StatusRing = memo(StatusRingView);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 24,
  },
  strip: {
    flex: 1,
    borderRadius: 8,
  },
});
