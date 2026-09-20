import type { ScoreBand } from '@scoring';
import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { fontFamilies } from '../fonts';
import { Text } from '../primitives/Text';
import { useTheme } from '../theme';
import { ChartFrame, type ChartToggleLabels } from './ChartFrame';
import {
  bandLabel,
  bandOfScore,
  describeTrend,
  formatScore,
  WEEKS,
  type TrendPeriod,
  type TrendPoint,
} from './format';
import { useFontScale } from './scale';
import { layoutTrend, TREND } from './trendLayout';

export type TrendLineProps = {
  points: readonly TrendPoint[];
  /** Wash the four score bands behind the line. On by default. */
  bandShading?: boolean;
  summaryText?: string;
  /** What one point is, for the label and the table: weeks unless told otherwise. */
  period?: TrendPeriod;
  /**
   * Height at the default text size. The axis gutters grow with the text and the drawing grows
   * with them, so the plot itself never shrinks.
   */
  height?: number;
  /** Fixed drawing width; measured from the container when omitted. */
  width?: number;
  toggleLabels?: ChartToggleLabels;
  testID?: string;
};

/** Ink washes, one step per band, so "higher" reads as "more printed" without a legend. */
const WASH: Record<ScoreBand, number> = {
  excellent: 0.12,
  good: 0.08,
  getting_there: 0.04,
  needs_focus: 0,
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The long-term score by period: a 2 dp line of ID blue with ringed markers, the band floors as
 * hairlines with their numerals in the gutter, and the four bands washed behind the line. Only
 * the two ends carry a value, and the last one names its band — the rest is the table's job. A
 * period with no score breaks the line rather than being bridged. Drawn for a card face: the
 * markers' halo is the surface colour.
 */
export function TrendLine({
  points,
  bandShading = true,
  summaryText,
  period = WEEKS,
  height = 160,
  width: fixedWidth,
  toggleLabels,
  testID,
}: TrendLineProps) {
  const t = useTheme();
  const fs = useFontScale();
  const [measured, setMeasured] = useState(0);
  const width = fixedWidth ?? measured;
  const id = (suffix: string) => (testID ? `${testID}-${suffix}` : undefined);
  const n = points.length;
  const l = layoutTrend(points, { width, height, fontScale: fs });

  const name = (p: TrendPoint) => p.longLabel ?? p.label;
  const table = {
    caption: `Score by ${period.one}`,
    columns: [{ title: capitalise(period.one) }, { title: 'Score', numeric: true }, { title: 'Band' }],
    rows: points.map((p, i) =>
      p.value === null
        ? { key: String(i), cells: [name(p), '—', 'Not scored'], label: `${name(p)}, not scored` }
        : {
            key: String(i),
            cells: [name(p), formatScore(p.value), bandLabel(bandOfScore(p.value))],
            label: `${name(p)}, ${formatScore(p.value)}, ${bandLabel(bandOfScore(p.value))}`,
          }
    ),
    emptyText: 'No scores yet',
  };

  const onLayout = (e: LayoutChangeEvent) => setMeasured(e.nativeEvent.layout.width);

  return (
    <ChartFrame
      label={describeTrend(points, period)}
      summaryText={summaryText}
      table={table}
      toggleLabels={toggleLabels}
      testID={testID}
    >
      <View
        onLayout={fixedWidth === undefined ? onLayout : undefined}
        style={{ height: l.height, width: fixedWidth }}
      >
        {width > 0 && n > 0 ? (
          <>
            <Svg width={l.width} height={l.height}>
              {bandShading
                ? l.washes.map((wash) => (
                    <Rect
                      key={wash.band}
                      testID={id(`band-${wash.band}`)}
                      x={l.gutterL}
                      y={wash.y}
                      width={l.plotW}
                      height={wash.height}
                      fill={t.colors.text}
                      fillOpacity={WASH[wash.band]}
                    />
                  ))
                : null}
              {l.ticks.map((tick) => (
                <Line
                  key={tick.value}
                  x1={l.gutterL}
                  x2={l.gutterL + l.plotW}
                  y1={tick.y}
                  y2={tick.y}
                  stroke={t.colors.divider}
                  strokeWidth={1}
                />
              ))}
              {l.path ? (
                <Path
                  testID={id('line')}
                  d={l.path}
                  stroke={t.colors.accent}
                  strokeWidth={2}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : null}
              {points.map((p, i) =>
                p.value === null ? null : (
                  <Circle
                    key={i}
                    testID={id(`marker-${i}`)}
                    cx={l.x(i)}
                    cy={l.y(p.value)}
                    r={i === l.lastIdx ? TREND.lastMarkerRadius : TREND.markerRadius}
                    fill={t.colors.accent}
                    stroke={t.colors.surface}
                    strokeWidth={2}
                  />
                )
              )}
            </Svg>
            {l.ticks.map((tick) => (
              <Text
                key={`tick-${tick.value}`}
                variant="caption"
                tone="subtle"
                style={{
                  position: 'absolute',
                  left: tick.box.left,
                  width: tick.box.right - tick.box.left,
                  top: tick.box.top,
                  lineHeight: l.line,
                  textAlign: 'right',
                  fontFamily: fontFamilies.numerals,
                }}
              >
                {tick.value}
              </Text>
            ))}
            {l.ends.map((end) => (
              <View
                key={`end-${end.index}`}
                pointerEvents="none"
                style={[
                  {
                    position: 'absolute',
                    top: end.top,
                    maxWidth: l.plotW * 0.6,
                    alignItems: end.atRight ? 'flex-end' : 'flex-start',
                  },
                  end.anchor,
                ]}
              >
                <Text
                  variant="caption"
                  style={{
                    fontFamily: fontFamilies.numerals,
                    lineHeight: l.line,
                    textAlign: end.atRight ? 'right' : 'left',
                  }}
                >
                  {formatScore(end.value)}
                </Text>
                {end.band ? (
                  <Text
                    variant="caption"
                    tone="subtle"
                    style={{ lineHeight: l.line, textAlign: end.atRight ? 'right' : 'left' }}
                  >
                    {end.band}
                  </Text>
                ) : null}
              </View>
            ))}
            {l.xLabels.map((xl) => {
              const p = points[xl.index];
              if (!p) return null;
              return (
                <Text
                  key={`x-${xl.index}`}
                  variant="caption"
                  tone="subtle"
                  numberOfLines={1}
                  style={[
                    {
                      position: 'absolute',
                      top: l.xLabelTop,
                      width: xl.width,
                      lineHeight: l.line,
                      textAlign: xl.align,
                    },
                    xl.anchor,
                  ]}
                >
                  {p.label}
                </Text>
              );
            })}
          </>
        ) : null}
      </View>
    </ChartFrame>
  );
}
