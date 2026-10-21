import { useWindowDimensions, View, type TextStyle } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';
import { Card, Text, tokens, useFontScale, type CardVariant } from '@/ui';

import { analyticsCopy } from './copy';
import { countMetric, distanceMetric, percentMetric, pointsMetric, speedMetric, timeMetric, type Metric } from './format';
import { METRIC_CELL_GAP, MetricCell } from './MetricCell';
import type { Trend, WindowSums } from './model';
import { sizeAt } from './textSize';
import { TrendCard, trendCardHeight } from './TrendCard';

const m = analyticsCopy.metrics;

export interface MetricGroup {
  key: string;
  title: string;
  /**
   * Up to five cells, read as rows of two (or rows of four in the densest layout), a short last
   * row keeping the grid's columns. `spokenCaption` is the caption in words for a screen reader.
   */
  cells: { key: string; caption: string; spokenCaption?: string; metric: Metric }[];
}

/**
 * The range's general numbers: Driving (drives, the time spent driving, distance and two averages)
 * and Points (the total, per drive, and the clean drives that keep the streak, with their rate).
 * Each radar category's own numbers live in its sheet.
 */
export function metricGroups(s: WindowSums, units: Units): MetricGroup[] {
  return [
    {
      key: 'driving',
      title: m.driving,
      cells: [
        { key: 'drives', caption: m.drives, metric: countMetric(s.drives) },
        { key: 'drive-time', caption: m.driveTime, metric: timeMetric(s.durationS) },
        { key: 'distance', caption: m.distance, metric: distanceMetric(s.miles, units) },
        { key: 'avg-drive', caption: m.avgDrive, metric: distanceMetric(s.avgMiles, units) },
        { key: 'speed', caption: m.avgSpeed, metric: speedMetric(s.avgMph, units) },
      ],
    },
    {
      key: 'points',
      title: m.points,
      cells: [
        { key: 'points', caption: m.totalPoints, metric: pointsMetric(s.drives > 0 ? s.points : null) },
        { key: 'avg-points', caption: m.avgPoints, spokenCaption: m.avgPointsSpoken, metric: pointsMetric(s.avgPoints) },
        { key: 'clean', caption: m.cleanDrives, metric: countMetric(s.cleanDrives) },
        { key: 'clean-rate', caption: m.cleanRate, metric: percentMetric(s.cleanPct) },
      ],
    },
  ];
}

/** The main block's number cards by their cell counts: Driving and Points. */
export const MAIN_CARDS: readonly number[] = [5, 4];

/** The user's rule: the metrics block never takes more than this share of the window's height. */
export const METRICS_MAX_SHARE = 0.75;

