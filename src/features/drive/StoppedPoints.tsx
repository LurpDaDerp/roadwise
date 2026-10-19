import { memo } from 'react';
import { StyleSheet, Text } from 'react-native';

import { formatPointsValue } from '@/ui';
import { fontFamilies } from '@/ui/fonts';
import type { HudPalette } from '@/ui/drive';

import { hudCopy } from './hudCopy';

/**
 * The points, shown only while stopped (the parent renders this only when `points` is non-null):
 * the running total and its "pts" label, still. It never exists while moving.
 */
function StoppedPointsView({ total, palette: p }: { total: number; palette: HudPalette }) {
  const totalText = formatPointsValue(total);
  return (
    <Text testID="hud-points" accessibilityLabel={hudCopy.points.label(totalText)} allowFontScaling={false} style={[styles.total, { color: p.ink }]}>
      {totalText}
      <Text style={[styles.unit, { color: p.inkMuted }]}> {hudCopy.points.unit}</Text>
    </Text>
  );
}

export const StoppedPoints = memo(StoppedPointsView);

const styles = StyleSheet.create({
  total: { fontFamily: fontFamilies.numeralsBold, fontSize: 40, lineHeight: 46, fontVariant: ['tabular-nums'] },
  unit: { fontFamily: fontFamilies.field, fontSize: 20 },
});
