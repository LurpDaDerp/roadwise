import { View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';
import { Card, Text, tokens, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import { countMetric, distanceMetric, percentMetric, pointsMetric, speedMetric, timeMetric, type Metric } from './format';
import { METRIC_CELL_GAP, MetricCell } from './MetricCell';
import type { WindowSums } from './model';

const m = analyticsCopy.metrics;

interface MetricGroup {
  key: 'driving' | 'events' | 'phone';
  title: string;
  /** Four cells, read as two rows of two. */
  cells: { key: string; caption: string; metric: Metric }[];
}

/** The range's twelve numbers in three groups of four. */
export function metricGroups(s: WindowSums, units: Units): MetricGroup[] {
  return [
    {
      key: 'driving',
      title: m.driving,
      cells: [
        { key: 'drives', caption: m.drives, metric: countMetric(s.drives) },
        { key: 'distance', caption: m.distance, metric: distanceMetric(s.miles, units) },
        { key: 'time', caption: m.driveTime, metric: timeMetric(s.durationS) },
        { key: 'speed', caption: m.avgSpeed, metric: speedMetric(s.avgMph, units) },
      ],
    },
    {
      key: 'events',
      title: m.events,
      cells: [
        { key: 'speeding', caption: m.speeding, metric: countMetric(s.speeding) },
        { key: 'brakes', caption: m.hardBrakes, metric: countMetric(s.hardBrake) },
        { key: 'starts', caption: m.hardStarts, metric: countMetric(s.hardAccel) },
        { key: 'turns', caption: m.sharpTurns, metric: countMetric(s.hardCorner) },
      ],
    },
    {
      key: 'phone',
      title: m.phone,
      cells: [
        { key: 'pickups', caption: m.pickups, metric: countMetric(s.pickups) },
        { key: 'phone-time', caption: m.phoneTime, metric: timeMetric(s.handlingS) },
        { key: 'clean', caption: m.cleanDrives, metric: percentMetric(s.cleanPct) },
        { key: 'points', caption: m.points, metric: pointsMetric(s.points) },
      ],
    },
  ];
}

/** Between the three cards. */
const BLOCK_GAP = tokens.space.md;

/**
 * The metrics block's height at a Dynamic Type multiple, from the same type, spacing and card
 * metrics the cards draw with: three cards of a title and two rows of number-over-caption cells.
 * The user's rule is that the block never takes more than three quarters of the window's height
 * on a phone (checked at 390 × 844 in the tests).
 */
export function metricsBlockHeight(fontScale = 1): number {
  const { type, space } = tokens;
  const line = (v: keyof typeof type) => type[v].lineHeight * Math.min(fontScale, type[v].maxScale ?? 2);
  const cell = line('stat') + METRIC_CELL_GAP + line('label');
  // Card: 16 pt padding top and bottom, 12 pt between its title and the two rows, and between rows.
  const card = space.lg * 2 + line('title3') + space.md + cell + space.md + cell;
  return card * 3 + BLOCK_GAP * 2;
}

/** Three compact cards ("Driving", "Events", "Phone & points"), each a 2 × 2 grid of numbers. */
export function MetricsCards({ sums }: { sums: WindowSums }) {
  const t = useTheme();
  const units = useUnits();
  return (
    <View style={{ gap: BLOCK_GAP }} testID="analytics-metrics">
      {metricGroups(sums, units).map((g) => (
        <Card key={g.key} testID={`metrics-${g.key}`}>
          <Text variant="title3" accessibilityRole="header">
            {g.title}
          </Text>
          {[g.cells.slice(0, 2), g.cells.slice(2, 4)].map((row, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: t.space.lg }}>
              {row.map((c) => (
                <MetricCell key={c.key} caption={c.caption} metric={c.metric} style={{ flex: 1 }} testID={`metric-${c.key}`} />
              ))}
            </View>
          ))}
        </Card>
      ))}
    </View>
  );
}
