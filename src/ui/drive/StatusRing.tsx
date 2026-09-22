import { MaterialCommunityIcons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { hudPalette } from './hudTokens';

export type HudStatusLevel = 'calm' | 'attention' | 'critical';

export type StatusRingProps = {
  /** calm: all good; attention: an L1/L2 alert is active; critical: an L3 alert is active. */
  level: HudStatusLevel;
  /**
   * True only while the engine is recording this drive (U1 review M3). The recording mark and the
   * word "Recording" follow it, so the ring never claims a recording during a candidate or
   * confirming window, or while the drive is ending. U2 mounts the ring only while recording and
   * passes the engine's state, not a constant.
   */
  recording: boolean;
  night: boolean;
};

/** Thickness and mark per level: the strip reads in peripheral vision and without colour. */
const STRIP: Record<HudStatusLevel, { height: number; mark: 'alert' | 'alert-octagon' | null }> = {
  calm: { height: 4, mark: null },
  attention: { height: 10, mark: 'alert' },
  critical: { height: 16, mark: 'alert-octagon' },
};

/** Off the recording state the label makes no claim about recording either way. */
const LABEL: Record<'recording' | 'idle', Record<HudStatusLevel, string>> = {
  recording: {
    calm: 'Recording',
    attention: 'Recording, alert active',
    critical: 'Recording, urgent alert',
  },
  idle: {
    calm: 'No alert',
    attention: 'Alert active',
    critical: 'Urgent alert',
  },
};

/**
 * Zone 3 of the HUD (C3): the status strip, which doubles as the recording indicator — a steady
 * recording mark (only while `recording`) and a full-width strip. It is calm when all is well,
 * then thickens and gains a mark for an active alert. Static: no pulse, no blink, nothing that pulls the eye while moving.
 * Place it at the top or bottom edge; it spans the width it is given.
 */
function StatusRingView({ level, recording, night }: StatusRingProps) {
  const p = hudPalette(night);
  const { height, mark } = STRIP[level];
  const color = level === 'calm' ? p.inkMuted : level === 'attention' ? p.attention : p.critical;

  return (
    <View
      testID="hud-status"
      accessible
      accessibilityRole="text"
      accessibilityLabel={LABEL[recording ? 'recording' : 'idle'][level]}
      style={styles.row}
    >
      {recording ? (
        <MaterialCommunityIcons
          testID="hud-status-recording"
          name="record-circle"
          size={22}
          color={color}
        />
      ) : null}
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
