/**
 * Saved places: Home, Work and School (one each) and up to 7 more of the driver's own, each an
 * address and the point it stands for. Stored only on this phone, under `places.saved`, like the
 * privacy zones; a sign-out removes them.
 */
import type { SettingsRepo } from '@/data/db/settings';

export const PLACES_KEY = 'places.saved';
/** Home's "Add your places" card was closed with Not now. */
export const PLACES_CARD_DISMISSED_KEY = 'places.cardDismissed';
/** Addresses already looked up for learned places (`learned.ts`). */
export const PLACE_NAMES_KEY = 'places.names';

export type PlaceKind = 'home' | 'work' | 'school' | 'custom';
export const FIXED_KINDS = ['home', 'work', 'school'] as const satisfies readonly PlaceKind[];
export type FixedKind = (typeof FIXED_KINDS)[number];

export const MAX_CUSTOM_PLACES = 7;
export const PLACE_NAME_MAX = 20;
export const ADDRESS_MAX = 120;

export const FIXED_NAME: Record<FixedKind, string> = { home: 'Home', work: 'Work', school: 'School' };

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

/** Home, Work, School, then the driver's own in the order added. */
export function sortPlaces(places: readonly SavedPlace[]): SavedPlace[] {
  const rank = (p: SavedPlace) => (p.kind === 'custom' ? 3 : FIXED_KINDS.indexOf(p.kind));
  return places.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(({ p }) => p);
}

/** The stored places; anything malformed, a second Home and customs past the cap are skipped. */
export async function readPlaces(settings: Pick<SettingsRepo, 'get'>): Promise<SavedPlace[]> {
  const raw = await settings.get<unknown>(PLACES_KEY);
  if (!Array.isArray(raw)) return [];
  const out: SavedPlace[] = [];
  let customs = 0;
  for (const v of raw) {
    if (!isPlace(v)) continue;
    if (v.kind !== 'custom' && out.some((p) => p.kind === v.kind)) continue;
    if (v.kind === 'custom' && ++customs > MAX_CUSTOM_PLACES) continue;
    out.push({ ...v, area: typeof v.area === 'string' ? v.area : '' });
  }
  return sortPlaces(out);
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
