// "Not driving?" finished across a kill (modes plan §3.6; review M1). The host writes a marker
// before it tells native and deletes the trip, and clears it last; a launch that finds one finishes
// the cancel before any drive is recovered (`finishPendingCancel` in host.ts, the one place that
// tells native "Not driving?"), so a cancelled drive is never recorded again.
import { createSettingsRepo, type Db } from '@/data/db';

/**
 * A "Not driving?" under way (settings): written first, cleared last, so a process killed between
 * telling native and deleting the trip finishes the cancel at the next launch (host's `finishPendingCancel`)
 * instead of recording the drive again. `driveId`: native's journal (iOS; a drive begun under an
 * older build may have one that differs from the trip), else null.
 */
export const CANCEL_KEY = 'drive.cancelling';

export interface PendingCancel {
  clientTripId: string;
  driveId: string | null;
}

export async function writeCancelMarker(db: Db, c: PendingCancel): Promise<void> {
  await createSettingsRepo(db).set(CANCEL_KEY, c);
}

export async function clearCancelMarker(db: Db): Promise<void> {
  await createSettingsRepo(db).remove(CANCEL_KEY);
}

function parseCancel(raw: unknown): PendingCancel | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.clientTripId !== 'string' || r.clientTripId.length === 0) return null;
  return { clientTripId: r.clientTripId, driveId: typeof r.driveId === 'string' && r.driveId.length > 0 ? r.driveId : null };
}

/** The pending cancel, or null when none (or not one). */
export async function readCancelMarker(db: Db): Promise<PendingCancel | null> {
  return parseCancel(await createSettingsRepo(db).get<unknown>(CANCEL_KEY));
}
