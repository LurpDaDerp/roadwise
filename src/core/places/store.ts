/**
 * The saved places as the drive labels and the place-arrival read them, from this phone's database:
 * the places (`places.saved`) and where the driver usually parks at each (`placeAnchor`, from the
 * phone's own drive ends of the last 183 days). Nothing here writes.
 */
import { createSettingsRepo, type Db } from '@/data/db';
import type { LatLng } from '@/lib/geo';

import { ANCHOR_DAYS, placeAnchors } from './match';
import { parsePlaces, PLACES_KEY, type SavedPlace } from './saved';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A saved place with where the driver usually parks there (null: no anchor yet). */
export interface AnchoredPlace extends SavedPlace {
  anchor: LatLng | null;
}

export async function readSavedPlaces(db: Db): Promise<SavedPlace[]> {
  return parsePlaces(await createSettingsRepo(db).get<unknown>(PLACES_KEY));
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Where this phone's kept drives (pending, scored, unscored or failed: never one still recording or
 * a passenger ride) of the last `ANCHOR_DAYS` days ended: the 5 dp end (`end_lat_full`), else the
 * 4 dp one on a drive recorded before it was kept. A restored or archived drive has no end point
 * and is skipped.
 */
export async function readPlaceEnds(db: Db, now: number): Promise<LatLng[]> {
  const { rows } = await db.execute(
    `SELECT COALESCE(end_lat_full, end_lat) AS end_lat, COALESCE(end_lng_full, end_lng) AS end_lng
       FROM trips
      WHERE status IN ('pending', 'scored', 'unscored', 'failed') AND archived_at IS NULL
        AND end_lat IS NOT NULL AND end_lng IS NOT NULL AND ended_at IS NOT NULL AND ended_at >= ?`,
    [now - ANCHOR_DAYS * DAY_MS]
  );
  const out: LatLng[] = [];
  for (const r of rows) if (finite(r.end_lat) && finite(r.end_lng)) out.push({ lat: r.end_lat, lng: r.end_lng });
  return out;
}

/** The saved places with their anchors. The ends failing to read leaves the places without anchors. */
export async function readAnchoredPlaces(db: Db, now: number): Promise<AnchoredPlace[]> {
  const places = await readSavedPlaces(db);
  if (places.length === 0) return [];
  const ends = await readPlaceEnds(db, now).catch((): LatLng[] => []);
  const anchors = placeAnchors(places, ends);
  return places.map((p) => ({ ...p, anchor: anchors.get(p.id) ?? null }));
}
