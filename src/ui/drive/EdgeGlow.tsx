import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { GLOW_BLUR_PT, GLOW_RIM_PT } from './hudTokens';

export type EdgeGlowProps = {
  /** The glow's colour, or null for none. */
  color: string | null;
};

/**
 * A static glow around the screen's edge: a solid rim plus a soft inner shadow in one colour. It
 * never pulses or moves — it is read out of the corner of the eye as colour — and takes no touch.
 */
function EdgeGlowView({ color }: EdgeGlowProps) {
  if (color === null) return null;
  return (
    <View
      testID="hud-glow"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        StyleSheet.absoluteFill,
        {
          borderWidth: GLOW_RIM_PT,
          borderColor: color,
          boxShadow: `inset 0 0 ${GLOW_BLUR_PT}px ${GLOW_RIM_PT * 2}px ${color}`,
        },
      ]}
    />
  );
}

export const EdgeGlow = memo(EdgeGlowView);
