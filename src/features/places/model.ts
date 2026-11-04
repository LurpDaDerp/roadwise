/**
 * Saved places: Home, Work and School (one each) and up to 7 more of the driver's own, each an
 * address and the point it stands for. Stored only on this phone, under `places.saved`, like the
 * privacy zones; a sign-out removes them. The stored shape and its read are core's
 * (`core/places/saved.ts`): the drive labels read the same list.
 */
import { ADDRESS_MAX, FIXED_KINDS, MAX_CUSTOM_PLACES, parsePlaces, PLACES_KEY, placeProblem, sortPlaces, type PlaceKind, type PlaceProblem, type SavedPlace } from '@/core/places/saved';
import type { SettingsRepo } from '@/data/db/settings';

export {
  ADDRESS_MAX,
  FIXED_KINDS,
  MAX_CUSTOM_PLACES,
  PLACE_NAME_MAX,
  PLACES_KEY,
  placeProblem,
  sortPlaces,
  type FixedKind,
  type PlaceKind,
  type PlaceProblem,
  type SavedPlace,
} from '@/core/places/saved';

/** Addresses already looked up for learned places (`learned.ts`). */
export const PLACE_NAMES_KEY = 'places.names';
/** The recap's "Save as …?" card was turned off (Don't remind me, or the switch in Places). */
export const PROMPT_OFF_KEY = 'places.promptOff';
/** The points the driver said No to on that card (they're never asked about again). */
export const PROMPT_DECLINED_KEY = 'places.promptDeclined';

export const FIXED_NAME: Record<(typeof FIXED_KINDS)[number], string> = { home: 'Home', work: 'Work', school: 'School' };

/** The stored places; anything malformed, a second Home and customs past the cap are skipped. */
export async function readPlaces(settings: Pick<SettingsRepo, 'get'>): Promise<SavedPlace[]> {
  return parsePlaces(await settings.get<unknown>(PLACES_KEY));
}

/** What is wrong with the whole list, or null. */
export function placesProblem(places: readonly SavedPlace[]): PlaceProblem | null {
  if (places.filter((p) => p.kind === 'custom').length > MAX_CUSTOM_PLACES) return 'too_many';
  for (const kind of FIXED_KINDS) if (places.filter((p) => p.kind === kind).length > 1) return 'too_many';
  for (const p of places) {
    const problem = placeProblem(p);
    if (problem) return problem;
  }
  return null;
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** An address part as stored: trimmed and clipped, '' as null; absent stays absent (read from the address line). */
const part = (key: 'number' | 'street', v: string | null | undefined): Partial<Pick<SavedPlace, 'number' | 'street'>> => {
  if (v === undefined) return {};
  const s = v === null ? '' : clip(v.trim(), ADDRESS_MAX);
  return { [key]: s === '' ? null : s };
};

/** Saves the list, trimmed. Rejects (writing nothing) when it breaks a rule. */
export async function writePlaces(settings: Pick<SettingsRepo, 'set'>, places: readonly SavedPlace[]): Promise<void> {
  const problem = placesProblem(places);
  if (problem) throw new Error(`places: ${problem}`);
  await settings.set(
    PLACES_KEY,
    sortPlaces(places).map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name.trim(),
      address: clip(p.address.trim(), ADDRESS_MAX),
      area: clip(p.area.trim(), ADDRESS_MAX),
      lat: p.lat,
      lng: p.lng,
      ...part('number', p.number),
      ...part('street', p.street),
      ...(p.unknownAddress === true ? { unknownAddress: true } : {}),
    }))
  );
}

/** The list with `place` in it: replacing the one with its id, or added. */
export function withPlace(places: readonly SavedPlace[], place: SavedPlace): SavedPlace[] {
  return places.some((p) => p.id === place.id) ? places.map((p) => (p.id === place.id ? place : p)) : [...places, place];
}

/** A new id for one of the driver's own places. */
export function newPlaceId(now: number = Date.now()): string {
  return `place-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The id a place of `kind` gets: the kind itself for Home, Work and School. */
export const idFor = (kind: PlaceKind, now?: number): string => (kind === 'custom' ? newPlaceId(now) : kind);
