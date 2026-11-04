/**
 * Which saved place a drive's end is, exactly (pure). A house a few doors down is not Home: houses
 * stand 15–30 m apart, GPS is off by 5–10 m and a place's pin can be 20–40 m from its driveway, so
 * distance alone only decides very close in. A place matches a point when any of these holds:
 *
 *   1. the point is within `PLACE_SURE_M` (20 m) of the place's point;
 *   2. it is within `PLACE_ANCHOR_M` (12 m) of where the driver usually parks there (the place's
 *      anchor, `placeAnchor`, from this phone's own drive ends);
 *   3. the place has a house number and a street, the point's reverse-geocoded address has both,
 *      they are the same address (`sameAddress`), and the point is within `PLACE_ADDRESS_MAX_M`
 *      (150 m) of the place;
 *   4. the place has no house number (a named place: a school, a store) and the point is within
 *      `PLACE_NAMED_M` (100 m) of it. A place whose address couldn't be looked up when it was saved
 *      (`addressUnknown`) has no number either but is no named place: it matches by 1 or 2 only.
 *
 * A place with a house number whose geocoded address differs never matches by 3 or 4 (it still can
 * by 1 or 2). A sure match (1 or 2) wins over a match by address or name (3 or 4), the same way a
 * sure match spares the drive's end its geocode; within each, the nearest place wins.
 */
import { haversineMeters, type LatLng } from '@/lib/geo';

import type { SavedPlace } from './saved';

/** Rule 1: this close to a place's point is that place. */
export const PLACE_SURE_M = 20;
/** Rule 2: this close to where the driver usually parks at a place is that place. */
export const PLACE_ANCHOR_M = 12;
/** Rule 3: the same house number and street, within this far of the place. */
export const PLACE_ADDRESS_MAX_M = 150;
/** Rule 4: a place with no house number (a named place) matches within this far. */
export const PLACE_NAMED_M = 100;

/** The anchor: drive ends within this far of a place's point… */
export const ANCHOR_NEAR_M = 40;
/** …at least this many of them… */
export const ANCHOR_MIN_ENDS = 4;
/** …with at least this share of them within `PLACE_ANCHOR_M` of their median. */
export const ANCHOR_SHARE = 0.75;
/** The drive ends an anchor is learned from: the phone's own, of this many days back (the route retention). */
export const ANCHOR_DAYS = 183;

/** A house number and a street; null where the source has none. */
export interface AddressParts {
  number: string | null;
  street: string | null;
}

/** What the matcher reads of a saved place: who it is, where, and its address. */
export type MatchablePlace = Pick<SavedPlace, 'id' | 'lat' | 'lng'> & Partial<Pick<SavedPlace, 'address' | 'number' | 'street' | 'unknownAddress'>>;

/** A house number then the rest ("123 Main St", "12B Baker St", "120-124 Main St"). */
const ADDRESS_LINE = /^(\d+[A-Za-z]?(?:[-–]\d+[A-Za-z]?)?)\s+(.+)$/;

/**
 * The house number and street of an address line: "123 Main St" is 123 and Main St (anything after
 * a comma is not the street); a line that doesn't start with a house number (a named place,
 * "Roosevelt High School") has neither.
 */
export function parseAddressLine(line: string | null | undefined): AddressParts {
  const m = typeof line === 'string' ? ADDRESS_LINE.exec(line.trim()) : null;
  if (!m) return { number: null, street: null };
  const street = (m[2] as string).split(',')[0]?.trim() ?? '';
  return { number: m[1] as string, street: street === '' ? null : street };
}

const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * A place's house number and street: the stored parts when the place has them (a place saved with
 * its address source's parts), else read from its address line (`parseAddressLine`).
 */
export function addressParts(place: Partial<Pick<SavedPlace, 'address' | 'number' | 'street'>>): AddressParts {
  if (place.number === undefined && place.street === undefined) return parseAddressLine(place.address);
  return { number: textOrNull(place.number), street: textOrNull(place.street) };
}

/**
 * The stand-ins the places screens save as the address when the lookup failed
 * (`features/places/copy.ts`: "Address not found", "Saved from a drive", "Inside your “Home” zone").
 */
const STAND_IN_LINES: readonly RegExp[] = [/^address not found$/i, /^saved from a drive$/i, /^inside your [“"].*[”"] zone$/i, /^in your [“"].*[”"] zone$/i];

