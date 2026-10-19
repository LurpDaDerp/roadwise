import { useWindowDimensions, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';
import { Card, Text, tokens, useFontScale } from '@/ui';

import { analyticsCopy } from './copy';
import { countMetric, distanceMetric, percentMetric, pointsMetric, speedMetric, timeMetric, type Metric } from './format';
import { METRIC_CELL_GAP, MetricCell } from './MetricCell';
import type { WindowSums } from './model';
import { sizeAt } from './textSize';

const m = analyticsCopy.metrics;

interface MetricGroup {
  key: 'driving' | 'events' | 'phone';
  title: string;
  /** Four cells, read as two rows of two (or one row of four in the densest layout). */
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

/** The user's rule: the metrics block never takes more than this share of the window's height. */
export const METRICS_MAX_SHARE = 0.75;

/** How the three cards are drawn. The block picks the first that fits; see {@link metricsLayout}. */
export interface MetricsLayout {
  name: 'grid' | 'compact' | 'row';
  /** Cells per row: 2 (two rows of two) or 4 (one row of four). */
  perRow: 2 | 4;
  /** Card padding, and the gap between a card's title and its rows (and between rows). */
  pad: number;
  gap: number;
  /** Between cells in a row. */
  colGap: number;
  /** Between the three cards. */
  blockGap: number;
  /** The number's size at 1× (the display face either way). */
  stat: { fontSize: number; lineHeight: number };
  /** The Dynamic Type multiple the block's text is drawn at (each style still stops at its own cap). */
  textScale: number;
}

const { space, type } = tokens;

/** The standard cards: stat-size numbers, 16 pt padding. */
const GRID: Omit<MetricsLayout, 'textScale'> = {
  name: 'grid',
  perRow: 2,
  pad: space.lg,
  gap: space.md,
  colGap: space.lg,
  blockGap: space.md,
  stat: { fontSize: type.stat.fontSize, lineHeight: type.stat.lineHeight },
};
/** Shorter windows: title2-size numbers, 12 pt padding. */
const COMPACT: Omit<MetricsLayout, 'textScale'> = {
  name: 'compact',
  perRow: 2,
  pad: space.md,
  gap: space.sm,
  colGap: space.md,
  blockGap: space.sm,
  stat: { fontSize: type.title2.fontSize, lineHeight: type.title2.lineHeight },
};
/** The shortest windows and the largest text: each card is one row of four. */
const ROW: Omit<MetricsLayout, 'textScale'> = { ...COMPACT, name: 'row', perRow: 4, colGap: space.sm };

/**
 * How many lines a caption may take in a layout: two in the narrow cells of a row of four (they
 * wrap rather than shrink), one in the wider 2 × 2 cells.
 */
export const captionLines = (l: Pick<MetricsLayout, 'perRow'>): 1 | 2 => (l.perRow === 4 ? 2 : 1);

/** The block's height in a layout: three cards of a title and one or two rows of number-over-caption cells. */
export function metricsBlockHeight(l: MetricsLayout): number {
  const cell =
    sizeAt('stat', l.textScale, l.stat).lineHeight + METRIC_CELL_GAP + captionLines(l) * sizeAt('label', l.textScale).lineHeight;
  const rows = 4 / l.perRow;
  // The card's gap sits between its title and each row.
  const card = l.pad * 2 + sizeAt('title3', l.textScale).lineHeight + rows * (l.gap + cell);
  return card * 3 + l.blockGap * 2;
}

/**
 * The densest layout the block needs to stay within three quarters of the window's height at the
 * reader's text size: the standard 2 × 2 cards, then tighter 2 × 2 cards, then one row of four.
 * When even the row is too tall (very large text on a short phone), the block's text stops growing
 * at the largest size that fits (never below 1×).
 */
export function metricsLayout(windowHeight: number, fontScale: number): MetricsLayout {
  const limit = windowHeight * METRICS_MAX_SHARE;
  for (const base of [GRID, COMPACT, ROW]) {
    const l = { ...base, textScale: fontScale };
    if (metricsBlockHeight(l) <= limit) return l;
  }
  for (let s = Math.floor(fontScale * 20) / 20; s > 1; s = Math.round((s - 0.05) * 100) / 100) {
    const l = { ...ROW, textScale: s };
    if (metricsBlockHeight(l) <= limit) return l;
  }
  return { ...ROW, textScale: Math.min(fontScale, 1) };
}

/** Three compact cards ("Driving", "Events", "Phone & points"), each a 2 × 2 grid of numbers. */
export function MetricsCards({ sums }: { sums: WindowSums }) {
  const units = useUnits();
  const { height } = useWindowDimensions();
  const l = metricsLayout(height, useFontScale());
  const text = {
    title: sizeAt('title3', l.textScale),
    stat: sizeAt('stat', l.textScale, l.stat),
    unit: sizeAt('footnote', l.textScale),
    label: sizeAt('label', l.textScale),
  };
  return (
    <View style={{ gap: l.blockGap }} testID="analytics-metrics">
      {metricGroups(sums, units).map((g) => (
        <Card key={g.key} padded={false} style={{ padding: l.pad, gap: l.gap }} testID={`metrics-${g.key}`}>
          <Text variant="title3" accessibilityRole="header" style={text.title} testID={`metrics-${g.key}-title`}>
            {g.title}
          </Text>
          {(l.perRow === 4 ? [g.cells] : [g.cells.slice(0, 2), g.cells.slice(2, 4)]).map((row, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: l.colGap }} testID={`metrics-${g.key}-row-${i}`}>
              {row.map((c) => (
                <MetricCell
                  key={c.key}
                  caption={c.caption}
                  metric={c.metric}
                  text={text}
                  captionLines={captionLines(l)}
                  style={{ flex: 1 }}
                  testID={`metric-${c.key}`}
                />
              ))}
            </View>
          ))}
        </Card>
      ))}
    </View>
  );
}
