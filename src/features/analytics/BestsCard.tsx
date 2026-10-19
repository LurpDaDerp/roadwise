import { View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { Card, Text, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import { distanceMetric, pointsMetric, type Metric } from './format';
import { MetricCell } from './MetricCell';
import type { Best, PersonalBests } from './model';

const NONE: Metric = { value: '—', unit: '', spoken: 'none yet' };

/** All-time bests in one row of three; each opens the drive it came from. */
export function BestsCard({ bests, onOpen }: { bests: PersonalBests; onOpen: (clientTripId: string) => void }) {
  const t = useTheme();
  const units = useUnits();
  const cells: { key: string; caption: string; best: Best | null; metric: (b: Best) => Metric }[] = [
    { key: 'points', caption: analyticsCopy.bests.mostPoints, best: bests.mostPoints, metric: (b) => pointsMetric(b.value) },
    { key: 'clean', caption: analyticsCopy.bests.longestClean, best: bests.longestClean, metric: (b) => distanceMetric(b.value, units) },
    { key: 'phone-free', caption: analyticsCopy.bests.phoneFree, best: bests.longestPhoneFree, metric: (b) => distanceMetric(b.value, units) },
  ];
  return (
    <Card testID="analytics-bests">
      <Text variant="title3" accessibilityRole="header">
        {analyticsCopy.bests.title}
      </Text>
      <View style={{ flexDirection: 'row', gap: t.space.md }}>
        {cells.map(({ key, caption, best, metric }) => (
          <MetricCell
            key={key}
            caption={caption}
            metric={best ? metric(best) : NONE}
            onPress={best ? () => onOpen(best.clientTripId) : undefined}
            hint={best ? analyticsCopy.bests.hint : undefined}
            style={{ flex: 1 }}
            testID={`best-${key}`}
          />
        ))}
      </View>
    </Card>
  );
}
