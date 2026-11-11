// The road state a row carries: the grip (wet, water, snow, ice) and the sight cap from visibility,
// as the drive's weather reading puts them on the row, and the weather lines they set. The lines
// only warn sooner (the weather "Slow down" and hard brake, start and turn warnings,
// `detectors/weatherSpeeding.ts` and the alert-only harsh detector); scoring never reads them, so
// the events, the points and the upload are the dry lines' whatever the weather. No state (absent,
// null or empty) is a dry road in clear air: the normal lines, exactly.
//
// The factors sit at the mild end of the published ranges (FHWA road-weather speed reductions: 3 to
// 16 % in rain, 5 to 40 % in heavy snow), because the input is a 3 km weather model, not a road
// sensor.

import { HARD_ACCEL_G, HARD_BRAKE_G, HARD_CORNER_G } from '@scoring';

/** The road's grip, mildest first: a wet film, heavy rain or pooling water, snow, ice. */
export type RoadGrip = 'wet' | 'water' | 'snow' | 'ice';
/** The speed cap (mph) low visibility puts on the judged limit. */
export type SightCapMph = 35 | 45 | 55 | 65;
/**
 * The condition a weather warning names (the banner's icon and colour): a grip, or `fog` when low
 * visibility set the lower speeding limit.
 */
export type RoadCondition = RoadGrip | 'fog';
/** The road state a row carries: either part absent is normal for that part. */
export interface RoadStamp {
  g?: RoadGrip;
  cap?: SightCapMph;
}
/** The three hard-event types, the ones whose warning lines grip lowers. */
export type HardEventType = 'hard_brake' | 'hard_accel' | 'hard_corner';
/** A hard event's minor and severe lines, in g. */
export type HardLines = Readonly<{ minor: number; severe: number }>;

/** The grips from mildest to worst. */
export const ROAD_GRIPS: readonly RoadGrip[] = ['wet', 'water', 'snow', 'ice'];
/** The sight caps from loosest to tightest (mph). */
export const SIGHT_CAPS_MPH: readonly SightCapMph[] = [65, 55, 45, 35];

/** The posted limit's share (%) a grip leaves for speeding: wet 90, water 85, snow 80, ice 70. */
export const SPEED_FACTOR_PCT: Readonly<Record<RoadGrip, number>> = { wet: 90, water: 85, snow: 80, ice: 70 };

/** The dry lines: the normal hard-event lines. */
export const HARD_LINES_DRY_G: Readonly<Record<HardEventType, HardLines>> = {
  hard_brake: HARD_BRAKE_G,
  hard_accel: HARD_ACCEL_G,
  hard_corner: HARD_CORNER_G,
};
/** The lines on a wet road or in heavy rain (the dry lines × 0.90, written out). */
export const HARD_LINES_WET_G: Readonly<Record<HardEventType, HardLines>> = {
  hard_brake: { minor: 0.32, severe: 0.5 },
  hard_accel: { minor: 0.36, severe: 0.54 },
  hard_corner: { minor: 0.43, severe: 0.63 },
};
/**
 * The lines on snow or ice (the dry lines × 0.80, written out). Ice has no lower line than snow: a
 * car on real ice cannot reach 0.2 g, so a lower line would only fire where the road is not icy.
 */
export const HARD_LINES_SNOW_G: Readonly<Record<HardEventType, HardLines>> = {
  hard_brake: { minor: 0.29, severe: 0.44 },
  hard_accel: { minor: 0.32, severe: 0.48 },
  hard_corner: { minor: 0.38, severe: 0.56 },
};
/** True for one of the four grips (a stored row's `road.g` is read through this). */
export function isRoadGrip(v: unknown): v is RoadGrip {
  return v === 'wet' || v === 'water' || v === 'snow' || v === 'ice';
}

/** True for one of the four sight caps (a stored row's `road.cap` is read through this). */
export function isSightCap(v: unknown): v is SightCapMph {
  return v === 35 || v === 45 || v === 55 || v === 65;
}

