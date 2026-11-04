// "Where you parked" (iPhone with the car link): the spot the drive host stores when the paired car
// left the route with the car stopped and the driver then walked away (`src/drive/parkedWatch.ts`),
// and Home's rules for its card. Pure, but for the settings read and a tiny process-local signal the
// host raises when it stores or clears a spot, so a Home already on screen shows it at once.
import type { Db } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';

/** Settings: the parked spot (cleared at sign-out). */
export const PARKED_KEY = 'parked.spot';
/** The card goes this long after the car parked. */
export const PARKED_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

export interface ParkedSpot {
  lat: number;
  lng: number;
  /** When the car last moved (the drive's end, epoch ms). */
  parkedAt: number;
  /** The drive's end label (a place name, a street, a district), or null. */
  label: string | null;
  /** The drive it parked at the end of. */
  driveId: string;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseParkedSpot(raw: unknown): ParkedSpot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!finite(r.lat) || !finite(r.lng) || !finite(r.parkedAt) || typeof r.driveId !== 'string' || r.driveId === '') return null;
  if (Math.abs(r.lat) > 90 || Math.abs(r.lng) > 180) return null;
  const label = typeof r.label === 'string' && r.label.trim() !== '' ? r.label.trim() : null;
  return { lat: r.lat, lng: r.lng, parkedAt: r.parkedAt, label, driveId: r.driveId };
}

/** The spot is too old to show (3 days), or dated in the future by more than a minute (a wrong clock). */
export const parkedExpired = (spot: ParkedSpot, now: number): boolean => now - spot.parkedAt > PARKED_MAX_AGE_MS || spot.parkedAt - now > 60_000;

export async function readParkedSpot(db: Db): Promise<ParkedSpot | null> {
  return parseParkedSpot(await createSettingsRepo(db).get<unknown>(PARKED_KEY));
}

export async function writeParkedSpot(db: Db, spot: ParkedSpot): Promise<void> {
  await createSettingsRepo(db).set(PARKED_KEY, spot);
  parkedChanged();
}

export async function clearParkedSpot(db: Db): Promise<void> {
  await createSettingsRepo(db).remove(PARKED_KEY);
  parkedChanged();
}

/**
 * A drive kept after the car parked (one stored at a launch, which the host never saw, included):
 * the car has moved since, so the spot no longer holds. A read that fails says no.
 */
export async function keptDriveSince(db: Db, spot: ParkedSpot): Promise<boolean> {
  try {
    const { rows } = await db.execute(
      `SELECT 1 AS hit FROM trips WHERE client_trip_id <> ? AND started_at > ? AND status IN ('pending', 'scored', 'unscored', 'failed') LIMIT 1`,
      [spot.driveId, spot.parkedAt]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

/** The stored spot changed (stored, or cleared): Home reads it again. */
export function parkedChanged(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // A listener that throws must not keep the others from hearing it.
    }
  }
}

export function onParkedChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
