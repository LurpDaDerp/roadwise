import { View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { Card, Text, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import { countMetric, distanceMetric, type Metric } from './format';
import { MetricCell } from './MetricCell';
import type { AllTimeTotals } from './model';

const c = analyticsCopy.allTime;
const NONE: Metric = { value: '—', unit: '', spoken: 'none yet' };

/**
 * The all-time totals above the range toggle, titled "All time": the longest clean drive (opening
 * the drive it came from) and how many drives were clean, side by side. The range never moves them.
 */
export function AllTimeCard({ allTime, onOpen }: { allTime: AllTimeTotals; onOpen: (clientTripId: string) => void }) {
  const t = useTheme();
  const units = useUnits();
  const best = allTime.longestClean;
  return (
    <Card testID="analytics-all-time">
      <Text variant="title3" accessibilityRole="header">
        {c.title}
      </Text>
      <View style={{ flexDirection: 'row', gap: t.space.md }}>
        <MetricCell
          caption={c.longestClean}
          metric={best ? distanceMetric(best.value, units) : NONE}
          onPress={best ? () => onOpen(best.clientTripId) : undefined}
          hint={best ? c.hint : undefined}
          style={{ flex: 1 }}
          testID="all-time-longest-clean"
        />
        <MetricCell caption={c.cleanDrives} metric={countMetric(allTime.cleanDrives)} style={{ flex: 1 }} testID="all-time-clean-drives" />
      </View>
    </Card>
  );
}