/**
 * Whether the place's address is unknown: it was saved while the lookup failed (`unknownAddress`),
 * or, on a place saved before that was kept, its address line is one of the stand-ins (or empty).
 * Such a place has no house number, but it is no named place.
 */
export function addressUnknown(place: Partial<Pick<SavedPlace, 'address' | 'unknownAddress'>>): boolean {
  if (place.unknownAddress === true) return true;
  const line = typeof place.address === 'string' ? place.address.trim() : '';
  return line === '' || STAND_IN_LINES.some((r) => r.test(line));
}

/** A house number to compare: lowercase, no spaces, any dash a hyphen. */
export const normalizeNumber = (n: string): string => n.toLowerCase().replace(/\s+/g, '').replace(/[–—]/g, '-');

const DIGITS = /^\d+$/;
const SPAN = /^(\d+)-(\d+)$/;

/** A house-number range spans at most this much ("120-124"); a wider hyphenated number is no range. */
export const RANGE_MAX_SPAN = 20;

/**
 * A house-number range ("120-124": low first, one side of the street, so both ends odd or both
 * even, at most `RANGE_MAX_SPAN` apart) as its bounds. Anything else hyphenated is one number of its
 * own (a Queens "37-12" or "37-40", a Hawaii "94-1234"): null.
 */
function spanOf(n: string): { lo: number; hi: number } | null {
  const m = SPAN.exec(n);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  return lo < hi && hi - lo <= RANGE_MAX_SPAN && (hi - lo) % 2 === 0 ? { lo, hi } : null;
}

/** Whether the range `s` holds the plain number `n` (on its side of the street). */
const holds = (s: { lo: number; hi: number }, n: string): boolean => {
  const v = Number(n);
  return v >= s.lo && v <= s.hi && (v - s.lo) % 2 === 0;
};

/**
 * The same house number after normalising. A range holds every number on its side of the street
 * in it ("120-124" holds 122); two hyphenated numbers are the same only when they are equal.
 */
export function sameNumber(a: string, b: string): boolean {
  const x = normalizeNumber(a);
  const y = normalizeNumber(b);
  if (x === '' || y === '') return false;
  if (x === y) return true;
  if (DIGITS.test(x) && DIGITS.test(y)) return Number(x) === Number(y);
  const sx = spanOf(x);
  if (sx && DIGITS.test(y)) return holds(sx, y);
  const sy = spanOf(y);
  if (sy && DIGITS.test(x)) return holds(sy, x);
  return false;
}

/** The usual street words and their short forms (a Map: a token is never read off an object's prototype). */
const STREET_TOKENS: ReadonlyMap<string, string> = new Map([
  ['street', 'st'],
  ['avenue', 'ave'],
  ['road', 'rd'],
  ['drive', 'dr'],
  ['boulevard', 'blvd'],
  ['lane', 'ln'],
  ['court', 'ct'],
  ['place', 'pl'],
  ['terrace', 'ter'],
  ['parkway', 'pkwy'],
  ['highway', 'hwy'],
  ['circle', 'cir'],
  ['square', 'sq'],
  ['trail', 'trl'],
  ['north', 'n'],
  ['south', 's'],
  ['east', 'e'],
  ['west', 'w'],
  ['northeast', 'ne'],
  ['northwest', 'nw'],
  ['southeast', 'se'],
  ['southwest', 'sw'],
  ['first', '1st'],
  ['second', '2nd'],
  ['third', '3rd'],
  ['fourth', '4th'],
  ['fifth', '5th'],
  ['sixth', '6th'],
  ['seventh', '7th'],
  ['eighth', '8th'],
  ['ninth', '9th'],
  ['tenth', '10th'],
]);

const stripMarks = (s: string): string => {
  try {
    return s.normalize('NFKD').replace(/\p{M}/gu, '');
  } catch {
    return s;
  }
};

/**
 * A street name to compare: lowercase, accents and punctuation dropped (a dash or slash reads as a
 * space), spaces collapsed, and the usual words shortened wherever they stand ("North Main Street"
 * and "N Main St." both read "n main st").
 */
