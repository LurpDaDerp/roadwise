import { View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';
import { Card, Text, useTheme, type CardVariant } from '@/ui';

import { analyticsCopy } from './copy';
import { distanceMetric, pointsMetric, type Metric } from './format';
import { MetricCell } from './MetricCell';
import type { Best, PersonalBests } from './model';

const NONE: Metric = { value: '—', unit: '', spoken: 'none yet' };

export type BestKey = 'points' | 'clean' | 'phone-free';

/** Each best's caption, its drive and its number. */
function bestCell(key: BestKey, bests: PersonalBests, units: Units): { caption: string; best: Best | null; metric: (b: Best) => Metric } {
  switch (key) {
    case 'points':
      return { caption: analyticsCopy.bests.mostPoints, best: bests.mostPoints, metric: (b) => pointsMetric(b.value) };
    case 'clean':
      return { caption: analyticsCopy.bests.longestClean, best: bests.longestClean, metric: (b) => distanceMetric(b.value, units) };
    case 'phone-free':
      return { caption: analyticsCopy.bests.phoneFree, best: bests.longestPhoneFree, metric: (b) => distanceMetric(b.value, units) };
  }
}

/**
 * All-time bests in one row, each opening the drive it came from. The page shows the general one
 * (most points); a category's sheet shows its own (longest clean, longest phone-free).
 */
export function BestsCard({
  bests,
  show,
  onOpen,
  variant,
  testID = 'analytics-bests',
}: {
  bests: PersonalBests;
  show: readonly BestKey[];
  onOpen: (clientTripId: string) => void;
  variant?: CardVariant;
  testID?: string;
}) {
  const t = useTheme();
  const units = useUnits();
  return (
    <Card variant={variant} testID={testID}>
      <Text variant="title3" accessibilityRole="header">
        {analyticsCopy.bests.title}
      </Text>
      <View style={{ flexDirection: 'row', gap: t.space.md }}>
        {show.map((key) => {
          const { caption, best, metric } = bestCell(key, bests, units);
          return (
            <MetricCell
              key={key}
              caption={caption}
              metric={best ? metric(best) : NONE}
              onPress={best ? () => onOpen(best.clientTripId) : undefined}
              hint={best ? analyticsCopy.bests.hint : undefined}
              style={{ flex: 1 }}
              testID={`best-${key}`}
            />
          );
        })}
      </View>
    </Card>
  );
}
