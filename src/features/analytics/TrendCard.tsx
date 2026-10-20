import { useState } from 'react';
import { View, type TextStyle } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { distanceWord, per100In, type Units } from '@/lib/units';
import { Card, formatPointsValue, SegmentedControl, Text, tokens, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import type { Metric } from './format';
import type { MetricsLayout } from './MetricsCards';
import { trendDirection, trendRange, TREND_KINDS, type Trend, type TrendKind, type TrendPoint, type TrendStep, type TrendTick } from './model';
import { sizeAt } from './textSize';

const c = analyticsCopy.trend;
const SEGMENTS = TREND_KINDS.map((value) => ({ value, label: c[value] }));

/** The segmented control's track padding; each segment adds `space.sm` above and below its label. */
const PICKER_PAD = 3;
/** Between the plot and its tick labels. */
export const TICK_GAP = 4;
/** Room inside the plot's edges, so the end dots and the line's caps are never clipped. */
export const PLOT_EDGE = 6;
/** Between the Y axis's labels and the plot. */
export const AXIS_GAP = 6;

// ---------------------------------------------------------------------------------------------
// Heights (the metrics block's layout counts the card with these)

/** The series picker's height: its label line at the system text size, padded, never under the 44 pt touch floor. */
export const pickerHeight = (fontScale: number): number =>
  Math.max(tokens.size.touch, 2 * PICKER_PAD + 2 * tokens.space.sm + sizeAt('subhead', fontScale).lineHeight);

/** The title and the picker share one row. */
export const trendHeaderHeight = (l: Pick<MetricsLayout, 'textScale' | 'fontScale'>): number =>
  Math.max(sizeAt('title3', l.textScale).lineHeight, pickerHeight(l.fontScale));

/** The chart's box: the plot, then a line of tick labels. The short "not enough drives" line keeps the same box, so nothing jumps. */
export const chartBoxHeight = (l: Pick<MetricsLayout, 'plot' | 'textScale'>): number => l.plot + TICK_GAP + sizeAt('caption', l.textScale).lineHeight;

/** The whole card: padding, the header row and the chart, with the card's gap between them. */
export const trendCardHeight = (l: Pick<MetricsLayout, 'pad' | 'gap' | 'plot' | 'textScale' | 'fontScale'>): number =>
  l.pad * 2 + trendHeaderHeight(l) + l.gap + chartBoxHeight(l);

// ---------------------------------------------------------------------------------------------
// Geometry

export interface Pt {
  x: number;
  y: number;
}

/** A point's place in a plot `width` × `height` drawing `lo`–`hi`, inside the plot's edge room. */
export function plotPoint(p: Pick<TrendPoint, 'x' | 'value'>, width: number, height: number, lo: number, hi: number): Pt {
  const k = hi > lo ? (p.value - lo) / (hi - lo) : 0.5;
  return { x: PLOT_EDGE + p.x * (width - 2 * PLOT_EDGE), y: PLOT_EDGE + (1 - k) * (height - 2 * PLOT_EDGE) };
}

const n1 = (v: number): string => v.toFixed(1);

/**
 * An SVG path through the points as a monotone cubic (Fritsch–Carlson, as d3's monotone-x): it
 * never overshoots a point, so a peak on the line is a peak in the data. Points go left to right.
 */
export function monotonePath(pts: readonly Pt[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${n1(pts[0]!.x)},${n1(pts[0]!.y)}`;
  const h = pts.slice(1).map((p, i) => p.x - pts[i]!.x);
  const s = pts.slice(1).map((p, i) => (h[i]! > 0 ? (p.y - pts[i]!.y) / h[i]! : 0));
  const m = pts.map((_, i) => {
    if (i === 0) return s[0]!;
    if (i === pts.length - 1) return s[i - 1]!;
    const a = s[i - 1]!;
    const b = s[i]!;
    if (a * b <= 0) return 0;
    const p = (a * h[i]! + b * h[i - 1]!) / (h[i - 1]! + h[i]!);
    return Math.sign(a) * Math.min(Math.abs(a), Math.abs(b), 0.5 * Math.abs(p)) * 2;
  });
  let d = `M${n1(pts[0]!.x)},${n1(pts[0]!.y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const third = h[i]! / 3;
    d += ` C${n1(a.x + third)},${n1(a.y + m[i]! * third)} ${n1(b.x - third)},${n1(b.y - m[i + 1]! * third)} ${n1(b.x)},${n1(b.y)}`;
  }
  return d;
}

/**
 * The ticks that fit: every `k`th one, counted back from the latest, where `k` is the fewest steps
 * that leave a label's width between neighbours.
 */
export function visibleTicks(ticks: readonly TrendTick[], plotWidth: number, labelWidth: number): TrendTick[] {
  if (ticks.length < 2) return [...ticks];
  let gap = Infinity;
  for (let i = 1; i < ticks.length; i++) gap = Math.min(gap, (ticks[i]!.x - ticks[i - 1]!.x) * (plotWidth - 2 * PLOT_EDGE));
  const k = Math.max(1, Math.ceil(labelWidth / Math.max(1, gap)));
  return ticks.filter((_, i) => (ticks.length - 1 - i) % k === 0);
}

/** A tick label's width, roughly: the caption face runs about 0.6 em a character, plus a little air. */
const tickWidth = (ticks: readonly TrendTick[], fontSize: number): number => Math.max(1, ...ticks.map((t) => t.label.length)) * fontSize * 0.6 + 8;

// ---------------------------------------------------------------------------------------------
// Words

/** A series value as drawn ("88", "2.1" with "/100 mi", "+120" with "pts") and as spoken. */
export function trendValue(kind: TrendKind, v: number, units: Units): Metric {
  if (kind === 'score') return { value: String(Math.round(v)), unit: '', spoken: String(Math.round(v)) };
  if (kind === 'events') {
    const value = v >= 10 ? String(Math.round(v)) : v.toFixed(1);
    return { value, unit: `/100 ${units}`, spoken: value };
  }
  const r = Math.round(v);
  return { value: formatPointsValue(v, true), unit: 'pts', spoken: r > 0 ? `plus ${r}` : r < 0 ? `minus ${Math.abs(r)}` : '0' };
}

/** A Y axis label: the series' number alone ("100", "2.5", "+120"); the unit is on the latest value. */
export function axisValue(kind: TrendKind, v: number): string {
  if (kind === 'score') return String(Math.round(v));
  if (kind === 'events') return Math.abs(v) >= 10 ? String(Math.round(v)) : v.toFixed(1);
  return formatPointsValue(v, true);
}

/** The Y axis: the values at the three guides, top to bottom (the range's top, middle and bottom). */
export const axisTicks = (kind: TrendKind, lo: number, hi: number): string[] => [hi, (lo + hi) / 2, lo].map((v) => axisValue(kind, v));

/** The Y axis's width: its widest label (about 0.6 em a character) and the gap to the plot. */
export const axisWidth = (labels: readonly string[], fontSize: number): number =>
  Math.ceil(Math.max(1, ...labels.map((s) => s.length)) * fontSize * 0.6) + AXIS_GAP;

/** Events are counted per 100 mi; in km they read per 100 km. */
export const seriesIn = (kind: TrendKind, points: readonly TrendPoint[], units: Units): TrendPoint[] =>
  kind === 'events' ? points.map((p) => ({ ...p, value: Math.round(per100In(p.value, units) * 10) / 10 })) : [...points];

/** The chart for a screen reader: "Score by day. Lowest 71 on Tuesday, latest 88, trending up." */
export function trendLabel(kind: TrendKind, points: readonly TrendPoint[], step: TrendStep, units: Units): string {
  if (points.length < 2) return c.notEnough;
  const name = kind === 'events' ? c.spoken.events(distanceWord(units)) : c.spoken[kind];
  const low = points.reduce((a, b) => (b.value < a.value ? b : a));
  const last = points[points.length - 1]!;
  const { lo, hi } = trendRange(
    kind,
    points.map((p) => p.value)
  );
  const dir = c.direction[trendDirection(points, hi - lo)];
  return `${name} ${c.by[step]}. ${c.lowest} ${trendValue(kind, low.value, units).spoken} ${low.when}, ${c.latest} ${trendValue(kind, last.value, units).spoken}, ${dir}.`;
}

// ---------------------------------------------------------------------------------------------
// The card

export interface TrendCardProps {
  trend: Trend;
  units: Units;
  layout: MetricsLayout;
  /** The chart's width: the card's inside. */
  width: number;
  text: { title: TextStyle };
}

/**
 * The range over time: a Score / Events / Points picker beside the title, one monotone line in the
 * page ink with a dot per point (the latest labelled with its unit), thin guides at the bottom,
 * middle and top of the range with their values down a Y axis on the left, and a few short ticks
 * under it. Fewer than two points read "Not enough drives yet" in the chart's place.
 */
export function TrendCard({ trend, units, layout: l, width, text }: TrendCardProps) {
  const t = useTheme();
  const [kind, setKind] = useState<TrendKind>('score');
  const points = seriesIn(kind, trend.series[kind], units);
  const { lo, hi } = trendRange(
    kind,
    points.map((p) => p.value)
  );
  const box = chartBoxHeight(l);
  const tick = sizeAt('caption', l.textScale);
  const yLabels = axisTicks(kind, lo, hi);
  const axisW = axisWidth(yLabels, tick.fontSize);
  // The plot is what the Y axis leaves of the card's inside.
  const plotW = Math.max(1, width - axisW);
  const latest = sizeAt('subhead', l.textScale);
  const xy = points.map((p) => plotPoint(p, plotW, l.plot, lo, hi));
  const last = xy[xy.length - 1];
  const lastValue = points.length > 0 ? trendValue(kind, points[points.length - 1]!.value, units) : null;
  const ticks = visibleTicks(trend.ticks, plotW, tickWidth(trend.ticks, tick.fontSize));
  const tickW = tickWidth(ticks, tick.fontSize);
  const halo = { textShadowColor: t.colors.surface, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 6 };
  const guides = [PLOT_EDGE, l.plot / 2, l.plot - PLOT_EDGE];

  return (
    <Card padded={false} style={{ padding: l.pad, gap: l.gap }} testID="metrics-trend">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, minHeight: trendHeaderHeight(l) }} testID="metrics-trend-header">
        <Text variant="title3" accessibilityRole="header" style={text.title} testID="metrics-trend-title">
          {c.title}
        </Text>
        <SegmentedControl
          accessibilityLabel={c.picker}
          segments={SEGMENTS}
          value={kind}
          onChange={setKind}
          style={{ flex: 1, minHeight: pickerHeight(l.fontScale) }}
          testID="metrics-trend-picker"
        />
      </View>
      {points.length < 2 ? (
        <View style={{ height: box, justifyContent: 'center' }} testID="trend-chart-box">
          <Text variant="footnote" tone="muted" style={{ textAlign: 'center' }} testID="trend-empty">
            {c.notEnough}
          </Text>
        </View>
      ) : (
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={trendLabel(kind, points, trend.step, units)}
          style={{ height: box, width: axisW + plotW, flexDirection: 'row' }}
          testID="trend-chart-box"
        >
          <View style={{ width: axisW, height: l.plot }} testID="trend-y-axis">
            {yLabels.map((label, i) => (
              <Text
                key={i}
                variant="caption"
                tone="muted"
                numberOfLines={1}
                style={[
                  tick,
                  {
                    position: 'absolute',
                    right: AXIS_GAP,
                    top: Math.max(0, Math.min(l.plot - tick.lineHeight, guides[i]! - tick.lineHeight / 2)),
                    textAlign: 'right',
                    fontVariant: ['tabular-nums'],
                  },
                ]}
                testID="trend-y-label"
              >
                {label}
              </Text>
            ))}
          </View>
          <View style={{ width: plotW, height: box }}>
            <Svg width={plotW} height={l.plot} testID="trend-chart">
              {guides.map((y, i) => (
                <Line key={i} x1={0} x2={plotW} y1={y} y2={y} stroke={t.colors.divider} strokeWidth={i === 2 ? 1.5 : 1} />
              ))}
              <Path d={monotonePath(xy)} fill="none" stroke={t.colors.text} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" testID="trend-line" />
              {xy.map((p, i) => (
                <Circle key={i} cx={p.x} cy={p.y} r={i === xy.length - 1 ? 4 : 3} fill={t.colors.text} testID="trend-dot" />
              ))}
            </Svg>
            {last && lastValue ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: Math.max(0, Math.min(l.plot - latest.lineHeight, last.y < l.plot / 2 ? last.y + 8 : last.y - 8 - latest.lineHeight)),
                  ...(last.x > plotW / 2 ? { right: plotW - last.x } : { left: last.x }),
                  flexDirection: 'row',
                  alignItems: 'baseline',
                }}
              >
                <Text variant="subhead" style={[latest, { fontWeight: '700' }, halo]} testID="trend-latest">
                  {lastValue.value}
                  {lastValue.unit ? <Text variant="caption" tone="muted" style={[tick, halo]}>{` ${lastValue.unit}`}</Text> : null}
                </Text>
              </View>
            ) : null}
            {ticks.map((k) => {
              const x = PLOT_EDGE + k.x * (plotW - 2 * PLOT_EDGE);
              const left = Math.max(0, Math.min(plotW - tickW, x - tickW / 2));
              const align = left === 0 && x - tickW / 2 < 0 ? 'left' : left === plotW - tickW && x + tickW / 2 > plotW ? 'right' : 'center';
              return (
                <Text
                  key={`${k.x}-${k.label}`}
                  variant="caption"
                  tone="muted"
                  numberOfLines={1}
                  style={[tick, { position: 'absolute', top: l.plot + TICK_GAP, left, width: tickW, textAlign: align }]}
                  testID="trend-tick"
                >
                  {k.label}
                </Text>
              );
            })}
          </View>
        </View>
      )}
    </Card>
  );
}
