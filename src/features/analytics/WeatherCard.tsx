import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { formatDistance } from '@/lib/units';
import { Card, Text, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import { weatherView, type WeatherSums } from './insights';

const w = analyticsCopy.weather;

/**
 * Under Time of day: how the drives go in rain or snow against the dry, all time (`weatherView`:
 * events per mile, or per kilometer, wet against dry), with how many drives and how far in the wet.
 * It is a comment, not a score: weather never costs points or moves the rating. Hidden until both
 * the wet and the dry drives reach 10 mi (16 km).
 */
export function WeatherCard({ sums }: { sums: WeatherSums }) {
  const t = useTheme();
  const units = useUnits();
  const view = weatherView(sums, units);
  if (view === null) return null;
  const text = w.text(view, units);
  const detail = w.detail(sums.wet.drives, formatDistance(sums.wet.miles, units, { digits: 0 }));
  const spoken = w.detail(sums.wet.drives, formatDistance(sums.wet.miles, units, { digits: 0, spoken: true }));
  return (
    <Card testID="analytics-weather">
      <View accessible accessibilityLabel={`${w.title}. ${text} ${spoken.replace(' · ', ', ')}.`} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <Ionicons name="rainy-outline" size={t.size.iconLg} color={t.colors.textMuted} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline">{w.title}</Text>
          <Text variant="subhead" tone="muted" testID="analytics-weather-text">
            {text}
          </Text>
          <Text variant="footnote" tone="muted" testID="analytics-weather-detail">
            {detail}
          </Text>
        </View>
      </View>
    </Card>
  );
}