/**
 * The limit the weather "Slow down" warns at (mph; the halo's tint starts there too): min(posted ×
 * the grip's factor, the sight cap). With no grip and no cap (or an unknown one) it is `limitMph`
 * itself. A cap at or above the limit changes nothing, so fog does nothing on a 25 mph street. The
 * warning's line runs on this limit (`speedingLine`); the sign keeps the posted one, and speeding
 * itself (the event, its tier, the points) is always judged at the posted limit.
 */
export function judgedLimitMph(limitMph: number, road?: RoadStamp | null): number {
  let judged = limitMph;
  const g = road?.g;
  if (isRoadGrip(g)) judged = (limitMph * SPEED_FACTOR_PCT[g]) / 100;
  const cap = road?.cap;
  if (isSightCap(cap) && cap < judged) judged = cap;
  return judged;
}

/**
 * The condition that set the judged limit (`judgedLimitMph`) below `limitMph`: `fog` when the sight
 * cap is the lower of the two, else the grip; null when the road state leaves the limit as it is
 * (no state, an unknown one, or a cap at or above the limit).
 */
export function speedingCondition(limitMph: number, road?: RoadStamp | null): RoadCondition | null {
  const g = road?.g;
  const byGrip = isRoadGrip(g) ? (limitMph * SPEED_FACTOR_PCT[g]) / 100 : limitMph;
  const cap = road?.cap;
  if (isSightCap(cap) && cap < byGrip) return 'fog';
  return isRoadGrip(g) && byGrip < limitMph ? g : null;
}

/**
 * A hard event's warning lines for the road's grip: wet and water the wet lines, snow and ice the
 * snow lines, no grip (or an unknown one) the dry lines. Sight never changes them. The hard events
 * themselves are always judged at the dry lines.
 */
export function hardLines(type: HardEventType, g?: RoadGrip | null): HardLines {
  if (g === 'wet' || g === 'water') return HARD_LINES_WET_G[type];
  if (g === 'snow' || g === 'ice') return HARD_LINES_SNOW_G[type];
  return HARD_LINES_DRY_G[type];
}

/** The grip's place from mildest: -1 for none (dry), 0 wet … 3 ice. */
function gripRank(g: RoadGrip | null | undefined): number {
  return isRoadGrip(g) ? ROAD_GRIPS.indexOf(g) : -1;
}

/** The cap's place from loosest: -1 for none, 0 for 65 … 3 for 35. */
function capRank(cap: SightCapMph | null | undefined): number {
  return isSightCap(cap) ? SIGHT_CAPS_MPH.indexOf(cap) : -1;
}

/** The worse of two grips; undefined when neither is a grip. */
export function worseGrip(a: RoadGrip | null | undefined, b: RoadGrip | null | undefined): RoadGrip | undefined {
  const r = Math.max(gripRank(a), gripRank(b));
  return r < 0 ? undefined : ROAD_GRIPS[r];
}

/** The tighter of two sight caps; undefined when neither is a cap. */
export function tighterCap(a: SightCapMph | null | undefined, b: SightCapMph | null | undefined): SightCapMph | undefined {
  const r = Math.max(capRank(a), capRank(b));
  return r < 0 ? undefined : SIGHT_CAPS_MPH[r];
}

/** True when `a` is stricter than `b` in grip or in sight (absent and null read as normal). */
export function roadStricter(a: RoadStamp | null | undefined, b: RoadStamp | null | undefined): boolean {
  return gripRank(a?.g) > gripRank(b?.g) || capRank(a?.cap) > capRank(b?.cap);
}

/** True when the two states judge alike: the same grip and the same cap (absent and null read as normal). */
export function sameRoad(a: RoadStamp | null | undefined, b: RoadStamp | null | undefined): boolean {
  return gripRank(a?.g) === gripRank(b?.g) && capRank(a?.cap) === capRank(b?.cap);
}
