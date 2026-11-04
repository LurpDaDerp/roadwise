/**
 * Saved places as stored: Home, Work and School (one each) and up to 7 more of the driver's own,
 * each an address and the point it stands for, under the settings key `places.saved`. The shape and
 * the lenient read live here, in core, so the drive's labels (`core/engine/finalize.ts`) and the
 * places screens (`features/places/model.ts`) read one list the same way.
 */
export const PLACES_KEY = 'places.saved';

export type PlaceKind = 'home' | 'work' | 'school' | 'custom';
export const FIXED_KINDS = ['home', 'work', 'school'] as const satisfies readonly PlaceKind[];
export type FixedKind = (typeof FIXED_KINDS)[number];

export const MAX_CUSTOM_PLACES = 7;
export const PLACE_NAME_MAX = 20;
export const ADDRESS_MAX = 120;

export interface SavedPlace {
  /** `home`, `work`, `school`, or `place-…` for the driver's own. */
  id: string;
  kind: PlaceKind;
  /** Home, Work, School, or the driver's own name for it. */
  name: string;
  /** The address as shown: "123 Main St", then the city line. */
  address: string;
  /** The second line ("Seattle, WA 98104"), or ''. */
  area: string;
  lat: number;
  lng: number;
  /**
   * The house number ("123", "120-124"), as the address source gave it; null when it has none (a
   * named place). Absent on a place saved before the parts were kept: read from `address` then
   * (`addressParts` in `match.ts`).
   */
  number?: string | null;
  /** The street ("Main St"), as the address source gave it; null when it has none. Absent: as `number`. */
  street?: string | null;
  /**
   * True when the address couldn't be looked up as the place was saved (`address` is then a stand-in
   * such as "Address not found"): no number is not a named place then. Absent otherwise.
   */
  unknownAddress?: true;
}

export type PlaceProblem = 'name_empty' | 'name_long' | 'point' | 'too_many';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** What is wrong with one place, or null. */
export function placeProblem(p: Pick<SavedPlace, 'name' | 'lat' | 'lng'>): PlaceProblem | null {
  const name = p.name.trim();
  if (name.length === 0) return 'name_empty';
  if (name.length > PLACE_NAME_MAX) return 'name_long';
  if (!finite(p.lat) || !finite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return 'point';
  return null;
}

function isPlace(v: unknown): v is SavedPlace {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    (p.kind === 'home' || p.kind === 'work' || p.kind === 'school' || p.kind === 'custom') &&
    typeof p.name === 'string' &&
    typeof p.address === 'string' &&
    placeProblem({ name: p.name, lat: p.lat as number, lng: p.lng as number }) === null
  );
}

/** A stored address part: a string (trimmed, '' read as none), null, or absent when it is neither. */
function partOf(v: unknown): { value: string | null } | null {
  if (v === null) return { value: null };
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return { value: s === '' ? null : s };
}

/** Home, Work, School, then the driver's own in the order added. */
export function sortPlaces<T extends Pick<SavedPlace, 'kind'>>(places: readonly T[]): T[] {
  const rank = (p: T) => (p.kind === 'custom' ? 3 : FIXED_KINDS.indexOf(p.kind));
  return places.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(({ p }) => p);
}

/**
 * The stored list (`places.saved`'s value), read leniently: anything malformed, a second Home (Work,
 * School) and customs past the cap are skipped; an address part of the wrong type is left out (the
 * place keeps it unknown).
 */
export function parsePlaces(raw: unknown): SavedPlace[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedPlace[] = [];
  let customs = 0;
  for (const v of raw) {
    if (!isPlace(v)) continue;
    if (v.kind !== 'custom' && out.some((p) => p.kind === v.kind)) continue;
    if (v.kind === 'custom' && ++customs > MAX_CUSTOM_PLACES) continue;
    const { number: rawNumber, street: rawStreet, unknownAddress, ...rest } = v as SavedPlace & Record<string, unknown>;
    const number = partOf(rawNumber);
    const street = partOf(rawStreet);
    out.push({
      ...rest,
      area: typeof v.area === 'string' ? v.area : '',
      ...(number ? { number: number.value } : {}),
      ...(street ? { street: street.value } : {}),
      ...(unknownAddress === true ? { unknownAddress: true as const } : {}),
    });
  }
  return sortPlaces(out);
}
