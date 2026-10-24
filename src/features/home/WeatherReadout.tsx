import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { View } from 'react-native';

import type { Conditions } from '@/features/weather/conditions';
import { Text, useTheme } from '@/ui';

/** The icon's size before the text is measured: the temperature's line (28) plus the sky's (18). */
const ICON_FALLBACK = 46;

/**
 * The weather now on the drive card, above Start drive: the temperature in degrees Fahrenheit
 * ("72° F") with the sky in a few words under it ("Partly cloudy"), and a coloured icon at their
 * left as tall as the two lines together (measured, so it follows the text size). Always °F.
 */
export function WeatherReadout({ conditions }: { conditions: Conditions }) {
  const t = useTheme();
  const [textHeight, setTextHeight] = useState(ICON_FALLBACK);
  const temp = `${conditions.tempF}° F`;
  return (
    <View
      accessible
      accessibilityLabel={`${conditions.tempF} degrees Fahrenheit, ${conditions.label}`}
      testID="home-conditions"
      style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}
    >
      <Ionicons name={conditions.icon} size={textHeight} color={conditions.color} testID="home-conditions-icon" />
      <View onLayout={(e) => setTextHeight(Math.round(e.nativeEvent.layout.height))}>
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
