// A drive's limit time split by the kind of road, for the analytics' "Where you speed": every row
// that counts toward limit time (`exposure.ts`: a usable limit at 10 mph or more) adds its second
// and its distance to the bucket of its scored limit. A pure, frozen reducer, kept in each movement
// mark the way the exposure counters are, so a cut drive counts none of its tail. Local only.
import { knownSpeedMph, speedTrusted } from '../detectors/common';
import { LIMIT_MIN_MPH } from './exposure';
import type { FeatureRow } from './types';

/** Streets: a limit of this or under (mph). */
export const LOW_MAX_MPH = 27;
/** Highways: a limit of this or over (mph). Main roads lie between. */
export const HIGH_MIN_MPH = 48;

export const LIMIT_BUCKET_KEYS = ['low', 'mid', 'high'] as const;
export type LimitBucketKey = (typeof LIMIT_BUCKET_KEYS)[number];

/** Seconds and metres in one bucket. */
export interface LimitBucket {
  readonly s: number;
  readonly m: number;
}

export type LimitBuckets = Readonly<Record<LimitBucketKey, Readonly<LimitBucket>>>;

const ZERO: Readonly<LimitBucket> = Object.freeze({ s: 0, m: 0 });

export const EMPTY_LIMIT_BUCKETS: LimitBuckets = Object.freeze({ low: ZERO, mid: ZERO, high: ZERO });

/** The bucket of a limit in mph: low ≤ 27, mid 28 to 47, high ≥ 48 (a fraction rounds first). */
export function limitBucketOf(limitMph: number): LimitBucketKey {
  const v = Math.round(limitMph);
  if (v <= LOW_MAX_MPH) return 'low';
  return v >= HIGH_MIN_MPH ? 'high' : 'mid';
}

/**
 * One row. `limitUsable`: as for limit time. `limitMph`: the scored limit (`limitMphFor`), or null
 * (the row then goes nowhere). `distanceM`: the distance the row added to the drive (0 when none).
 * Returns a new frozen state when the row counts, else the same one.
 */
export function noteLimitBuckets(
  state: LimitBuckets,
  row: FeatureRow,
  limitUsable: boolean,
  limitMph: number | null | undefined,
  distanceM: number
): LimitBuckets {
  if (!limitUsable || typeof limitMph !== 'number' || !Number.isFinite(limitMph) || limitMph <= 0) return state;
  const v = speedTrusted(row) ? knownSpeedMph(row) : null;
  if (v === null || v < LIMIT_MIN_MPH) return state;
  const key = limitBucketOf(limitMph);
  const b = state[key];
  const m = Number.isFinite(distanceM) && distanceM > 0 ? distanceM : 0;
  return Object.freeze({ ...state, [key]: Object.freeze({ s: b.s + 1, m: b.m + m }) });
}

/**
 * The buckets as stored: whole seconds and metres, scaled down together when their seconds sum past
 * `limitS` (the drive's limit time, clamped) or their metres past `maxM` (the drive's distance), so
 * the split never claims more than the drive has. Each bucket's figure is floored.
 */
export function boundLimitBuckets(state: LimitBuckets, limitS: number, maxM: number): LimitBuckets {
  const whole = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  const sumS = LIMIT_BUCKET_KEYS.reduce((a, k) => a + state[k].s, 0);
  const sumM = LIMIT_BUCKET_KEYS.reduce((a, k) => a + state[k].m, 0);
  const capS = Math.max(0, Number.isFinite(limitS) ? limitS : 0);
  const capM = Math.max(0, Number.isFinite(maxM) ? maxM : 0);
  const fs = sumS > capS ? capS / sumS : 1;
  const fm = sumM > capM ? capM / sumM : 1;
  const one = (k: LimitBucketKey): Readonly<LimitBucket> => Object.freeze({ s: whole(state[k].s * fs), m: whole(state[k].m * fm) });
  return Object.freeze({ low: one('low'), mid: one('mid'), high: one('high') });
}

/** The stored JSON (`trips.limit_buckets_json`): `{"low":{"s":..,"m":..},"mid":{...},"high":{...}}`. */
export const limitBucketsJson = (b: LimitBuckets): string =>
  JSON.stringify({ low: { s: b.low.s, m: b.low.m }, mid: { s: b.mid.s, m: b.mid.m }, high: { s: b.high.s, m: b.high.m } });

/** Stored buckets read back; null on null, bad JSON or any bucket missing or not two non-negative numbers. */
export function parseLimitBuckets(json: string | null | undefined): LimitBuckets | null {
  if (typeof json !== 'string') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const out: Partial<Record<LimitBucketKey, LimitBucket>> = {};
  for (const k of LIMIT_BUCKET_KEYS) {
    const b = (raw as Record<string, unknown>)[k];
    if (typeof b !== 'object' || b === null) return null;
    const { s, m } = b as { s?: unknown; m?: unknown };
    if (typeof s !== 'number' || typeof m !== 'number' || !Number.isFinite(s) || !Number.isFinite(m) || s < 0 || m < 0) return null;
    out[k] = { s, m };
  }
  return out as LimitBuckets;
}