/** How the cards are drawn. The block picks the first that fits; see {@link metricsLayout}. */
export interface MetricsLayout {
  name: 'grid' | 'compact' | 'row';
  /** Cells per row: 2 (two rows of two) or 4 (one row of four). */
  perRow: 2 | 4;
  /** Card padding, and the gap between a card's title and its rows (and between rows). */
  pad: number;
  gap: number;
  /** Between cells in a row. */
  colGap: number;
  /** Between the cards. */
  blockGap: number;
  /** The number's size at 1× (the display face either way). */
  stat: { fontSize: number; lineHeight: number };
  /** The Dynamic Type multiple the block's text is drawn at (each style still stops at its own cap). */
  textScale: number;
  /** The system's multiple (capped at 2×): the trend picker's labels follow it, not `textScale`. */
  fontScale: number;
  /** The trend chart's plot height; 0 when there is no room for it (or no chart) and the Trends card is left out. */
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

/** A number card's height: a title and its rows of number-over-caption cells. */
function numberCardHeight(l: MetricsLayout, cells: number): number {
  const cell =
    sizeAt('stat', l.textScale, l.stat).lineHeight + METRIC_CELL_GAP + captionLines(l) * sizeAt('label', l.textScale).lineHeight;
  const rows = Math.ceil(cells / l.perRow);
  // The card's gap sits between its title and each row.
  return l.pad * 2 + sizeAt('title3', l.textScale).lineHeight + rows * (l.gap + cell);
}

/** The block's height in a layout: its number cards (by cell count), the trend card when it has a plot, and the gaps. */
export function metricsBlockHeight(l: MetricsLayout, cards: readonly number[] = MAIN_CARDS): number {
  const parts = cards.map((n) => numberCardHeight(l, n));
  if (l.plot > 0) parts.push(trendCardHeight(l));
  return parts.reduce((a, b) => a + b, 0) + l.blockGap * (parts.length - 1);
}

/**
 * The densest layout a block of number cards (and, with `chart`, the trend card) needs to stay
 * within three quarters of the window's height at the reader's text size: the standard 2 × 2
 * cards, then tighter 2 × 2 cards, then one row of four. In each, the trend chart takes the room
 * that is left, up to the layout's most, and the layout fits only if that is at least its least.
 *
 * The reader's text size comes before the chart: when no layout has room for it (the shortest
 * phones, the largest text), the Trends card is left out and the number cards go through the same
 * steps. When even their row is too tall, the block's text stops growing at the largest size that
 * fits (never below 1×). A category sheet's numbers use the same rule with no chart.
 */
export function metricsLayout(windowHeight: number, fontScale: number, cards: readonly number[] = MAIN_CARDS, chart = true): MetricsLayout {
  const limit = windowHeight * METRICS_MAX_SHARE;
  if (chart) {
    for (const base of [GRID, COMPACT, ROW]) {
      const l = { ...base, textScale: fontScale, fontScale, plot: base.plotMin };
      // The block grows one for one with the plot, so whatever is left under the limit is the plot's.
      const room = Math.floor(base.plotMin + limit - metricsBlockHeight(l, cards));
      if (room >= base.plotMin) return { ...l, plot: Math.min(base.plotMax, room) };
    }
  }
  for (const base of [GRID, COMPACT, ROW]) {
    const l = { ...base, textScale: fontScale, fontScale, plot: 0 };
    if (metricsBlockHeight(l, cards) <= limit) return l;
  }
  for (let s = Math.floor(fontScale * 20) / 20; s > 1; s = Math.round((s - 0.05) * 100) / 100) {
    const l = { ...ROW, textScale: s, fontScale, plot: 0 };
    if (metricsBlockHeight(l, cards) <= limit) return l;
  }
  return { ...ROW, textScale: Math.min(fontScale, 1), fontScale, plot: 0 };
}

export interface MetricsText {
  title: TextStyle;
  stat: TextStyle;
  unit: TextStyle;
  label: TextStyle;
}

/** The block's text sizes in a layout. */
export const metricsText = (l: MetricsLayout): MetricsText => ({
  title: sizeAt('title3', l.textScale),
  stat: sizeAt('stat', l.textScale, l.stat),
  unit: sizeAt('footnote', l.textScale),
  label: sizeAt('label', l.textScale),
});

/** One number card: a title over rows of two cells (or of four); a short last row is padded with empty columns, so its cells keep the grid's width. */
export function NumberCard({ group: g, layout: l, text, variant }: { group: MetricGroup; layout: MetricsLayout; text: MetricsText; variant?: CardVariant }) {
  const rows: MetricGroup['cells'][] = [];
  for (let i = 0; i < g.cells.length; i += l.perRow) rows.push(g.cells.slice(i, i + l.perRow));
  return (
    <Card variant={variant} padded={false} style={{ padding: l.pad, gap: l.gap }} testID={`metrics-${g.key}`}>
      <Text variant="title3" accessibilityRole="header" style={text.title} testID={`metrics-${g.key}-title`}>
        {g.title}
      </Text>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: l.colGap }} testID={`metrics-${g.key}-row-${i}`}>
          {row.map((c) => (
            <MetricCell
              key={c.key}
              caption={c.caption}
              spokenCaption={c.spokenCaption}
              metric={c.metric}
              text={text}
              captionLines={captionLines(l)}
              style={{ flex: 1 }}
              testID={`metric-${c.key}`}
            />
          ))}
          {Array.from({ length: l.perRow - row.length }, (_, k) => (
            <View key={`spacer-${k}`} style={{ flex: 1 }} />
          ))}
        </View>
      ))}
    </Card>
  );
}

/**
 * The range's general cards: Driving and Points, each a grid of numbers, and between them the
 * range's trend (left out when the window has no room for its chart).
 */
export function MetricsCards({ sums, trend }: { sums: WindowSums; trend: Trend }) {
  const units = useUnits();
  const { width, height } = useWindowDimensions();
  const l = metricsLayout(height, useFontScale());
  const text = metricsText(l);
  const [driving, points] = metricGroups(sums, units);
  return (
    <View style={{ gap: l.blockGap }} testID="analytics-metrics">
      <NumberCard group={driving!} layout={l} text={text} />
      {l.plot > 0 ? (
        // The chart spans the card's inside: the window less the screen gutter and the card's padding, each side.
        <TrendCard trend={trend} layout={l} width={width - 2 * space.lg - 2 * l.pad} text={text} />
      ) : null}
      <NumberCard group={points!} layout={l} text={text} />
    </View>
  );
}
