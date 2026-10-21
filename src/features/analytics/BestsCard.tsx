import { View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';
import { Card, Text, useTheme, type CardVariant } from '@/ui';

import { analyticsCopy } from './copy';
import { distanceMetric, type Metric } from './format';
import { MetricCell } from './MetricCell';
import type { Best, PersonalBests } from './model';

const NONE: Metric = { value: '—', unit: '', spoken: 'none yet' };

export type BestKey = 'clean';

/** Each best's caption, its drive and its number. */
function bestCell(key: BestKey, bests: PersonalBests, units: Units): { caption: string; best: Best | null; metric: (b: Best) => Metric } {
  switch (key) {
    case 'clean':
      return { caption: analyticsCopy.bests.longestClean, best: bests.longestClean, metric: (b) => distanceMetric(b.value, units) };
  }
}

/** All-time bests in one row (the longest clean drive), each opening the drive it came from. */
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