export function normalizeStreet(s: string): string {
  return stripMarks(s)
    .toLowerCase()
    .replace(/[-–—_/]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter((t) => t !== '')
    .map((t) => STREET_TOKENS.get(t) ?? t)
    .join(' ');
}

/** The same address: both have a house number and a street, and both are the same after normalising. */
export function sameAddress(a: AddressParts, b: AddressParts): boolean {
  if (a.number === null || a.street === null || b.number === null || b.street === null) return false;
  const sa = normalizeStreet(a.street);
  return sa !== '' && sa === normalizeStreet(b.street) && sameNumber(a.number, b.number);
}

export interface MatchOptions {
  /** The point's reverse-geocoded address (rule 3); null or absent: none was made. */
  address?: AddressParts | null;
  /** Where the driver usually parks at each place, by place id (rule 2). */
  anchors?: ReadonlyMap<string, LatLng>;
  /** Only rules 1 and 2 (the place-arrival's Welcome, which never geocodes or guesses by name). */
  sureOnly?: boolean;
}

const finitePoint = (p: { lat: number; lng: number }): boolean => Number.isFinite(p.lat) && Number.isFinite(p.lng);

/** Which way `place` matches `point`, and how far it is that way; null when it doesn't. */
function matchOf(point: LatLng, place: MatchablePlace, opts: MatchOptions): { sure: boolean; m: number } | null {
  if (!finitePoint(place)) return null;
  const m = haversineMeters(point, place);
  const anchor = opts.anchors?.get(place.id) ?? null;
  const anchorM = anchor !== null && finitePoint(anchor) ? haversineMeters(point, anchor) : Infinity;
  const sure = Math.min(m <= PLACE_SURE_M ? m : Infinity, anchorM <= PLACE_ANCHOR_M ? anchorM : Infinity);
  if (sure !== Infinity) return { sure: true, m: sure };
  if (opts.sureOnly === true) return null;
  const parts = addressParts(place);
  if (parts.number === null) return m <= PLACE_NAMED_M && !addressUnknown(place) ? { sure: false, m } : null;
  const address = opts.address ?? null;
  if (address !== null && m <= PLACE_ADDRESS_MAX_M && sameAddress(parts, address)) return { sure: false, m };
  return null;
}

/**
 * The saved place `point` is (the rules above), or null. Several: a sure match (1, 2) first, then the
 * nearest. Without `address` rule 3 can't hold (inside a privacy zone, where nothing is geocoded).
 */
export function matchPlace<T extends MatchablePlace>(point: LatLng | null, places: readonly T[], opts: MatchOptions = {}): T | null {
  if (point === null || !finitePoint(point)) return null;
  let best: { place: T; sure: boolean; m: number } | null = null;
  for (const place of places) {
    const hit = matchOf(point, place, opts);
    if (hit === null) continue;
    if (best === null || (hit.sure && !best.sure) || (hit.sure === best.sure && hit.m < best.m)) best = { place, ...hit };
  }
  return best?.place ?? null;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/**
 * Where the driver usually parks at `place`, from this phone's drive ends (the last 183 days): the
 * ends within `ANCHOR_NEAR_M` of its point, at least `ANCHOR_MIN_ENDS` of them, their coordinate-wise
 * median, when at least `ANCHOR_SHARE` of those ends lie within `PLACE_ANCHOR_M` of it. Only a place
 * with a house number, or one whose address is unknown (`addressUnknown`), has one (a named place
 * matches by name within 100 m anyway). Else null.
 */
export function placeAnchor(place: MatchablePlace, ends: readonly LatLng[]): LatLng | null {
  if (!finitePoint(place) || (addressParts(place).number === null && !addressUnknown(place))) return null;
  const near = ends.filter((e) => finitePoint(e) && haversineMeters(e, place) <= ANCHOR_NEAR_M);
  if (near.length < ANCHOR_MIN_ENDS) return null;
  const center = { lat: median(near.map((e) => e.lat)), lng: median(near.map((e) => e.lng)) };
  const close = near.filter((e) => haversineMeters(e, center) <= PLACE_ANCHOR_M).length;
  return close >= ANCHOR_SHARE * near.length ? center : null;
}

/** Every place's anchor that it has, by place id. */
export function placeAnchors(places: readonly MatchablePlace[], ends: readonly LatLng[]): Map<string, LatLng> {
  const out = new Map<string, LatLng>();
  for (const p of places) {
    const anchor = placeAnchor(p, ends);
    if (anchor !== null) out.set(p.id, anchor);
  }
  return out;
}
