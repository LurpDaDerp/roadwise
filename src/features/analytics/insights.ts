/**
 * Three comments the Analytics tab makes on how the driver drives, never scored and never moving
 * the rating: where the speeding happens (Speed's sheet), when the phone pickups happen (Phone use's
 * sheet), and how the drives go in rain or snow against the dry (a card under Time of day). Pure:
 * each takes the drives and events it reads and a cutoff, never the clock.
 *
 * The two sheet comments follow the page's range like the sheet's numbers: the active events of the
 * scored drives started at or after `sinceMs`, each event belonging to the latest drive started at
 * or before it (`eventsByDrive`). The weather card is all time.
 */
import { speedingChargedS, type DriveEvent } from '@scoring';

import { LIMIT_BUCKET_KEYS, limitBucketOf, type LimitBucketKey } from '@/core/engine/limitBuckets';
import type { LocalDrive } from '@/data/queries/rows';
import { KM_PER_MILE, type Units } from '@/lib/units';

import { bandIndex, eventsByDrive, scoredSince } from './model';

/** The active events of the scored drives started at or after `sinceMs`, each with its drive. */
function rangeEvents(drives: readonly LocalDrive[], events: readonly DriveEvent[], sinceMs: number | null): { drive: LocalDrive; event: DriveEvent }[] {
  if (events.length === 0) return [];
  const own = eventsByDrive(scoredSince(drives, null), events);
  const out: { drive: LocalDrive; event: DriveEvent }[] = [];
  for (const d of scoredSince(drives, sinceMs)) {
    for (const e of own.get(d.clientTripId) ?? []) {
      if (e.status !== 'removed') out.push({ drive: d, event: e });
    }
  }
  return out;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------------------------
// Where you speed

export type RoadKind = LimitBucketKey;
/** Streets, main roads, highways: the limit buckets of the drives (`low` ≤ 27 mph, `mid` 28–47, `high` ≥ 48). */
export const ROAD_KINDS: readonly RoadKind[] = LIMIT_BUCKET_KEYS;

/** Most of the speeding: one road kind holds at least this share of the speeding time. */
export const ROAD_MOST_SHARE = 0.5;
/** "even though only …": the road kind's share of the speeding beats its share of the driving by this many points. */
export const ROAD_GAP_POINTS = 15;

export interface SpeedingByRoad {
  /** Seconds over the line in the range (Σ `speedingChargedS` of the speeding events with a limit). */
  speedingS: number;
  /** Each road kind's seconds over the line. */
  speeding: Record<RoadKind, number>;
  /**
   * Each road kind's seconds driven under a known limit, from the drives that keep them. Null when no
   * drive in the range does, or when a drive whose speeding is counted doesn't (recorded before the
   * buckets, or restored): its speeding would be split against driving that was never measured.
   */
  driving: Record<RoadKind, number> | null;
}

/**
 * The range's speeding by kind of road: each active speeding event's seconds over the line
 * (`speedingChargedS`, as the sheet's "Over the limit" counts them) go to the bucket of the limit it
 * broke (`measured.limitMph`; an event without one is left out). The driving split is the range's
 * limit time by bucket (`drive.limitBuckets`); a drive recorded before the buckets adds nothing to
 * it. It is null with no drive keeping them, and whenever a drive with counted speeding has none, so
 * the speeding and driving shares always describe the same drives. Null when the range has no
 * speeding to split.
 */
export function speedingByRoad(drives: readonly LocalDrive[], events: readonly DriveEvent[], sinceMs: number | null): SpeedingByRoad | null {
  const speeding: Record<RoadKind, number> = { low: 0, mid: 0, high: 0 };
  let speedingS = 0;
  let unsplit = false;
  for (const { drive: d, event: e } of rangeEvents(drives, events, sinceMs)) {
    if (e.type !== 'speeding') continue;
    const limit = e.measured?.limitMph;
    if (!finite(limit) || limit <= 0) continue;
    const s = speedingChargedS(e.durationS);
    speeding[limitBucketOf(limit)] += s;
    speedingS += s;
    if (!d.limitBuckets) unsplit = true;
  }
  if (speedingS <= 0) return null;
  const driving: Record<RoadKind, number> = { low: 0, mid: 0, high: 0 };
  let known = false;
  for (const d of scoredSince(drives, sinceMs)) {
    const b = d.limitBuckets;
    if (!b) continue;
    for (const k of ROAD_KINDS) driving[k] += b[k].s;
    known = true;
  }
  const drivingS = ROAD_KINDS.reduce((a, k) => a + driving[k], 0);
  return { speedingS, speeding, driving: known && drivingS > 0 && !unsplit ? driving : null };
}

export interface RoadRow {
  kind: RoadKind;
  /** Whole percent of the speeding time on this kind of road. */
  speedingPct: number;
  /** Whole percent of the driving time with a known limit on it; null when unknown. */
  drivingPct: number | null;
}

export interface RoadView {
  rows: RoadRow[];
  /** The kind holding at least half the speeding time, if one does. */
  most: RoadKind | null;
  /** That kind's share of the speeding beats its share of the driving by 15 points or more. */
  gap: boolean;
}

const pct = (n: number, total: number): number => (total > 0 ? Math.round((100 * n) / total) : 0);

/** The section's rows (always three, streets first) and what its headline says. */
export function roadView(r: SpeedingByRoad): RoadView {
  const drivingS = r.driving ? ROAD_KINDS.reduce((a, k) => a + r.driving![k], 0) : 0;
  const rows = ROAD_KINDS.map((kind) => ({
    kind,
    speedingPct: pct(r.speeding[kind], r.speedingS),
    drivingPct: r.driving ? pct(r.driving[kind], drivingS) : null,
  }));
  const most = ROAD_KINDS.find((k) => r.speeding[k] / r.speedingS >= ROAD_MOST_SHARE) ?? null;
  const row = most ? rows.find((x) => x.kind === most)! : null;
  const gap = row !== null && row.drivingPct !== null && row.speedingPct - row.drivingPct >= ROAD_GAP_POINTS;
  return { rows, most, gap };
}

// ---------------------------------------------------------------------------------------------
// When pickups happen

/** Under this many pickups in the range the section is hidden: too few to read a habit from. */
export const PICKUP_TIMING_MIN = 3;
/** The pickup speed buckets' edges (mph): 10–25, 25–45, 45 and up. */
export const PICKUP_MID_MPH = 25;
export const PICKUP_HIGH_MPH = 45;
/** A km driver's edges (km/h): 16–40, 40–70, 70 and up, as the rows are labelled. */
export const PICKUP_MID_KMH = 40;
export const PICKUP_HIGH_KMH = 70;
/** The start and the end of a drive: its first and its last 5 minutes. */
export const PICKUP_EDGE_MS = 5 * 60_000;
/** A drive shorter than this has no "in between": each pickup is in its first or last 5 minutes, whichever is nearer. */
export const PICKUP_SHORT_DRIVE_MS = 10 * 60_000;
/** A headline names a bucket holding at least this share of the pickups. */
export const PICKUP_MOST_SHARE = 0.5;

export type PickupSpeed = 'low' | 'mid' | 'high';
export const PICKUP_SPEEDS: readonly PickupSpeed[] = ['low', 'mid', 'high'];
export type PickupMoment = 'first' | 'middle' | 'last';
export const PICKUP_MOMENTS: readonly PickupMoment[] = ['first', 'middle', 'last'];

export interface PickupTiming {
  pickups: number;
  /** By speed at the pickup (`measured.speedMph`), on the driver's units' edges; a pickup with none is in no bucket. */
  speed: Record<PickupSpeed, number>;
  /** By moment in its drive. */
  moment: Record<PickupMoment, number>;
  /** By the 3-hour band of the device's local day (`bandIndex`), 8 bands from midnight. */
  bands: number[];
}

/** A pickup's speed bucket: 25 and 45 mph for a mi driver, 40 and 70 km/h for a km driver. */
export function pickupSpeedOf(mph: number, units: Units): PickupSpeed {
  const [v, mid, high] = units === 'km' ? [mph * KM_PER_MILE, PICKUP_MID_KMH, PICKUP_HIGH_KMH] : [mph, PICKUP_MID_MPH, PICKUP_HIGH_MPH];
  return v >= high ? 'high' : v >= mid ? 'mid' : 'low';
}

/**
 * Where in its drive a pickup came: in the first 5 minutes from the drive's start, in the last 5
 * before its end, or in between. A drive under 10 minutes has no in between: the nearer end wins (the
 * start on a tie). A drive's end is `endedAt`, else its start plus its duration.
 */
export function pickupMomentOf(drive: Pick<LocalDrive, 'startedAt' | 'endedAt' | 'durationS'>, at: number): PickupMoment {
  const end = drive.endedAt ?? drive.startedAt + Math.max(0, drive.durationS) * 1000;
  const fromStart = at - drive.startedAt;
  const toEnd = end - at;
  if (end - drive.startedAt < PICKUP_SHORT_DRIVE_MS) return fromStart <= toEnd ? 'first' : 'last';
  if (fromStart < PICKUP_EDGE_MS) return 'first';
  if (toEnd < PICKUP_EDGE_MS) return 'last';
  return 'middle';
}

/**
 * The range's active phone pickups by speed (on the driver's units' edges), by moment in the drive
 * and by time of day. Null under 3 pickups (the section is hidden).
 */
export function pickupTiming(drives: readonly LocalDrive[], events: readonly DriveEvent[], sinceMs: number | null, units: Units): PickupTiming | null {
  const out: PickupTiming = { pickups: 0, speed: { low: 0, mid: 0, high: 0 }, moment: { first: 0, middle: 0, last: 0 }, bands: new Array<number>(8).fill(0) };
  for (const { drive: d, event: e } of rangeEvents(drives, events, sinceMs)) {
    if (e.type !== 'phone_pickup') continue;
    out.pickups += 1;
    const mph = e.measured?.speedMph;
    if (finite(mph)) out.speed[pickupSpeedOf(mph, units)] += 1;
    out.moment[pickupMomentOf(d, e.startedAt)] += 1;
    const band = bandIndex(e.startedAt);
    out.bands[band] = (out.bands[band] ?? 0) + 1;
  }
  return out.pickups >= PICKUP_TIMING_MIN ? out : null;
}

export type PickupHeadlineKind = 'first' | 'last' | 'highway' | 'band';

export interface PickupView {
  headline: { kind: PickupHeadlineKind; band: number };
  /** The top speed bucket and its whole percent of the pickups with a speed; null when none had one. */
  speed: { key: PickupSpeed; pct: number } | null;
  moment: { key: PickupMoment; pct: number };
  band: { key: number; pct: number };
}

/** The first largest of `counts` (ties go to the earlier key). */
function top<K extends string | number>(keys: readonly K[], count: (k: K) => number): K {
  return keys.reduce((best, k) => (count(k) > count(best) ? k : best), keys[0]!);
}

/**
 * What the section says: the headline (first match wins: half or more in the first 5 minutes, then
 * in the last 5, then in the top speed bucket (45 mph / 70 km/h or more), else the busiest time
 * band) and each row's top bucket with its share.
 */
export function pickupView(p: PickupTiming): PickupView {
  const withSpeed = PICKUP_SPEEDS.reduce((a, k) => a + p.speed[k], 0);
  const bandKeys = p.bands.map((_, i) => i);
  const band = top(bandKeys, (i) => p.bands[i] ?? 0);
  const kind: PickupHeadlineKind =
    p.moment.first / p.pickups >= PICKUP_MOST_SHARE
      ? 'first'
      : p.moment.last / p.pickups >= PICKUP_MOST_SHARE
        ? 'last'
        : withSpeed > 0 && p.speed.high / withSpeed >= PICKUP_MOST_SHARE
          ? 'highway'
          : 'band';
  const speedKey = withSpeed > 0 ? top(PICKUP_SPEEDS, (k) => p.speed[k]) : null;
  const momentKey = top(PICKUP_MOMENTS, (k) => p.moment[k]);
  return {
    headline: { kind, band },
    speed: speedKey ? { key: speedKey, pct: pct(p.speed[speedKey], withSpeed) } : null,
    moment: { key: momentKey, pct: pct(p.moment[momentKey], p.pickups) },
    band: { key: band, pct: pct(p.bands[band] ?? 0, p.pickups) },
  };
}

// ---------------------------------------------------------------------------------------------
// Weather

/** Each side needs this many miles before the card compares them (16 km for a km driver). */
export const WEATHER_MIN_MILES = 10;
export const WEATHER_MIN_KM = 16;
/** Wet drives with this many times the dry drives' events per mile, or more, get the "slow down" line. */
export const WEATHER_WORSE_RATIO = 1.5;

export interface WeatherSide {
  drives: number;
  miles: number;
  /** Speeding, hard brakes, hard starts, sharp turns and pickups (the trend's events). */
  events: number;
}

export interface WeatherSums {
  /** Drives in rain, snow or ice. */
  wet: WeatherSide;
  /** Drives in the clear. */
  dry: WeatherSide;
}

/**
 * Every scored drive with a weather word, all time: rain, snow and ice are wet, clear is dry. A drive
 * with no word (older, restored, offline) is in neither.
 */
export function weatherSums(drives: readonly LocalDrive[]): WeatherSums {
  const side = (): WeatherSide => ({ drives: 0, miles: 0, events: 0 });
  const out: WeatherSums = { wet: side(), dry: side() };
  for (const d of scoredSince(drives, null)) {
    if (!d.weather) continue;
    const s = d.weather === 'clear' ? out.dry : out.wet;
    s.drives += 1;
    s.miles += Number.isFinite(d.miles) ? Math.max(0, d.miles) : 0;
    s.events += d.counts.speeding + d.counts.hardBrake + d.counts.hardAccel + d.counts.hardCorner + d.counts.pickups;
  }
  return out;
}

export type WeatherCommentKind = 'worse' | 'smooth' | 'bumpier';

export interface WeatherView {
  kind: WeatherCommentKind;
  /** Wet events per mile over dry, rounded to 1 decimal; null when the dry drives had no events (only on `worse`). */
  ratio: number | null;
}

/**
 * What the card says, or null when either side has under 10 mi (16 km for a km driver). First
 * match: wet events per mile at 1.5× the dry or more (or any wet events against none in the dry),
 * then wet at or under dry, else a little bumpier.
 */
export function weatherView(s: WeatherSums, units: Units): WeatherView | null {
  const min = units === 'km' ? WEATHER_MIN_KM / KM_PER_MILE : WEATHER_MIN_MILES;
  if (s.wet.miles < min || s.dry.miles < min) return null;
  // Cross-multiplied, so an exact 1.5× reads as 1.5 (0.3 / 0.2 in floats is 1.4999…).
  const wet = s.wet.events * s.dry.miles;
  const dry = s.dry.events * s.wet.miles;
  if (wet <= dry) return { kind: 'smooth', ratio: null };
  if (dry === 0) return { kind: 'worse', ratio: null };
  const ratio = wet / dry;
  return ratio >= WEATHER_WORSE_RATIO ? { kind: 'worse', ratio: Math.round(ratio * 10) / 10 } : { kind: 'bumpier', ratio: null };
}
