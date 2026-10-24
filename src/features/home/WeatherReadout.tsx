import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import type { Conditions } from '@/features/weather/conditions';
import { Text, useTheme } from '@/ui';

const ICON = 28;

/**
 * The weather now on the drive card, above Start drive: a coloured icon beside the temperature
 * ("72° F"), with the sky in a few words under it ("Partly cloudy"). Always °F.
 */
export function WeatherReadout({ conditions }: { conditions: Conditions }) {
  const t = useTheme();
  const temp = `${conditions.tempF}° F`;
  return (
    <View accessible accessibilityLabel={`${conditions.tempF} degrees Fahrenheit, ${conditions.label}`} testID="home-conditions" style={{ alignSelf: 'flex-start' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <Ionicons name={conditions.icon} size={ICON} color={conditions.color} testID="home-conditions-icon" />
        <Text variant="title2" numberOfLines={1} testID="home-conditions-temp">
          {temp}
        </Text>
      </View>
      <Text variant="footnote" tone="muted" numberOfLines={1} style={{ marginLeft: ICON + t.space.sm }} testID="home-conditions-label">
        {conditions.label}
      </Text>
    </View>
  );
}
