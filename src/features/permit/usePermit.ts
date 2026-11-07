/**
 * Permit mode for the screens: its settings (read once and kept in the query cache), the practice
 * log built from the phone's drives (under the `drives` root, so every drive change refreshes it),
 * and the writes, each settling the cache.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { useDataSource, useDb } from '@/data/queries/context';
import { invalidateDrive } from '@/data/queries/invalidate';
import type { LocalDrive } from '@/data/queries/rows';

import { readPracticeCandidates, writeDriveSupervisor } from './data';
import { isPracticeDrive, nightRuleOf, permitState, practiceLog, supervisorOf, wholeMinutes, type PracticeLog } from './log';
import { practiceMinutes, type PracticeMinutes } from './night';
import { readPracticeNotes } from './notes';
import { readPermit, type PermitPrefs } from './prefs';

export const PERMIT_QUERY = ['permit', 'prefs'] as const;
/** The log's drives from a start day on, with what was kept beside them (under `drives`: a drive change refreshes it). */
export const practiceDrivesKey = (startDay: string) => ['drives', 'practice', startDay] as const;
/** The kept per-drive supervisors and night minutes alone, for the recap (under `drives` too). */
export const PRACTICE_NOTES_KEY = ['drives', 'practice-notes'] as const;

/** Permit mode's settings and a way to change them (`write` runs a settings write, then rereads). */
export function usePermitPrefs() {
  const db = useDb();
  const client = useQueryClient();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const query = useQuery({ queryKey: PERMIT_QUERY, queryFn: () => readPermit(settings) });

  const write = useCallback(
    async (fn: (settings: SettingsRepo) => Promise<void>): Promise<boolean> => {
      try {
        await fn(settings);
        client.setQueryData(PERMIT_QUERY, await readPermit(settings));
        return true;
      } catch {
        return false;
      }
    },
    [client, settings]
  );

  return { prefs: query.data, write };
}

/** The practice log under `prefs` (empty while Permit mode is off or has no start day). */
export function usePracticeLog(prefs: PermitPrefs | undefined): { log: PracticeLog | undefined; loading: boolean } {
  const { db } = useDataSource();
  const startDay = prefs?.enabled ? prefs.startDay : null;
  const query = useQuery({
    queryKey: practiceDrivesKey(startDay ?? ''),
    queryFn: async () => {
      const [drives, notes] = await Promise.all([readPracticeCandidates(db, startDay ?? ''), readPracticeNotes(createSettingsRepo(db))]);
      return { drives, notes };
    },
    enabled: startDay !== null,
  });
  const log = useMemo(() => (prefs && query.data ? practiceLog(query.data.drives, prefs, query.data.notes) : undefined), [prefs, query.data]);
  return { log: startDay === null ? undefined : log, loading: startDay !== null && query.isLoading };
}

/** What the recap shows for a practice drive. */
export interface PracticeDriveView extends PracticeMinutes {
  /** The drive's own supervisor, else the saved one; null when neither is set. */
  supervisor: string | null;
}

/** The recap's practice row for `drive`, or null when it isn't in the log; and the per-drive supervisor write. */
export function usePracticeDrive(drive: LocalDrive) {
  const db = useDb();
  const client = useQueryClient();
  const { prefs } = usePermitPrefs();
  const inLog = !!prefs && drive.archived !== true && isPracticeDrive(drive, prefs);
  // The kept supervisor matters only when the row has none (a drive restored after a sign-out).
  const notes = useQuery({
    queryKey: PRACTICE_NOTES_KEY,
    queryFn: () => readPracticeNotes(createSettingsRepo(db)),
    enabled: inLog && drive.practiceSupervisor == null,
  });
  const view = useMemo((): PracticeDriveView | null => {
    if (!prefs || !inLog) return null;
    const minutes = wholeMinutes(practiceMinutes(drive, nightRuleOf(permitState(prefs))));
    return { ...minutes, supervisor: supervisorOf(drive, prefs, notes.data) };
  }, [drive, prefs, inLog, notes.data]);

  const setSupervisor = useCallback(
    async (name: string): Promise<boolean> => {
      try {
        const ok = await writeDriveSupervisor(db, drive.clientTripId, name);
        await invalidateDrive(client, drive.clientTripId);
        return ok;
      } catch {
        return false;
      }
    },
    [client, db, drive.clientTripId]
  );

  return { practice: view, setSupervisor };
}

