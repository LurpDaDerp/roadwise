import type { ScoreBand } from '@scoring';
import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { fontFamilies } from '../fonts';
import { Text } from '../primitives/Text';
import { useTheme } from '../theme';
import { ChartFrame, type ChartToggleLabels } from './ChartFrame';
import {
  BAND_FLOORS,
  bandLabel,
  bandOfScore,
  clamp,
  describeTrend,
  formatScore,
  WEEKS,
  type TrendPeriod,
  type TrendPoint,
} from './format';
import { useFontScale } from './scale';

export type TrendLineProps = {
  points: readonly TrendPoint[];
  /** Wash the four score bands behind the line. On by default. */
  bandShading?: boolean;
  summaryText?: string;
  /** What one point is, for the label and the table: weeks unless told otherwise. */
  period?: TrendPeriod;
  height?: number;
  /** Fixed drawing width; measured from the container when omitted. */
  width?: number;
  toggleLabels?: ChartToggleLabels;
  testID?: string;
};

// Geometry before Dynamic Type, in dp.
const GUTTER_LEFT = 32;
const GUTTER_BOTTOM = 22;
const PAD_TOP = 12;
const PAD_RIGHT = 12;
const LINE = 16;
const X_LABEL_W = 56;

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
 * period with no score breaks the line rather than being bridged.
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

  const line = LINE * fs;
  const gutterL = GUTTER_LEFT * fs;
  const gutterB = GUTTER_BOTTOM * fs;
  const padT = PAD_TOP * fs;
  const plotW = Math.max(0, width - gutterL - PAD_RIGHT);
  const plotH = Math.max(0, height - padT - gutterB);

  const n = points.length;
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  // The axis floor drops in tens only when a score needs it, so the bands keep their shape.
  const yMin = Math.min(50, ...values.map((v) => Math.floor(clamp(v, 0, 100) / 10) * 10));
  const yMax = 100;
  const x = (i: number) => gutterL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v: number) => padT + (1 - (clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * plotH;

  const segments: string[] = [];
  let run: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (run.length) segments.push(run.join(' '));
      run = [];
      return;
    }
    run.push(`${run.length ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`);
  });
  if (run.length) segments.push(run.join(' '));
  const path = segments.join(' ');

  const bands = BAND_FLOORS.map((b, i) => ({
    band: b.band,
    top: i === 0 ? yMax : (BAND_FLOORS[i - 1]?.floor ?? yMax),
    bottom: Math.max(b.floor, yMin),
  })).filter((b) => b.top > b.bottom);

  // Ticks: both axis ends and every band floor between them, thinned from the top so no two
  // labels touch when text is large.
  const ticks: number[] = [];
  let lastTickY = -Infinity;
  const floors = BAND_FLOORS.map((b) => b.floor).filter((f) => f > yMin && f < yMax);
  for (const v of [yMax, ...floors, yMin]) {
    if (y(v) - lastTickY >= line) {
      ticks.push(v);
      lastTickY = y(v);
    }
  }

  const scored = points.map((p, i) => (p.value === null ? -1 : i)).filter((i) => i >= 0);
  const firstIdx = scored[0];
  const lastIdx = scored[scored.length - 1];

  // As many period labels as fit, always the first and the last.
  const maxLabels = Math.max(2, Math.floor(plotW / (X_LABEL_W * fs)));
  const step = n > 1 ? Math.max(1, Math.ceil((n - 1) / (maxLabels - 1))) : 1;
  const xLabelIdx = points
    .map((_, i) => i)
    .filter((i) => i === n - 1 || (i % step === 0 && n - 1 - i >= step / 2));

  const endLabel = (i: number, withBand: boolean) => {
    const v = points[i]?.value;
    if (v === null || v === undefined) return null;
    const stack = (withBand ? 2 : 1) * line;
    const above = y(v) - 8 - stack;
    const top = above >= 0 ? above : y(v) + 9;
    const atRight = i === lastIdx && i !== firstIdx;
    return (
      <View
        key={`end-${i}`}
        pointerEvents="none"
        style={[
          { position: 'absolute', top, maxWidth: plotW * 0.6 },
          atRight
            ? { right: width - x(i) - 6, alignItems: 'flex-end' as const }
            : { left: x(i) - 6, alignItems: 'flex-start' as const },
        ]}
      >
        <Text
          variant="caption"
          style={{
            fontFamily: fontFamilies.numerals,
            lineHeight: line,
            textAlign: atRight ? 'right' : 'left',
          }}
        >
          {formatScore(v)}
        </Text>
        {withBand ? (
          <Text
            variant="caption"
            tone="subtle"
            style={{ lineHeight: line, textAlign: atRight ? 'right' : 'left' }}
          >
            {bandLabel(bandOfScore(v))}
          </Text>
        ) : null}
      </View>
    );
  };

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
        style={{ height, width: fixedWidth }}
      >
        {width > 0 && n > 0 ? (
          <>
            <Svg width={width} height={height}>
              {bandShading
                ? bands.map((b) => (
                    <Rect
                      key={b.band}
                      testID={id(`band-${b.band}`)}
                      x={gutterL}
                      y={y(b.top)}
                      width={plotW}
                      height={y(b.bottom) - y(b.top)}
                      fill={t.colors.text}
                      fillOpacity={WASH[b.band]}
                    />
                  ))
                : null}
              {ticks.map((v) => (
                <Line
                  key={v}
                  x1={gutterL}
                  x2={gutterL + plotW}
                  y1={y(v)}
                  y2={y(v)}
                  stroke={t.colors.divider}
                  strokeWidth={1}
                />
              ))}
              {path ? (
                <Path
                  testID={id('line')}
                  d={path}
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
                    cx={x(i)}
                    cy={y(p.value)}
                    r={i === lastIdx ? 5 : 4}
                    fill={t.colors.accent}
                    stroke={t.colors.surface}
                    strokeWidth={2}
                  />
                )
              )}
            </Svg>
            {ticks.map((v) => (
              <Text
                key={`tick-${v}`}
                variant="caption"
                tone="subtle"
                style={{
                  position: 'absolute',
                  left: 0,
                  width: gutterL - 6,
                  top: y(v) - line / 2,
                  lineHeight: line,
                  textAlign: 'right',
                  fontFamily: fontFamilies.numerals,
                }}
              >
                {v}
              </Text>
            ))}
            {firstIdx !== undefined && firstIdx !== lastIdx ? endLabel(firstIdx, false) : null}
            {lastIdx !== undefined ? endLabel(lastIdx, true) : null}
            {xLabelIdx.map((i) => {
              const p = points[i];
              if (!p) return null;
              const w = X_LABEL_W * fs;
              const last = i === n - 1;
              return (
                <Text
                  key={`x-${i}`}
                  variant="caption"
                  tone="subtle"
                  numberOfLines={1}
                  style={[
                    { position: 'absolute', top: height - gutterB + 4, width: w, lineHeight: line },
                    i === 0
                      ? { left: gutterL, textAlign: 'left' as const }
                      : last
                        ? { right: PAD_RIGHT, textAlign: 'right' as const }
                        : { left: x(i) - w / 2, textAlign: 'center' as const },
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
