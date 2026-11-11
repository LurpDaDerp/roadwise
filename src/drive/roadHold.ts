// The road state a drive's rows are stamped with (`FeatureRow.road`), from the weather watch's
// reading at each row (`WeatherWatch.roadAt`). The reading already holds a burst for a step and wants
// fog to stand for two (`src/features/weather/road.ts`); on top of it, for cell borders and model
// runs that disagree, the stamped state tightens at once and eases only after an easier state has
// been read for 5 minutes of row time. Grip and sight ease apart. An unknown reading (null: no
// serving answer) is no easier state that has been read: the normal lines apply at once.
import { isRoadGrip, isSightCap, roadStricter, tighterCap, worseGrip, type RoadStamp } from '@/core/road';

/** An easier grip or a looser cap is taken up once it has been read for this long (row time). */
export const ROAD_EASE_MS = 5 * 60_000;

export interface RoadHold {
  /** The state rows are stamped with: `{}` for a normal road. */
  road: RoadStamp;
  /** Since when (row time) an easier grip has been read; null while it is not. */
  gripSince: number | null;
  /** Since when (row time) a looser cap (or none) has been read; null while it is not. */
  capSince: number | null;
}

/** A drive opens on a normal road. */
export const NORMAL_ROAD: RoadHold = Object.freeze({ road: Object.freeze({}), gripSince: null, capSince: null });

/** True when the state moves any warning line (a grip or a sight cap). */
export const roadTightened = (road: RoadStamp | null | undefined): road is RoadStamp => isRoadGrip(road?.g) || isSightCap(road?.cap);

/** The hold after a row at `ts` whose reading is `read` (null: unknown). Pure. */
export function nextRoadHold(prev: RoadHold, read: RoadStamp | null, ts: number): RoadHold {
  if (read === null) return NORMAL_ROAD;
  let g = read.g;
  let gripSince: number | null = null;
  if (roadStricter({ g: prev.road.g }, { g })) {
    gripSince = prev.gripSince ?? ts;
    if (ts - gripSince < ROAD_EASE_MS) g = prev.road.g;
    else gripSince = null;
  }
  let cap = read.cap;
  let capSince: number | null = null;
  if (roadStricter({ cap: prev.road.cap }, { cap })) {
    capSince = prev.capSince ?? ts;
    if (ts - capSince < ROAD_EASE_MS) cap = prev.road.cap;
    else capSince = null;
  }
  const road: RoadStamp = {};
  if (isRoadGrip(g)) road.g = g;
  if (isSightCap(cap)) road.cap = cap;
  return { road, gripSince, capSince };
}

/** The stricter of two states in each part: the worse grip and the tighter cap (null reads as normal). */
export function strictestRoad(a: RoadStamp | null, b: RoadStamp): RoadStamp {
  const road: RoadStamp = {};
  const g = worseGrip(a?.g, b.g);
  const cap = tighterCap(a?.cap, b.cap);
  if (g !== undefined) road.g = g;
  if (cap !== undefined) road.cap = cap;
  return road;
}
