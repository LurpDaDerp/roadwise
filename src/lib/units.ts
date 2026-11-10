export const MPH_PER_MPS = 2.2369362920544;
export const METERS_PER_MILE = 1609.344;
export const mpsToMph = (mps: number) => mps * MPH_PER_MPS;
export const mphToMps = (mph: number) => mph / MPH_PER_MPS;
export const metersToMiles = (m: number) => m / METERS_PER_MILE;
export const kmhToMph = (kmh: number) => kmh * 0.621371192237334;
export const KMH_PER_MPH = 1.609344;

// ── Display units (the driver's mi/km setting) ───────────────────────────────────────────

/** The driver's distance units: `profiles.units`, mirrored locally under the `units` setting. */
export type Units = 'mi' | 'km';
export const KM_PER_MILE = 1.609344;

/** A distance in miles, in the driver's units. */
export const distanceIn = (miles: number, units: Units): number => (units === 'km' ? miles * KM_PER_MILE : miles);

/** "mi" / "km". */
export const distanceUnit = (units: Units): Units => units;

/** "miles" / "kilometers", for a screen reader. */
export const distanceWord = (units: Units): string => (units === 'km' ? 'kilometers' : 'miles');

/**
 * The one distance formatter: "12.3 mi" / "19.8 km". `digits` 0 rounds to a whole number with
 * thousands separators ("1,204 km"); `spoken` says the unit in words.
 */
export function formatDistance(miles: number, units: Units, opts: { digits?: 0 | 1; spoken?: boolean } = {}): string {
  const v = distanceIn(miles, units);
  const digits = opts.digits ?? 1;
  const n = digits === 0 ? Math.round(v).toLocaleString('en-US') : (Math.round(v * 10) / 10).toFixed(1);
  return `${n} ${opts.spoken ? distanceWord(units) : distanceUnit(units)}`;
}

/**
 * Progress toward a distance in the driver's units, whole numbers: "12/25 mi" or "19/40 km".
 * `done` is floored and capped at the target, and stays below it until the real distance is
 * reached, so it never reads as reached early (10 mi rounds to "16 km": 16.04 km reads "15/16 km").
 */
export function formatDistanceProgress(doneMiles: number, targetMiles: number, units: Units): { done: number; target: number; text: string } {
  const target = Math.round(distanceIn(targetMiles, units));
  const floored = Math.floor(distanceIn(Math.max(0, doneMiles), units));
  const done = Math.min(doneMiles >= targetMiles ? target : Math.max(0, target - 1), floored);
  return { done, target, text: `${done}/${target} ${units}` };
}
