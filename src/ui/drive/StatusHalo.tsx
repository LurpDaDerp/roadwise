import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { type HaloLevel, HALO_STROKE_PT, haloColor, hudPalette } from './hudTokens';

export type StatusHaloProps = {
  /** calm: all well; attention: something needs a glance; critical: urgent. */
  level: HaloLevel;
  /** Diameter in pt (`haloSize`). */
  size: number;
  /** True only while the engine records this drive, for the spoken label. */
  recording: boolean;
  night: boolean;
  /** The speed readout, centred in the ring. */
  children?: ReactNode;
};

const LABEL: Record<'recording' | 'idle', Record<HaloLevel, string>> = {
  recording: {
    calm: 'Recording, all calm',
    attention: 'Recording, caution',
    critical: 'Recording, urgent',
  },
  idle: { calm: 'Not recording', attention: 'Caution', critical: 'Urgent' },
};

/**
 * The status halo: a ring round the speed whose colour is the whole message — teal while the
 * drive is smooth, yellow when something needs a glance, soft red when it is urgent. Colour
 * changes only: no pulse, no blink, nothing that pulls the eye while moving, and nothing that
 * costs a frame while calm. Not itself accessible, so the readout inside stays reachable; the
 * label documents the state for tests and inspectors.
 */
function StatusHaloView({ level, size, recording, night, children }: StatusHaloProps) {
  const p = hudPalette(night);
  return (
    <View
      testID="hud-halo"
      accessibilityLabel={LABEL[recording ? 'recording' : 'idle'][level]}
      style={[
        styles.ring,
        { width: size, height: size, borderRadius: size / 2, borderColor: haloColor(p, level) },
      ]}
    >
      {children}
    </View>
  );
}

export const StatusHalo = memo(StatusHaloView);

const styles = StyleSheet.create({
  ring: {
    borderWidth: HALO_STROKE_PT,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
