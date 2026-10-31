/**
 * Address lookup for saved places, with no key and no account:
 *
 * - **As you type:** Photon (photon.komoot.io), komoot's free search over OpenStreetMap, built for
 *   search-as-you-type. Only the typed text goes, with the phone's last known position rounded to
 *   0.1° (about 10 km, the same as the weather service gets) so nearby addresses come first.
 *   Asked at most once per pause in typing (`SEARCH_DEBOUNCE_MS`), from 3 characters, and the last
 *   answers are remembered, to stay within Photon's fair use.
 * - **Exact address:** the phone's own geocoder (Apple's on iPhone), for an address OpenStreetMap
 *   has no house number for. Asked only on a tap.
 * - **Address of a point:** the phone's reverse geocoder, the channel drive labels already use.
 */
import type { LatLng } from '@/lib/geo';

export const PHOTON_URL = 'https://photon.komoot.io/api/';
export const MIN_QUERY = 3;
export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_TIMEOUT_MS = 6000;
export const SEARCH_LIMIT = 6;
const CACHE_SIZE = 30;

/** An address to pick: two lines and the point. */
export interface AddressHit {
  id: string;
  /** "123 Main St", or a place's name ("Roosevelt High School"). */
  title: string;
  /** "Seattle, WA 98104", or the street and city under a named place. */
  subtitle: string;
  lat: number;
  lng: number;
}

export type SearchResult = { ok: true; hits: AddressHit[] } | { ok: false };

/** A position rounded to 0.1° (about 10 km): enough to rank nearby addresses first, no more. */
export const coarse = (p: LatLng): LatLng => ({ lat: Math.round(p.lat * 10) / 10, lng: Math.round(p.lng * 10) / 10 });

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const join = (...parts: string[]): string => parts.filter((s) => s !== '').join(', ');

/** One Photon feature as two lines; null when it has no point or nothing to call it. */
export function hitFromPhoton(feature: unknown): AddressHit | null {
  if (typeof feature !== 'object' || feature === null) return null;
  const f = feature as { properties?: Record<string, unknown>; geometry?: { coordinates?: unknown } };
  const coords = f.geometry?.coordinates;
  if (!Array.isArray(coords) || typeof coords[0] !== 'number' || typeof coords[1] !== 'number') return null;
  const [lng, lat] = coords as [number, number];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const p = f.properties ?? {};
  const street = text(p.street);
  const number = text(p.housenumber);
  const name = text(p.name);
  const city = text(p.city) || text(p.town) || text(p.village) || text(p.locality) || text(p.district) || text(p.county);
  const region = text(p.state);
  const postcode = text(p.postcode);
  const streetLine = number && street ? `${number} ${street}` : street;
  const area = join(city, [region, postcode].filter((s) => s !== '').join(' '));
  const country = text(p.countrycode).toUpperCase();
  const areaWithCountry = country && country !== 'US' ? join(area, text(p.country)) : area;
  // A named place (a school, an office) reads by its name, with its street under it.
  const title = name && name !== streetLine ? name : streetLine || name || city;
  if (title === '') return null;
  const subtitle = title === streetLine ? areaWithCountry : join(title === name ? streetLine : '', areaWithCountry);
  return { id: `${text(p.osm_type)}${String(p.osm_id ?? '')}-${lat.toFixed(5)},${lng.toFixed(5)}`, title, subtitle, lat, lng };
}

