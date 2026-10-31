/**
 * The places learned from this phone's drives (`src/core/places/learn.ts`), as suggestions with an
 * address. The drives' raw start and end points are read here and nowhere else; the learning runs
 * on the phone when a place field opens, and its result is never stored or uploaded.
 *
 * Addresses come from the phone's reverse geocoder (the channel drive labels use), one at a time,
 * and are remembered under `places.names` so a field opens with them next time. A learned place
 * inside a privacy zone is never looked up on its own: it shows as that zone until the driver
 * picks it.
 */
import { useQuery } from '@tanstack/react-query';

import { learnPlaces, suggestionsFor, type LearnedPlace, type PlaceSlot, type TripEnds } from '@/core/places/learn';
import type { Db } from '@/data/db/driver';
import { asNumber, asText } from '@/data/db/row';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { useDataSource } from '@/data/queries/context';
import { readZones, type PrivacyZone } from '@/features/settings/privacyZones';
import { haversineMeters, type LatLng } from '@/lib/geo';

import { PLACE_NAMES_KEY } from './model';
import { addressAt } from './search';

const DAY_MS = 86_400_000;
/** The phone keeps a drive's start and end this long. */
export const LEARN_WINDOW_DAYS = 183;
const MAX_TRIPS = 4000;
const NAME_NEAR_M = 60;
const MAX_NAMES = 40;

/** Every drive's raw ends in the window, oldest first; "Not driving" ones too (you were still there). */
export async function readTripEnds(db: Db, now: number): Promise<TripEnds[]> {
  const { rows } = await db.execute(
    `SELECT client_trip_id, started_at, ended_at, tz, start_lat, start_lng, end_lat, end_lng
       FROM trips
      WHERE status IN ('scored', 'unscored', 'pending', 'not_driving') AND ended_at IS NOT NULL AND started_at >= ?
      ORDER BY started_at ASC
      LIMIT ?`,
    [now - LEARN_WINDOW_DAYS * DAY_MS, MAX_TRIPS]
  );
  const point = (lat: unknown, lng: unknown): LatLng | null =>
    typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  return rows.map((r) => ({
    id: asText(r, 'client_trip_id'),
    startedAt: asNumber(r, 'started_at'),
    endedAt: asNumber(r, 'ended_at'),
    tz: typeof r.tz === 'string' ? r.tz : '',
    start: point(r.start_lat, r.start_lng),
    end: point(r.end_lat, r.end_lng),
  }));
}

interface NameEntry {
  lat: number;
  lng: number;
  title: string;
  subtitle: string;
}

async function readNames(settings: Pick<SettingsRepo, 'get'>): Promise<NameEntry[]> {
  const raw = await settings.get<unknown>(PLACE_NAMES_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is NameEntry =>
      typeof e === 'object' && e !== null && typeof (e as NameEntry).lat === 'number' && typeof (e as NameEntry).lng === 'number' && typeof (e as NameEntry).title === 'string' && typeof (e as NameEntry).subtitle === 'string'
  );
}

/** A learned place offered in a field: where it is, what it's called, and why it's offered. */
export interface Suggestion {
  place: LearnedPlace;
  /** The address, or null when it couldn't be looked up. */
  title: string | null;
  subtitle: string;
  /** The privacy zone it lies in: no address was looked up for it. */
  zone: PrivacyZone | null;
}

const zoneFor = (p: LatLng, zones: readonly PrivacyZone[]) => zones.find((z) => haversineMeters(p, z) <= z.radiusM) ?? null;

/**
 * Addresses for `places`: remembered ones first, the rest from `lookup` one at a time (none for a
 * place in a zone). New ones are remembered, newest first.
 */
export async function nameSuggestions(
  settings: Pick<SettingsRepo, 'get' | 'set'>,
  places: readonly LearnedPlace[],
  zones: readonly PrivacyZone[],
  lookup: (p: LatLng) => Promise<{ title: string; subtitle: string } | null> = addressAt
): Promise<Suggestion[]> {
  const names = await readNames(settings);
  const fresh: NameEntry[] = [];
  const out: Suggestion[] = [];
  for (const place of places) {
    const zone = zoneFor(place.center, zones);
    if (zone) {
      out.push({ place, title: null, subtitle: '', zone });
      continue;
    }
    const known = [...fresh, ...names].find((n) => haversineMeters(n, place.center) <= NAME_NEAR_M);
    if (known) {
      out.push({ place, title: known.title, subtitle: known.subtitle, zone: null });
      continue;
    }
    const found = await lookup(place.center);
    if (found) fresh.push({ lat: Math.round(place.center.lat * 1e5) / 1e5, lng: Math.round(place.center.lng * 1e5) / 1e5, ...found });
    out.push({ place, title: found?.title ?? null, subtitle: found?.subtitle ?? '', zone: null });
  }
  if (fresh.length > 0) await settings.set(PLACE_NAMES_KEY, [...fresh, ...names].slice(0, MAX_NAMES)).catch(() => {});
  return out;
}

export const LEARNED_QUERY = ['places', 'learned'] as const;

/** The learned places, worked out once per field opening (cached five minutes). */
export function useLearnedPlaces(enabled = true) {
  const { db, now } = useDataSource();
  return useQuery({
    queryKey: LEARNED_QUERY,
    queryFn: async () => {
      const t = now();
      return learnPlaces(await readTripEnds(db, t), t);
    },
    staleTime: 5 * 60_000,
    enabled,
  });
}

/**
 * The suggestions for one field, with addresses: `slot`'s best learned places that aren't
 * already saved (`taken`). Undefined while they load.
 */
export function useSuggestions(slot: PlaceSlot, taken: readonly LatLng[], enabled = true) {
  const { db } = useDataSource();
  const learned = useLearnedPlaces(enabled);
  const picks = learned.data ? suggestionsFor(slot, learned.data, taken) : null;
  const key = picks?.map((p) => p.id).join('|') ?? '';
  return useQuery({
    queryKey: ['places', 'suggestions', slot, key],
    queryFn: async () => {
      const settings = createSettingsRepo(db);
      return nameSuggestions(settings, picks ?? [], await readZones(settings).catch(() => []));
    },
    enabled: enabled && picks !== null,
    staleTime: 5 * 60_000,
  });
}
