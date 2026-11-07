/**
 * The recap's speed chart, as numbers (pure): the drive's speed trace (`core/engine/speedTrace.ts`)
 * laid out across the drive's time, its speed limit as steps, and its speeding episodes as bands
 * behind them. Recap only: the share card never shows a speed.
 */
import type { SpeedPoint, SpeedTrace } from '@/core/engine/speedTrace';
import { distanceIn, type Units } from '@/lib/units';

import { recapCopy } from './copy';
import { spokenEventDuration } from './format';
import type { LocalDrive, LocalDriveEvent } from './model';
import { isRemoved } from './summary';

/** The chart shows from this many points with a speed. */
export const SPEED_CHART_MIN_POINTS = 2;
/** The Y axis tops out at the fastest value rounded up to the next multiple of this (mph or km/h). */
export const SPEED_CHART_STEP = 10;
/** Room inside the plot's edges, so the line's caps are never clipped. */
export const SPEED_PLOT_EDGE = 4;
/** A speeding band is at least this wide (pt), so a 1 s episode still shows. */
export const SPEED_BAND_MIN_W = 2;

/** Whether the drive has a trace worth drawing: at least `SPEED_CHART_MIN_POINTS` points with a speed. */
export function showsSpeedChart(trace: SpeedTrace | null | undefined): trace is SpeedTrace {
  if (trace === null || trace === undefined) return false;
  let n = 0;
  for (const p of trace.points) if (p.v !== null && (n += 1) >= SPEED_CHART_MIN_POINTS) return true;
  return false;
}

/** The drive's span on the X axis (s): its duration, never shorter than the trace's last bucket start, at least 1 s. */
export function chartSpanS(drive: Pick<LocalDrive, 'durationS'>, trace: SpeedTrace): number {
  const last = trace.points[trace.points.length - 1];
  return Math.max(1, Number.isFinite(drive.durationS) ? drive.durationS : 0, last === undefined ? 0 : last.t + 1);
}

/** A speed in mph as the driver reads it: km/h for a kilometre driver. */
export const speedIn = (mph: number, units: Units): number => distanceIn(mph, units);

/** The Y axis's top in the driver's units: the fastest speed or limit rounded up to the next 10, at least 10. */
export function chartTop(trace: SpeedTrace, units: Units): number {
  let max = 0;
  for (const p of trace.points) {
    if (p.v !== null) max = Math.max(max, speedIn(p.v, units));
    if (p.l !== null) max = Math.max(max, speedIn(p.l, units));
  }
  return Math.max(SPEED_CHART_STEP, Math.ceil(max / SPEED_CHART_STEP) * SPEED_CHART_STEP);
}

/** The Y axis labels, top to bottom: the top, the middle and 0, each with its unit ("60 mph", "30 mph", "0 mph"). */
export function axisLabels(top: number, units: Units): string[] {
  const unit = units === 'km' ? 'km/h' : 'mph';
  return [top, top / 2, 0].map((v) => `${Math.round(v)} ${unit}`);
}

export interface ChartScale {
  /** The X axis's span, seconds from the drive's start. */
  spanS: number;
  /** The Y axis's top, in the driver's units. */
  top: number;
  width: number;
  height: number;
  units: Units;
}

export interface Pt {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Seconds from the drive's start to a point across the plot. */
export const xAt = (s: number, sc: ChartScale): number => SPEED_PLOT_EDGE + (clamp(s, 0, sc.spanS) / sc.spanS) * Math.max(0, sc.width - 2 * SPEED_PLOT_EDGE);

/** A speed in mph to a point down the plot (the driver's units against the top). */
export const yAt = (mph: number, sc: ChartScale): number =>
  SPEED_PLOT_EDGE + (1 - clamp(speedIn(mph, sc.units) / sc.top, 0, 1)) * Math.max(0, sc.height - 2 * SPEED_PLOT_EDGE);

/** Two points are neighbours when the second's bucket starts where the first's ends (no rows missing between). */
const next = (a: SpeedPoint, b: SpeedPoint, w: number): boolean => b.t === a.t + w;

/**
 * The speed line's runs: each stretch of neighbouring buckets with a speed, every point at its
 * bucket's middle. A bucket with no trusted speed, or missing rows, breaks the line.
 */
export function speedRuns(trace: SpeedTrace, sc: ChartScale): Pt[][] {
  const w = trace.widthS;
  const runs: Pt[][] = [];
  let run: Pt[] | null = null;
  let prev: SpeedPoint | null = null;
  for (const p of trace.points) {
    if (p.v === null) {
      run = null;
    } else {
      if (run === null || prev === null || !next(prev, p, w)) {
        run = [];
        runs.push(run);
      }
      run.push({ x: xAt(Math.min(p.t + w / 2, sc.spanS), sc), y: yAt(p.v, sc) });
    }
    prev = p;
  }
  return runs;
}

const n1 = (v: number): string => v.toFixed(1);

/** An SVG path straight through the points; empty for none. */
export const linePath = (pts: readonly Pt[]): string => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${n1(p.x)},${n1(p.y)}`).join(' ');

/**
 * The speed limit as steps: a flat line across each bucket with a limit at that limit, joined
 * straight up or down to the next bucket's when they are neighbours. A bucket with none breaks it.
 */
export function limitPath(trace: SpeedTrace, sc: ChartScale): string {
  const w = trace.widthS;
  const parts: string[] = [];
  let prev: SpeedPoint | null = null;
  for (const p of trace.points) {
    if (p.l !== null) {
      const y = n1(yAt(p.l, sc));
      const x0 = n1(xAt(p.t, sc));
      const x1 = n1(xAt(p.t + w, sc));
      const joined = prev !== null && prev.l !== null && next(prev, p, w);
      parts.push(`${joined ? 'L' : 'M'}${x0},${y} L${x1},${y}`);
    }
    prev = p;
  }
  return parts.join(' ');
}

/** The drive's active speeding events (not removed by a report). */
export const activeSpeeding = (events: readonly LocalDriveEvent[]): LocalDriveEvent[] => events.filter((e) => e.type === 'speeding' && !isRemoved(e));

export interface SpeedBand {
  id: string;
  tier: LocalDriveEvent['tier'];
  x: number;
  width: number;
}

/** Each active speeding episode as a band across the plot, from its start for as long as it lasted (against the drive's start); none outside the drive. */
export function speedingBands(drive: Pick<LocalDrive, 'startedAt'>, events: readonly LocalDriveEvent[], sc: ChartScale): SpeedBand[] {
  const out: SpeedBand[] = [];
  for (const e of activeSpeeding(events)) {
    const from = (e.startedAt - drive.startedAt) / 1000;
    const to = from + Math.max(0, e.durationS);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < 0 || from > sc.spanS) continue;
    const x0 = xAt(from, sc);
    const x1 = xAt(to, sc);
    const width = Math.max(SPEED_BAND_MIN_W, x1 - x0);
    out.push({ id: e.id, tier: e.tier, x: Math.min(x0, sc.width - width), width });
  }
  return out;
}

/** The chart for a screen reader: "Speed chart. Over the limit 3 times, 1 minute 10 seconds in all." or "Speed chart. Never over the limit." */
export function speedChartLabel(events: readonly LocalDriveEvent[]): string {
  const speeding = activeSpeeding(events);
  const s = speeding.reduce((a, e) => a + Math.max(0, e.durationS), 0);
  return recapCopy.speed.spoken(speeding.length, spokenEventDuration(s));
}
