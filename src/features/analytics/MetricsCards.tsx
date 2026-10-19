import { useWindowDimensions, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';
import { Card, Text, tokens, useFontScale } from '@/ui';

import { analyticsCopy } from './copy';
import { countMetric, distanceMetric, percentMetric, pointsMetric, speedMetric, timeMetric, type Metric } from './format';
import { METRIC_CELL_GAP, MetricCell } from './MetricCell';
import type { Trend, WindowSums } from './model';
import { sizeAt } from './textSize';
import { TrendCard, trendCardHeight } from './TrendCard';

const m = analyticsCopy.metrics;

interface MetricGroup {
  key: 'driving' | 'events' | 'phone';
  title: string;
  /** Four cells, read as two rows of two (or one row of four in the densest layout). */
  cells: { key: string; caption: string; metric: Metric }[];
}

/**
 * The range's twelve numbers in three groups of four: totals, event counts and two per-drive
 * averages. The event counts sit under the trend chart (or make up the middle card alone).
 */
export function metricGroups(s: WindowSums, units: Units): MetricGroup[] {
  return [
    {
      key: 'driving',
      title: m.driving,
      cells: [
        { key: 'drives', caption: m.drives, metric: countMetric(s.drives) },
        { key: 'distance', caption: m.distance, metric: distanceMetric(s.miles, units) },
        { key: 'avg-drive', caption: m.avgDrive, metric: distanceMetric(s.avgMiles, units) },
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
        { key: 'avg-points', caption: m.avgPoints, metric: pointsMetric(s.avgPoints) },
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
  /** The system's multiple (capped at 2×): the trend picker's labels follow it, not `textScale`. */
  fontScale: number;
  /** The trend chart's plot height; 0 when there is no room for it and the middle card is the four event counts alone. */
  plot: number;
}

const { space, type } = tokens;

/** A layout before the text size is known, with the plot heights it allows: the most it grows to, and the least worth drawing. */
type Base = Omit<MetricsLayout, 'textScale' | 'fontScale' | 'plot'> & { plotMax: number; plotMin: number };

/** The standard cards: stat-size numbers, 16 pt padding. */
const GRID: Base = {
  name: 'grid',
  perRow: 2,
  pad: space.lg,
  gap: space.md,
  colGap: space.lg,
  blockGap: space.md,
  stat: { fontSize: type.stat.fontSize, lineHeight: type.stat.lineHeight },
  plotMax: 120,
  plotMin: 72,
};
/** Shorter windows: title2-size numbers, 12 pt padding. */
const COMPACT: Base = {
  name: 'compact',
  perRow: 2,
  pad: space.md,
  gap: space.sm,
  colGap: space.md,
  blockGap: space.sm,
  stat: { fontSize: type.title2.fontSize, lineHeight: type.title2.lineHeight },
  plotMax: 96,
  plotMin: 56,
};
/** The shortest windows and the largest text: each card is one row of four. */
const ROW: Base = { ...COMPACT, name: 'row', perRow: 4, colGap: space.sm, plotMax: 80, plotMin: 40 };

/**
 * How many lines a caption may take in a layout: two in the narrow cells of a row of four (they
 * wrap rather than shrink), one in the wider 2 × 2 cells.
 */
export const captionLines = (l: Pick<MetricsLayout, 'perRow'>): 1 | 2 => (l.perRow === 4 ? 2 : 1);

/** A number card's height: a title and one or two rows of number-over-caption cells. */
function numberCardHeight(l: MetricsLayout): number {
  const cell =
    sizeAt('stat', l.textScale, l.stat).lineHeight + METRIC_CELL_GAP + captionLines(l) * sizeAt('label', l.textScale).lineHeight;
  const rows = 4 / l.perRow;
  // The card's gap sits between its title and each row.
  return l.pad * 2 + sizeAt('title3', l.textScale).lineHeight + rows * (l.gap + cell);
}

/** The block's height in a layout: the Driving and Phone & points cards, the trend card (or the event counts alone), and the gaps. */
export function metricsBlockHeight(l: MetricsLayout): number {
  const number = numberCardHeight(l);
  return number * 2 + (l.plot > 0 ? trendCardHeight(l) : number) + l.blockGap * 2;
}

/**
 * The densest layout the block needs to stay within three quarters of the window's height at the
 * reader's text size: the standard 2 × 2 cards, then tighter 2 × 2 cards, then one row of four.
 * In each, the trend chart takes the room that is left, up to the layout's most, and the layout
 * fits only if that is at least its least.
 *
 * The reader's text size comes before the chart: when no layout has room for it (the shortest
 * phones, the largest text), the middle card drops the chart and keeps the event counts, and the
 * three number cards go through the same steps. When even their row is too tall, the block's text
 * stops growing at the largest size that fits (never below 1×).
 */
export function metricsLayout(windowHeight: number, fontScale: number): MetricsLayout {
  const limit = windowHeight * METRICS_MAX_SHARE;
  for (const base of [GRID, COMPACT, ROW]) {
    const l = { ...base, textScale: fontScale, fontScale, plot: base.plotMin };
    // The block grows one for one with the plot, so whatever is left under the limit is the plot's.
    const room = Math.floor(base.plotMin + limit - metricsBlockHeight(l));
    if (room >= base.plotMin) return { ...l, plot: Math.min(base.plotMax, room) };
  }
  for (const base of [GRID, COMPACT, ROW]) {
    const l = { ...base, textScale: fontScale, fontScale, plot: 0 };
    if (metricsBlockHeight(l) <= limit) return l;
  }
  for (let s = Math.floor(fontScale * 20) / 20; s > 1; s = Math.round((s - 0.05) * 100) / 100) {
    const l = { ...ROW, textScale: s, fontScale, plot: 0 };
    if (metricsBlockHeight(l) <= limit) return l;
  }
  return { ...ROW, textScale: Math.min(fontScale, 1), fontScale, plot: 0 };
}

/**
 * Three compact cards: Driving and Phone & points, each a 2 × 2 grid of numbers, and between them
 * the range's trend over its event counts (the counts alone when the window has no room for it).
 */
export function MetricsCards({ sums, trend }: { sums: WindowSums; trend: Trend }) {
  const units = useUnits();
  const { width, height } = useWindowDimensions();
  const l = metricsLayout(height, useFontScale());
  const text = {
    title: sizeAt('title3', l.textScale),
    stat: sizeAt('stat', l.textScale, l.stat),
    unit: sizeAt('footnote', l.textScale),
    label: sizeAt('label', l.textScale),
  };
  return (
    <View style={{ gap: l.blockGap }} testID="analytics-metrics">
      {metricGroups(sums, units).map((g) =>
        g.key === 'events' && l.plot > 0 ? (
          // The chart spans the card's inside: the window less the screen gutter and the card's padding, each side.
          <TrendCard key={g.key} trend={trend} counts={g.cells} units={units} layout={l} width={width - 2 * space.lg - 2 * l.pad} text={text} />
        ) : (
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
        )
      )}
    </View>
  );
}
