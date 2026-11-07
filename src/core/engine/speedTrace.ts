// A drive's speed over time, for the recap's speed chart: the drive cut into buckets of time, each
// with the mean trusted GPS speed and the sign's limit. A pure, frozen reducer (like `exposure.ts`),
// so a live drive, a drive cut back to its last movement (each movement mark keeps the state as it
// stood after its row) and a drive rebuilt from its stored rows all agree. Local only: never uploaded.
//
// Buckets start `BUCKET_START_S` (5 s) wide, aligned to the drive's start. Once there would be more
// than `MAX_BUCKETS` (720), every two neighbours on the doubled grid merge and the width doubles:
// a 1 h drive keeps 5 s buckets, a 12 h drive 80 s ones.
import { knownSpeedMph, speedTrusted } from '../detectors/common';
import type { FeatureRow } from './types';

/** The first bucket width, seconds. */
export const BUCKET_START_S = 5;
/** The most buckets a trace keeps. */
export const MAX_BUCKETS = 720;

/** One bucket as the reducer keeps it: `sum`/`n` give its time-weighted mean (each row is one second). */
export interface TraceBucket {
  /** Start, whole seconds from the drive's start (a multiple of the width). */
  readonly t: number;
  /** Sum of the trusted speeds (mph) of its rows that had one, and how many rows that was. */
  readonly sum: number;
  readonly n: number;
  /** The last sign limit (whole mph) seen in it; null when none. */
  readonly l: number | null;
}

export interface SpeedTraceState {
  /** Bucket width, seconds. */
  readonly w: number;
  /** The buckets before the open one, oldest first. */
  readonly closed: readonly Readonly<TraceBucket>[];
  /** The bucket the latest row went into; null before the first row. */
  readonly open: Readonly<TraceBucket> | null;
}

export const EMPTY_SPEED_TRACE: Readonly<SpeedTraceState> = Object.freeze({ w: BUCKET_START_S, closed: Object.freeze([]), open: null });

/** One point of a stored trace: bucket start (s from the drive's start), mean speed (mph, 1 dp) and the sign's limit (mph). */
export interface SpeedPoint {
  t: number;
  v: number | null;
  l: number | null;
}

/** A drive's speed trace as the views read it. */
export interface SpeedTrace {
  /** Bucket width, seconds. */
  widthS: number;
  /** Oldest first; at most `MAX_BUCKETS`. */
  points: readonly SpeedPoint[];
}

const bucketOf = (t: number, w: number): number => Math.floor(t / w) * w;

/** `b` with one more row (its trusted speed, or null, and its sign limit, or null). */
const add = (b: Readonly<TraceBucket>, v: number | null, l: number | null): Readonly<TraceBucket> =>
  Object.freeze({ t: b.t, sum: v === null ? b.sum : b.sum + v, n: v === null ? b.n : b.n + 1, l: l ?? b.l });

/** Two buckets as one: speeds summed (the mean stays time-weighted), the later bucket's limit else the earlier's. */
const join = (a: Readonly<TraceBucket>, b: Readonly<TraceBucket>, t: number): Readonly<TraceBucket> =>
  Object.freeze({ t, sum: a.sum + b.sum, n: a.n + b.n, l: b.l ?? a.l });

/** The buckets on a grid `w` wide (twice theirs): neighbours in the same new bucket joined. Oldest first in, oldest first out. */
export function mergeBuckets(buckets: readonly Readonly<TraceBucket>[], w: number): Readonly<TraceBucket>[] {
  const out: Readonly<TraceBucket>[] = [];
  for (const b of buckets) {
    const t = bucketOf(b.t, w);
    const last = out[out.length - 1];
    if (last !== undefined && last.t === t) out[out.length - 1] = join(last, b, t);
    else out.push(Object.freeze({ ...b, t }));
  }
  return out;
}

/**
 * One row. `startedAt`: the drive's start (epoch ms; a row before it counts at 0 s). `signMph`: the
 * limit the sign showed for the row (`limitShownMph`), or null. The speed is the row's GNSS speed,
 * read only when trusted (`exposure.ts`' rule). Returns a new frozen state; the input is untouched.
 */
export function noteSpeedTrace(state: Readonly<SpeedTraceState>, row: FeatureRow, startedAt: number, signMph: number | null | undefined): Readonly<SpeedTraceState> {
  const v = speedTrusted(row) ? knownSpeedMph(row) : null;
  const l = typeof signMph === 'number' && Number.isFinite(signMph) && signMph > 0 ? Math.round(signMph) : null;
  const sec = Math.max(0, Math.floor((row.ts - startedAt) / 1000));
  const { open } = state;
  let { w } = state;
  if (open !== null && bucketOf(sec, w) <= open.t) return Object.freeze({ w, closed: state.closed, open: add(open, v, l) });
  let closed: readonly Readonly<TraceBucket>[] = open === null ? state.closed : [...state.closed, open];
  let next: Readonly<TraceBucket> = Object.freeze({ t: bucketOf(sec, w), sum: 0, n: 0, l: null });
  while (closed.length + 1 > MAX_BUCKETS) {
    w *= 2;
    const merged = mergeBuckets(closed, w);
    const t = bucketOf(sec, w);
    const last = merged[merged.length - 1];
    // The new row's bucket may now be the last closed one's: it stays open.
    next = last !== undefined && last.t === t ? (merged.pop() as Readonly<TraceBucket>) : Object.freeze({ t, sum: 0, n: 0, l: null });
    closed = merged;
  }
  // `closed` is a fresh array here (or the old frozen one), so freezing it touches nobody's state.
  return Object.freeze({ w, closed: Object.freeze(closed), open: add(next, v, l) });
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** The trace as the views read it; null when no row went in. */
export function speedTraceOf(state: Readonly<SpeedTraceState>): SpeedTrace | null {
  const all = state.open === null ? state.closed : [...state.closed, state.open];
  if (all.length === 0) return null;
  return { widthS: state.w, points: all.map((b) => ({ t: b.t, v: b.n > 0 ? round1(b.sum / b.n) : null, l: b.l })) };
}

/** The trace as stored (`trips.speed_trace_json`): `{"w":<width s>,"p":[[t,v,l],...]}`; null when no row went in. */
export function speedTraceJson(state: Readonly<SpeedTraceState>): string | null {
  const trace = speedTraceOf(state);
  if (trace === null) return null;
  return JSON.stringify({ w: trace.widthS, p: trace.points.map((p) => [p.t, p.v, p.l]) });
}

const finiteOrNull = (v: unknown): number | null | undefined => (v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A stored trace read back; null on null, bad JSON or any point of the wrong shape. */
export function parseSpeedTrace(json: string | null | undefined): SpeedTrace | null {
  if (typeof json !== 'string') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { w, p } = raw as { w?: unknown; p?: unknown };
  if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || !Array.isArray(p) || p.length > MAX_BUCKETS) return null;
  const points: SpeedPoint[] = [];
  for (const item of p) {
    if (!Array.isArray(item) || item.length !== 3) return null;
    const [t, v, l] = item as unknown[];
    const vv = finiteOrNull(v);
    const ll = finiteOrNull(l);
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || vv === undefined || ll === undefined) return null;
    points.push({ t, v: vv, l: ll });
  }
  return { widthS: w, points };
}
