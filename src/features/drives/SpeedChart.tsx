import { useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { sizeAt } from '@/features/analytics/textSize';
import type { Units } from '@/lib/units';
import { Card, Text, useFontScale, useTheme } from '@/ui';

import { recapCopy } from './copy';
import { formatClock, TIER_SIGNAL } from './format';
import type { LocalDrive, LocalDriveEvent } from './model';
import {
  axisLabels,
  chartSpanS,
  chartTop,
  limitPath,
  linePath,
  showsSpeedChart,
  SPEED_PLOT_EDGE,
  speedChartLabel,
  speedingBands,
  speedRuns,
  type ChartScale,
} from './speedChartModel';

const c = recapCopy.speed;

/** The plot's height (pt). */
export const SPEED_PLOT_H = 140;
/** Between the Y axis's labels and the plot. */
const AXIS_GAP = 6;
/** Between the plot and the clock times under it. */
const TICK_GAP = 4;
/** The limit's dashes: 4 pt on, 3 off. */
const LIMIT_DASH = '4 3';
/** How strongly a speeding band tints the plot behind the lines. */
const BAND_OPACITY = 0.28;

/** A small sample of a line for the legend: solid for the speed, dashed for the limit. */
function Swatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <Svg width={16} height={8}>
      <Line x1={1} x2={15} y1={4} y2={4} stroke={color} strokeWidth={2} strokeLinecap="round" {...(dashed ? { strokeDasharray: LIMIT_DASH } : {})} />
    </Svg>
  );
}

/**
 * The recap's speed chart, its own card under the score card: the drive's speed over time as a
 * solid line in the page ink (broken where no trusted speed was read), the posted limit as a
 * dashed step line in the muted ink, and each speeding episode as a band in its tier's colour
 * behind them. Y from 0 to the fastest value rounded up to the next 10 (mph, or km/h), with three
 * labels; the drive's start and end clock times under it. One element for a screen reader, which
 * hears how often and how long the drive was over the limit. Nothing shows without at least two
 * points with a speed (a drive recorded before the trace, a restored one, a drive with no fix).
 */
export function SpeedChart({ drive, events, units }: { drive: LocalDrive; events: readonly LocalDriveEvent[]; units: Units }) {
  const t = useTheme();
  const window = useWindowDimensions();
  const fontScale = useFontScale();
  // The card's inside, until it is laid out: the screen less the page's and the card's padding.
  const [measured, setMeasured] = useState<number | null>(null);
  const trace = drive.speedTrace;
  if (!showsSpeedChart(trace)) return null;

  const width = Math.max(1, measured ?? window.width - 4 * t.space.lg);
  const tick = sizeAt('caption', fontScale);
  const top = chartTop(trace, units);
  const yLabels = axisLabels(top, units);
  const axisW = Math.ceil(Math.max(...yLabels.map((s) => s.length)) * tick.fontSize * 0.6) + AXIS_GAP;
  const plotW = Math.max(1, width - axisW);
  const sc: ChartScale = { spanS: chartSpanS(drive, trace), top, width: plotW, height: SPEED_PLOT_H, units };
  const runs = speedRuns(trace, sc);
  const limit = limitPath(trace, sc);
  const bands = speedingBands(drive, events, sc);
  const guides = [1, 0.5, 0].map((k) => SPEED_PLOT_EDGE + (1 - k) * (SPEED_PLOT_H - 2 * SPEED_PLOT_EDGE));
  const end = drive.endedAt ?? drive.startedAt + drive.durationS * 1000;

  return (
    <Card testID="speed-chart-card">
      <View style={{ gap: 2 }}>
        <Text variant="headline" accessibilityRole="header" testID="speed-chart-title">
          {c.title}
        </Text>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs, flexWrap: 'wrap' }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="speed-chart-legend"
        >
          <Swatch color={t.colors.text} />
          <Text variant="footnote" tone="muted">
            {c.yourSpeed}
          </Text>
          <Text variant="footnote" tone="muted">
            ·
          </Text>
          <Swatch color={t.colors.textMuted} dashed />
          <Text variant="footnote" tone="muted">
            {c.limit}
          </Text>
        </View>
      </View>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={speedChartLabel(events)}
        onLayout={(e) => {
          const w = Math.round(e.nativeEvent.layout.width);
          if (w > 0 && w !== measured) setMeasured(w);
        }}
        testID="speed-chart"
      >
        <View style={{ flexDirection: 'row' }}>
          <View style={{ width: axisW, height: SPEED_PLOT_H }} testID="speed-chart-y-axis">
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
                    top: Math.max(0, Math.min(SPEED_PLOT_H - tick.lineHeight, guides[i]! - tick.lineHeight / 2)),
                    textAlign: 'right',
                    fontVariant: ['tabular-nums'],
                  },
                ]}
                testID="speed-chart-y-label"
              >
                {label}
              </Text>
            ))}
          </View>
          <Svg width={plotW} height={SPEED_PLOT_H} testID="speed-chart-plot">
            {bands.map((b) => (
              <Rect
                key={b.id}
                x={b.x}
                y={0}
                width={b.width}
                height={SPEED_PLOT_H}
                fill={t.colors.signal[TIER_SIGNAL[b.tier]].fill}
                fillOpacity={BAND_OPACITY}
                testID="speed-chart-band"
              />
            ))}
            {guides.map((y, i) => (
              <Line key={i} x1={0} x2={plotW} y1={y} y2={y} stroke={t.colors.divider} strokeWidth={i === 2 ? 1.5 : 1} />
            ))}
            {limit !== '' ? (
              <Path d={limit} fill="none" stroke={t.colors.textMuted} strokeWidth={1.5} strokeDasharray={LIMIT_DASH} testID="speed-chart-limit" />
            ) : null}
            {runs.map((run, i) =>
              run.length === 1 ? (
                <Circle key={i} cx={run[0]!.x} cy={run[0]!.y} r={1.5} fill={t.colors.text} testID="speed-chart-speed" />
              ) : (
                <Path key={i} d={linePath(run)} fill="none" stroke={t.colors.text} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" testID="speed-chart-speed" />
              )
            )}
          </Svg>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginLeft: axisW, paddingTop: TICK_GAP }}>
          <Text variant="caption" tone="muted" style={tick} testID="speed-chart-start">
            {formatClock(drive.startedAt)}
          </Text>
          <Text variant="caption" tone="muted" style={tick} testID="speed-chart-end">
            {formatClock(end)}
          </Text>
        </View>
      </View>
    </Card>
  );
}
