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

/**
 * A posted limit in whole km/h, for every place a limit shows in kilometres (never a speed).
 * Limits travel as whole mph, so a road posted 30 km/h arrives as 19 mph, which is 30.6 km/h:
 * plain rounding would put 31 on a 30 sign. A whole mph that a round km/h posting is stored as
 * shows that posting: the nearest multiple of 10 km/h when it is stored as this same mph (19 → 30,
 * 43 → 70, 68 → 110, 75 → 120), else, for a limit that is not a multiple of 5 mph (so never a US
 * one), the nearest multiple of 5 km/h the same way (9 → 15, 47 → 75). Anything else converts
 * plainly (35 mph → 56). Of the US limits only 75 mph reads off its plain 121, as 120, since 120
 * km/h is stored as 75 mph too; 65 km/h is stored as 40 mph, a common US limit, so it keeps 64.
 */
export function limitKmh(mph: number): number {
  const kmh = mph * KMH_PER_MPH;
  // How the server stores a km/h posting (supabase/functions/speed-limits/overpass.ts).
  const storedAs = (posted: number) => Math.round(posted / KMH_PER_MPH) === mph;
  const tens = Math.round(kmh / 10) * 10;
  if (storedAs(tens)) return tens;
  const fives = Math.round(kmh / 5) * 5;
  if (mph % 5 !== 0 && storedAs(fives)) return fives;
  return Math.round(kmh);
}

/** A posted limit in the driver's units, whole: mph rounded, km/h through `limitKmh`; null stays null. */
export const limitIn = (mph: number | null, units: Units): number | null =>
  mph === null ? null : units === 'km' ? limitKmh(mph) : Math.round(mph);

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
