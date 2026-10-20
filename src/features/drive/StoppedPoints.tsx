import { memo } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { formatPointsValue } from '@/ui';
import { fontFamilies } from '@/ui/fonts';
import type { HudPalette } from '@/ui/drive';

import { hudCopy } from './hudCopy';

/** How long the points take to fade in as the car stops, and out as it moves off. */
export const STOPPED_POINTS_FADE_IN_MS = 400;
export const STOPPED_POINTS_FADE_OUT_MS = 250;

/**
 * The points, shown only while stopped (the parent renders this only when `points` is non-null):
 * the running total and its "pts" label, fading in and out (Reduce Motion: they just appear). It
 * never exists while moving.
 */
function StoppedPointsView({ total, palette: p }: { total: number; palette: HudPalette }) {
  const totalText = formatPointsValue(total);
  return (
    <Animated.View entering={FadeIn.duration(STOPPED_POINTS_FADE_IN_MS)} exiting={FadeOut.duration(STOPPED_POINTS_FADE_OUT_MS)}>
      <Text testID="hud-points" accessibilityLabel={hudCopy.points.label(totalText)} allowFontScaling={false} style={[styles.total, { color: p.ink }]}>
        {totalText}
        <Text style={[styles.unit, { color: p.inkMuted }]}> {hudCopy.points.unit}</Text>
      </Text>
    </Animated.View>
  );
}

export const StoppedPoints = memo(StoppedPointsView);

const styles = StyleSheet.create({
  total: { fontFamily: fontFamilies.numeralsBold, fontSize: 40, lineHeight: 46, fontVariant: ['tabular-nums'] },
  unit: { fontFamily: fontFamilies.field, fontSize: 20 },
});
