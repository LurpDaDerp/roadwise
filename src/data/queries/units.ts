/**
 * The driver's mi/km choice for display, read from the local mirror of `profiles.units` (the
 * `units` setting). One shared value: Settings publishes a change and every mounted screen
 * re-renders, and Home / Settings bring the mirror in line with the server on load.
 */
import { useEffect, useSyncExternalStore } from 'react';

import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { useOptionalDb } from '@/data/queries/context';
import type { Units } from '@/lib/units';

export const UNITS_KEY = 'units';

let current: Units | null = null;
const listeners = new Set<() => void>();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => current;

/** Tell every screen the units changed (after the mirror is written). */
export function publishUnits(units: Units): void {
  if (current === units) return;
  current = units;
  for (const l of [...listeners]) l();
}

export const parseUnits = (v: unknown): Units => (v === 'km' ? 'km' : 'mi');

/** The driver's units; miles until the mirror has been read. */
export function useUnits(): Units {
  const db = useOptionalDb();
  const units = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (!db) return;
    let live = true;
    createSettingsRepo(db)
      .get<unknown>(UNITS_KEY)
      .then((v) => {
        if (live) publishUnits(parseUnits(v));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [db]);
  return units ?? 'mi';
}

/**
 * Bring the local mirror in line with the server's `profiles.units` (another phone changed it,
 * or this is a fresh install). Writes only on a difference.
 */
export function useUnitsFromServer(serverUnits: Units | undefined, settings?: Pick<SettingsRepo, 'get' | 'set'>): void {
  const db = useOptionalDb();
  useEffect(() => {
    if (!serverUnits) return;
    const repo = settings ?? (db ? createSettingsRepo(db) : null);
    if (!repo) return;
    let live = true;
    repo
      .get<unknown>(UNITS_KEY)
      .then(async (v) => {
        if (parseUnits(v) === serverUnits && v !== null) {
          if (live) publishUnits(serverUnits);
          return;
        }
        await repo.set(UNITS_KEY, serverUnits);
        if (live) publishUnits(serverUnits);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [serverUnits, settings, db]);
}

/** Tests only: forget the shared value. */
export function resetUnitsForTests(): void {
  current = null;
}
