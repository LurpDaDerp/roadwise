import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { View } from 'react-native';

import type { Conditions } from '@/features/weather/conditions';
import { Text, useTheme } from '@/ui';

/** The row icon's size before the text is measured: the temperature's line (28) plus the sky's (18). */
const ICON_FALLBACK = 46;
/** The compact icon's size before the temperature is measured: its line (24). */
const COMPACT_ICON_FALLBACK = 24;

/**
 * The weather now on the drive card: the temperature in degrees Fahrenheit ("72° F") with the sky
 * in a few words under it ("Partly cloudy"), spoken as one line. Always °F.
 * - Compact (beside the rating ring): right-aligned, a coloured icon as tall as the temperature at
 *   its left, the sky's words under both.
 * - Row (above Start drive, with large text or no ring): left-aligned, the coloured icon at the left
 *   as tall as the two lines together.
 * Both icons are measured, so they follow the text size.
 */
export function WeatherReadout({ conditions, compact = false }: { conditions: Conditions; compact?: boolean }) {
  const t = useTheme();
  const [textHeight, setTextHeight] = useState(compact ? COMPACT_ICON_FALLBACK : ICON_FALLBACK);
  const temp = `${conditions.tempF}° F`;
  const a11y = { accessible: true, accessibilityLabel: `${conditions.tempF} degrees Fahrenheit, ${conditions.label}`, testID: 'home-conditions' };
  const icon = <Ionicons name={conditions.icon} size={textHeight} color={conditions.color} testID="home-conditions-icon" />;
  const measure = (e: { nativeEvent: { layout: { height: number } } }) => setTextHeight(Math.round(e.nativeEvent.layout.height));

  if (compact) {
    return (
      <View {...a11y} style={{ alignItems: 'flex-end' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs }}>
          {icon}
          <Text variant="title3" numberOfLines={1} onLayout={measure} testID="home-conditions-temp">
            {temp}
          </Text>
        </View>
        <Text variant="footnote" tone="muted" style={{ textAlign: 'right' }} testID="home-conditions-label">
          {conditions.label}
        </Text>
      </View>
    );
  }

  return (
    <View {...a11y} style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
      {icon}
      <View onLayout={measure}>
        <Text variant="title2" numberOfLines={1} testID="home-conditions-temp">
          {temp}
        </Text>
        <Text variant="footnote" tone="muted" numberOfLines={1} testID="home-conditions-label">
          {conditions.label}
        </Text>
      </View>
    </View>
  );
}
