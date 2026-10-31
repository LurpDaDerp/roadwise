/**
 * The saved places for the screens: read once and kept in the query cache (a sign-out clears it),
 * saved and removed through here so the privacy zone made from a place follows it. A place that
 * moves takes its zone along (the zone keeps its size) and a renamed one renames it; removing a
 * place keeps its zone, unlinked, so a route near it never shows by surprise.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { requestSpotRecompute } from '@/features/spots/recompute';
import { readZones, writeZones, ZONE_NAME_MAX, type PrivacyZone } from '@/features/settings/privacyZones';

import { PLACES_CARD_DISMISSED_KEY, readPlaces, withPlace, writePlaces, type SavedPlace } from './model';

export const PLACES_QUERY = ['places', 'saved'] as const;
export const PLACES_CARD_QUERY = ['places', 'card'] as const;

/** The zones once `place` is saved: its zone (if it has one) moved and renamed with it; null when nothing changes. */
export function zonesFollowing(zones: readonly PrivacyZone[], place: SavedPlace): PrivacyZone[] | null {
  let changed = false;
  const next = zones.map((z) => {
    if (z.placeId !== place.id) return z;
    const name = place.name.trim().slice(0, ZONE_NAME_MAX);
    if (z.lat === place.lat && z.lng === place.lng && z.name === name) return z;
    changed = true;
    return { ...z, lat: place.lat, lng: place.lng, name };
  });
  return changed ? next : null;
}

/** The zones once the place `placeId` is gone: its zone stays, no longer tied to it; null when nothing changes. */
export function zonesUnlinked(zones: readonly PrivacyZone[], placeId: string): PrivacyZone[] | null {
  if (!zones.some((z) => z.placeId === placeId)) return null;
  return zones.map((z) => {
    if (z.placeId !== placeId) return z;
    const { placeId: _gone, ...rest } = z;
    return rest;
  });
}

/** Save `place` (new, or replacing the one with its id), and move its zone with it. */
export async function savePlace(settings: SettingsRepo, place: SavedPlace): Promise<SavedPlace[]> {
  const next = withPlace(await readPlaces(settings), place);
  await writePlaces(settings, next);
  const zones = zonesFollowing(await readZones(settings), place);
  if (zones) {
    await writeZones(settings, zones);
    requestSpotRecompute();
  }
  return readPlaces(settings);
}

/** Remove the place `id`; its zone stays, unlinked. */
export async function removePlace(settings: SettingsRepo, id: string): Promise<SavedPlace[]> {
  const next = (await readPlaces(settings)).filter((p) => p.id !== id);
  await writePlaces(settings, next);
  const zones = zonesUnlinked(await readZones(settings), id);
  if (zones) await writeZones(settings, zones);
  return next;
}

export function usePlaces() {
  const db = useDb();
  const client = useQueryClient();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const query = useQuery({ queryKey: PLACES_QUERY, queryFn: () => readPlaces(settings) });

  const settle = useCallback(
    (places: SavedPlace[]) => {
      client.setQueryData(PLACES_QUERY, places);
      void client.invalidateQueries({ queryKey: PLACES_CARD_QUERY });
      void client.invalidateQueries({ queryKey: ['places', 'suggestions'] });
    },
    [client]
  );

  const save = useCallback(
    async (place: SavedPlace): Promise<boolean> => {
      try {
        settle(await savePlace(settings, place));
        return true;
      } catch {
        return false;
      }
    },
    [settings, settle]
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        settle(await removePlace(settings, id));
        return true;
      } catch {
        return false;
      }
    },
    [settings, settle]
  );

  return { places: query.data, loading: query.isLoading, save, remove };
}

/** Whether Home shows "Add your places": no place saved and the card not closed with Not now. */
export async function readPlacesCard(settings: Pick<SettingsRepo, 'get'>): Promise<boolean> {
  const [places, dismissed] = await Promise.all([readPlaces(settings), settings.get<boolean>(PLACES_CARD_DISMISSED_KEY)]);
  return places.length === 0 && dismissed !== true;
}

export function usePlacesCard() {
  const db = useDb();
  const client = useQueryClient();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const query = useQuery({ queryKey: PLACES_CARD_QUERY, queryFn: () => readPlacesCard(settings) });
  const dismiss = useCallback(() => {
    client.setQueryData(PLACES_CARD_QUERY, false);
    void settings.set(PLACES_CARD_DISMISSED_KEY, true).catch(() => {});
  }, [client, settings]);
  return { show: query.data === true, dismiss, refetch: query.refetch };
}