/** Photon's answer as hits, duplicates (same two lines) dropped. */
export function hitsFromPhoton(body: unknown): AddressHit[] {
  const features = typeof body === 'object' && body !== null ? (body as { features?: unknown }).features : null;
  if (!Array.isArray(features)) return [];
  const seen = new Set<string>();
  const out: AddressHit[] = [];
  for (const f of features) {
    const hit = hitFromPhoton(f);
    if (hit === null) continue;
    const key = `${hit.title}|${hit.subtitle}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

export function photonUrl(query: string, near: LatLng | null): string {
  const params = [`q=${encodeURIComponent(query)}`, `limit=${SEARCH_LIMIT}`, 'lang=en'];
  if (near) {
    const c = coarse(near);
    params.push(`lat=${c.lat}`, `lon=${c.lng}`, 'zoom=10', 'location_bias_scale=0.1');
  }
  return `${PHOTON_URL}?${params.join('&')}`;
}

export type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const cache = new Map<string, AddressHit[]>();

/** Test seam: forget remembered answers. */
export function clearSearchCache(): void {
  cache.clear();
}

/**
 * Addresses matching `query`, nearest `near` first. Never throws: a failure, a timeout or a
 * cancelled search is `{ ok: false }` (a cancelled one is simply dropped by the caller).
 */
export async function searchAddresses(query: string, near: LatLng | null, opts: { signal?: AbortSignal; fetch?: Fetch } = {}): Promise<SearchResult> {
  const q = query.trim().replace(/\s+/g, ' ');
  if (q.length < MIN_QUERY) return { ok: true, hits: [] };
  const url = photonUrl(q, near);
  const remembered = cache.get(url);
  if (remembered) return { ok: true, hits: remembered };
  const doFetch: Fetch = opts.fetch ?? ((u, init) => fetch(u, init));
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), SEARCH_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  opts.signal?.addEventListener('abort', onAbort);
  try {
    const res = await doFetch(url, { signal: timeout.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false };
    const hits = hitsFromPhoton(await res.json());
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    cache.set(url, hits);
    return { ok: true, hits };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

type GeoAddress = {
  name?: string | null;
  streetNumber?: string | null;
  street?: string | null;
  city?: string | null;
  district?: string | null;
  subregion?: string | null;
  region?: string | null;
  postalCode?: string | null;
  isoCountryCode?: string | null;
  country?: string | null;
};

/** The phone geocoder's address as two lines; null when it says nothing usable. */
export function linesFromGeo(a: GeoAddress | undefined | null): { title: string; subtitle: string } | null {
  if (!a) return null;
  const number = text(a.streetNumber);
  const street = text(a.street);
  const name = text(a.name);
  const streetLine = number && street ? `${number} ${street}` : street;
  const title = streetLine || name;
  if (title === '') return null;
  const country = text(a.isoCountryCode).toUpperCase();
  const area = join(text(a.city) || text(a.district) || text(a.subregion), [text(a.region), text(a.postalCode)].filter((s) => s !== '').join(' '));
  return { title, subtitle: country && country !== 'US' ? join(area, text(a.country)) : area };
}

/** The address at a point from the phone's reverse geocoder; null on any failure. Never throws. */
export async function addressAt(point: LatLng): Promise<{ title: string; subtitle: string } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const Location = require('expo-location') as typeof import('expo-location');
    const results = await Location.reverseGeocodeAsync({ latitude: point.lat, longitude: point.lng });
    return linesFromGeo(results[0]);
  } catch {
    return null;
  }
}

/**
 * The typed address through the phone's own geocoder (Apple's on iPhone): its point, and the
 * address read back at that point. Null when it finds nothing. Never throws.
 */
export async function lookUpExact(query: string): Promise<AddressHit | null> {
  const q = query.trim();
  if (q.length < MIN_QUERY) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const Location = require('expo-location') as typeof import('expo-location');
    const found = await Location.geocodeAsync(q);
    const first = found[0];
    if (!first || !Number.isFinite(first.latitude) || !Number.isFinite(first.longitude)) return null;
    const point = { lat: first.latitude, lng: first.longitude };
    const lines = (await addressAt(point)) ?? { title: q, subtitle: '' };
    return { id: `exact-${point.lat.toFixed(5)},${point.lng.toFixed(5)}`, ...lines, ...point };
  } catch {
    return null;
  }
}

/**
 * A position the phone already has (never a prompt, never a GPS fix of its own), for ranking
 * nearby addresses first. Null without location access or a recent fix.
 */
export async function searchBias(): Promise<LatLng | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const Location = require('expo-location') as typeof import('expo-location');
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm?.granted) return null;
    const pos = await Location.getLastKnownPositionAsync({ maxAge: 7 * 24 * 60 * 60_000 });
    return pos ? coarse({ lat: pos.coords.latitude, lng: pos.coords.longitude }) : null;
  } catch {
    return null;
  }
}
