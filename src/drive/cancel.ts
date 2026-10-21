// "Not driving?" finished across a kill (modes plan §3.6; review M1). The host writes a marker
// before it tells native and deletes the trip, and clears it last; a launch that finds one finishes
// the cancel before any drive is recovered, so a cancelled drive is never recorded again.
import type { DriveDetectApi } from '@drive-sense';

import { dropTrip } from '@/core/engine/finalize';
import { createSettingsRepo, type Db } from '@/data/db';

import { NOT_DRIVING_KEY } from './notDriving';

/**
 * A "Not driving?" under way (settings): written first, cleared last, so a process killed between
 * telling native and deleting the trip finishes the cancel at the next launch (`finishPendingCancel`)
 * instead of recording the drive again. `driveId`: native's journal (iOS; it differs from the trip
 * for a re-opened drive), else null.
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

/**
 * At a launch, before any drive is recovered: a "Not driving?" the last process did not finish is
 * finished. Native is told first (iOS: the drive still recording is cancelled, an ended journal
 * deleted), then the trip goes whole, then the marker. Returns the cancelled trip's id, or null
 * when nothing was pending. Rejects (the marker kept for the next launch) when the trip cannot be
 * deleted.
 */
export async function finishPendingCancel(db: Db, detect: DriveDetectApi | null, onError?: (e: unknown, ctx: string) => void): Promise<string | null> {
  const settings = createSettingsRepo(db);
  const c = parseCancel(await settings.get<unknown>(CANCEL_KEY));
  if (c === null) return null;
  if (detect !== null && detect.available && c.driveId !== null) {
    try {
      const state = await detect.getState();
      if ((state.state === 'recording' || state.state === 'ending') && state.driveId === c.driveId) await detect.notDriving();
      else await detect.discardDrive(c.driveId);
    } catch (e) {
      onError?.(e, 'notDriving');
    }
  }
  await dropTrip(db, c.clientTripId);
  await settings.remove(NOT_DRIVING_KEY).catch((e: unknown) => onError?.(e, 'notDriving'));
  await settings.remove(CANCEL_KEY);
  return c.clientTripId;
}
