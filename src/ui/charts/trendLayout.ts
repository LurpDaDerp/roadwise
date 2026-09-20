// The trend's geometry as a pure function, so the label placement rules can be proven in a test
// with the same arithmetic the component draws with. No React, no theme.
import type { ScoreBand } from '@scoring';

import { BAND_FLOORS, bandLabel, bandOfScore, clamp, formatScore, type TrendPoint } from './format';

/** Geometry at the default text size, in dp. Gutters and label lanes grow with the text. */
export const TREND = {
  gutterLeft: 32,
  gutterBottom: 22,
  padTop: 12,
  padRight: 12,
  line: 16,
  xLabelWidth: 56,
  /** Clear air between a label and anything it could touch. */
  gap: 8,
  markerRadius: 4,
  lastMarkerRadius: 5,
} as const;

// Width estimates for the collision rule: B612 Mono advances about 0.62 em, the UI face averages
// about 0.55 em, both at the caption size. Estimates, used only to reason about overlap.
const CAPTION = 12;
const MONO_EM = 0.62;
const UI_EM = 0.55;

export type Box = { left: number; right: number; top: number; bottom: number };

export type TrendTick = { value: number; y: number; box: Box };

export type TrendEndLabel = {
  index: number;
  value: number;
  /** The band word under the value, on the last point only. */
  band: string | null;
  atRight: boolean;
  anchor: { left: number } | { right: number };
  top: number;
  /** Where the label lands, with its width estimated. */
  box: Box;
};

export type TrendXLabel = {
  index: number;
  width: number;
  align: 'left' | 'center' | 'right';
  anchor: { left: number } | { right: number };
};

export type TrendLayout = {
  width: number;
  /** The drawn height: the requested height plus what the gutters grew by. */
  height: number;
  line: number;
  gutterL: number;
  plotW: number;
  plotH: number;
  yMin: number;
  yMax: number;
  x: (i: number) => number;
  y: (v: number) => number;
  path: string;
  washes: { band: ScoreBand; y: number; height: number }[];
  ticks: TrendTick[];
  firstIdx: number | undefined;
  lastIdx: number | undefined;
  ends: TrendEndLabel[];
  xLabels: TrendXLabel[];
  xLabelTop: number;
};

export function layoutTrend(
  points: readonly TrendPoint[],
  { width, height: baseHeight, fontScale: fs }: { width: number; height: number; fontScale: number }
): TrendLayout {
  const line = TREND.line * fs;
  const gutterL = TREND.gutterLeft * fs;
  const gutterB = TREND.gutterBottom * fs;
  const padT = TREND.padTop * fs;
  // The plot keeps its height at every text size: the gutters grow and the drawing grows with
  // them, so a larger label row is never paid for by squeezing the marks and their labels.
  const height = baseHeight + (fs - 1) * (TREND.padTop + TREND.gutterBottom);
  const plotW = Math.max(0, width - gutterL - TREND.padRight);
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

  const washes = BAND_FLOORS.map((b, i) => ({
    band: b.band,
    top: i === 0 ? yMax : (BAND_FLOORS[i - 1]?.floor ?? yMax),
    bottom: Math.max(b.floor, yMin),
  }))
    .filter((b) => b.top > b.bottom)
    .map((b) => ({ band: b.band, y: y(b.top), height: y(b.bottom) - y(b.top) }));

  // Ticks: both axis ends and every band floor between them, thinned from the top so no two
  // numerals touch when text is large. They live in the gutter, right-aligned, ending 6 dp
  // short of the plot.
  const ticks: TrendTick[] = [];
  let lastTickY = -Infinity;
  const floors = BAND_FLOORS.map((b) => b.floor).filter((f) => f > yMin && f < yMax);
  for (const value of [yMax, ...floors, yMin]) {
    const ty = y(value);
    if (ty - lastTickY < line) continue;
    ticks.push({
      value,
      y: ty,
      box: { left: 0, right: gutterL - 6, top: ty - line / 2, bottom: ty + line / 2 },
    });
    lastTickY = ty;
  }

  const scored = points.map((p, i) => (p.value === null ? -1 : i)).filter((i) => i >= 0);
  const firstIdx = scored[0];
  const lastIdx = scored[scored.length - 1];
  const xLabelTop = height - gutterB + 4;

  // End labels sit inside the plot, never in the gutter: the first starts one gap to the right
  // of its marker, the last ends just past its marker and grows leftward. Each goes above its
  // point when there is room and below it otherwise, which keeps it clear of the axis row.
  const clearance = TREND.lastMarkerRadius + 2 + 2; // the marker, its surface ring, 2 dp of air
  const ends: TrendEndLabel[] = [];
  const place = (index: number, withBand: boolean) => {
    const value = points[index]?.value;
    if (value === null || value === undefined) return;
    const band = withBand ? bandLabel(bandOfScore(value)) : null;
    const stack = (withBand ? 2 : 1) * line;
    const cy = y(value);
    const above = cy - clearance - stack;
    let top = above >= 0 ? above : cy + clearance;
    if (top + stack > xLabelTop - TREND.gap / 2) top = Math.max(0, above);
    const atRight = index === lastIdx && index !== firstIdx;
    const em = CAPTION * fs;
    const estWidth = Math.min(
      plotW * 0.6,
      Math.max(formatScore(value).length * em * MONO_EM, (band?.length ?? 0) * em * UI_EM)
    );
    const edge = atRight ? x(index) + 6 : x(index) + TREND.gap;
    ends.push({
      index,
      value,
      band,
      atRight,
      anchor: atRight ? { right: width - edge } : { left: edge },
      top,
      box: atRight
        ? { left: edge - estWidth, right: edge, top, bottom: top + stack }
        : { left: edge, right: edge + estWidth, top, bottom: top + stack },
    });
  };
  if (firstIdx !== undefined && firstIdx !== lastIdx) place(firstIdx, false);
  if (lastIdx !== undefined) place(lastIdx, true);

  // As many period labels as fit, always the first and the last.
  const w = TREND.xLabelWidth * fs;
  const maxLabels = Math.max(2, Math.floor(plotW / w));
  const step = n > 1 ? Math.max(1, Math.ceil((n - 1) / (maxLabels - 1))) : 1;
  const xLabels: TrendXLabel[] = points
    .map((_, i) => i)
    .filter((i) => i === n - 1 || (i % step === 0 && n - 1 - i >= step / 2))
    .map((i) =>
      i === 0
        ? { index: i, width: w, align: 'left', anchor: { left: gutterL } }
        : i === n - 1
          ? { index: i, width: w, align: 'right', anchor: { right: TREND.padRight } }
          : { index: i, width: w, align: 'center', anchor: { left: x(i) - w / 2 } }
    );

  return {
    width,
    height,
    line,
    gutterL,
    plotW,
    plotH,
    yMin,
    yMax,
    x,
    y,
    path,
    washes,
    ticks,
    firstIdx,
    lastIdx,
    ends,
    xLabels,
    xLabelTop,
  };
}
