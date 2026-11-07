/**
 * The practice log's reads and writes on the phone's database: the drives that may be in the log,
 * one drive's supervisor, the finalize dependency that stamps a new practice drive with the saved
 * supervisor, and the night minutes kept before the archive. Local only: none of it is ever uploaded.
 * Each supervisor written to a row is copied to the kept map (`notes.ts`) as well.
 */
import { archiveCutoff } from '@/data/db/archive';
import { createSettingsRepo } from '@/data/db/settings';
import type { Db } from '@/data/db/driver';
import { createTripsRepo } from '@/data/db/trips';
import { toListedDrive, toTripView, TRIP_VIEW, type LocalDrive } from '@/data/queries/rows';

import { isKeptDrive } from './log';
import { nightByRule } from './night';
import { addNightNotes, writeSupervisorNote, type NightByRule } from './notes';
import { cleanName, readPermit } from './prefs';

const DAY_MS = 86_400_000;

/**
 * The drives that may be practice drives from `startDay` on: kept kinds started from two days before
 * it (a drive's own day is read in its own time zone, so the log's filter, `isPracticeDrive`, makes
 * the final cut). Archived drives are in: their hours still count. Newest first.
 */
export async function readPracticeCandidates(db: Db, startDay: string): Promise<LocalDrive[]> {
  const [y, m, d] = startDay.split('-').map(Number);
  const from = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime() - 2 * DAY_MS;
  const { rows } = await db.execute(
    `SELECT ${TRIP_VIEW} FROM trips t WHERE t.status NOT IN ('recording', 'not_driving') AND t.started_at >= ? ORDER BY t.started_at DESC, t.client_trip_id ASC`,
    [Number.isFinite(from) ? from : 0]
  );
  return rows.map((row) => toListedDrive(toTripView(row)));
}

/** Set (or clear, with an empty name) one drive's supervisor, on its row and in the kept map. False when the drive isn't on this phone. */
export async function writeDriveSupervisor(db: Db, clientTripId: string, name: string, now: number = Date.now()): Promise<boolean> {
  const clean = cleanName(name);
  const row = await createTripsRepo(db).update(clientTripId, { practice_supervisor: clean }, now);
  if (row === null) return false;
  await writeSupervisorNote(createSettingsRepo(db), clientTripId, clean);
  return true;
}

/**
 * The finalize dependency (both finalize call sites spread it, like DashPal's): the saved supervisor
 * for a drive that starts in the log (Permit mode on, on or after the log's first day), else null.
 */
export function permitFinalizeDeps(db: Db): { practiceSupervisor: (trip: { clientTripId: string; localDay: string }) => Promise<string | null> } {
  return {
    practiceSupervisor: async ({ clientTripId, localDay }) => {
      const settings = createSettingsRepo(db);
      const prefs = await readPermit(settings);
      if (!prefs.enabled || prefs.startDay === null || localDay < prefs.startDay || prefs.supervisor === null) return null;
      // The kept copy; a failure here still stamps the row.
      await writeSupervisorNote(settings, clientTripId, prefs.supervisor).catch(() => undefined);
      return prefs.supervisor;
    },
  };
}

/**
 * Before the 183-day archive clears where drives went (call it with the archive's own `now`): keep
 * each due, kept drive's night minutes under every rule, so its day and night split survives. Only
 * once Permit mode has been turned on (it has a start day); every due drive then, since the start
 * day can be moved earlier. Returns how many drives were added.
 */
export async function keepArchivedNight(db: Db, now: number): Promise<number> {
  const settings = createSettingsRepo(db);
  if ((await readPermit(settings)).startDay === null) return 0;
  const { rows } = await db.execute(
    `SELECT ${TRIP_VIEW} FROM trips t WHERE t.archived_at IS NULL AND t.ended_at IS NOT NULL AND t.ended_at < ? AND t.status NOT IN ('recording', 'not_driving')`,
    [archiveCutoff(now)]
  );
  const entries: Record<string, NightByRule> = {};
  for (const drive of rows.map((row) => toListedDrive(toTripView(row)))) {
    if (!isKeptDrive(drive)) continue;
    const night = nightByRule(drive);
    if (night !== null) entries[drive.clientTripId] = night;
  }
  return Object.keys(entries).length === 0 ? 0 : addNightNotes(settings, entries);
}
