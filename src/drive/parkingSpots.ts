// The known parking spots a drive may end at (`core/engine/motion.ts`): where the latest kept
// drives ended, and the saved places. Read once as a drive opens; nothing here writes.
import { PARK_SPOTS_MAX, type Spot } from '@/core/engine/motion';
import { createSettingsRepo, type Db } from '@/data/db';
import { readPlaces } from '@/features/places/model';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The ends of the latest `PARK_SPOTS_MAX` kept drives (pending, scored, unscored or failed: never
 * one still recording or a passenger ride), newest first. A drive with no end point (none
 * recorded, or archived) is skipped.
 */
export async function readDriveEnds(db: Db): Promise<Spot[]> {
  const { rows } = await db.execute(
    `SELECT end_lat, end_lng
       FROM trips
      WHERE status IN ('pending', 'scored', 'unscored', 'failed') AND end_lat IS NOT NULL AND end_lng IS NOT NULL
      ORDER BY ended_at DESC
      LIMIT ?`,
    [PARK_SPOTS_MAX]
  );
  const out: Spot[] = [];
  for (const r of rows) if (finite(r.end_lat) && finite(r.end_lng)) out.push({ lat: r.end_lat, lng: r.end_lng });
  return out;
}

/**
 * The drive ends and the saved places. Either read failing leaves the other; `onError` hears of it.
 */
export async function readParkingSpots(db: Db, onError?: (e: unknown) => void): Promise<Spot[]> {
  const ends = await readDriveEnds(db).catch((e: unknown) => {
    onError?.(e);
    return [] as Spot[];
  });
  const places = await readPlaces(createSettingsRepo(db)).catch((e: unknown) => {
    onError?.(e);
    return [];
  });
  return [...ends, ...places.map((p) => ({ lat: p.lat, lng: p.lng }))];
}
