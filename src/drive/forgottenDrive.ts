// The optional forgot-to-start reminder (spec "Starting and ending a drive"; plan §6). Off by
// default. Android: native posts a quiet notification after a car trip with nothing recorded. iOS:
// on each app foreground with the setting on, `checkForgottenDrive` is asked for the latest
// automotive stretch since the last check; one that overlaps no recorded drive is shown on Home as
// a one-line dismissible notice. Nothing here ever starts a drive.
import DriveSense, { type ForgottenDrive } from '@drive-sense';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';

/** Settings key (WP9's toggle writes it; default false). */
export const FORGOT_TO_START_KEY = 'reminder.forgotToStart';
/** Settings key: epoch ms of the last iOS check, so each stretch is offered once. */
export const FORGOTTEN_CHECKED_AT_KEY = 'reminder.forgottenCheckedAt';
/** The first check looks back this far. */
export const FIRST_LOOKBACK_MS = 24 * 60 * 60_000;

export interface ForgottenDriveDeps {
  setForgotToStartReminder?: (enabled: boolean) => Promise<void>;
  checkForgottenDrive?: (sinceMs: number) => Promise<ForgottenDrive | null>;
}

/** Apply the setting natively. WP9's toggle calls it after writing the setting; boot applies the stored value. */
export async function applyForgotToStartSetting(enabled: boolean, deps: ForgottenDriveDeps = {}): Promise<void> {
  const set = deps.setForgotToStartReminder ?? ((on: boolean) => DriveSense.setForgotToStartReminder(on));
  try {
    await set(enabled);
  } catch {
    // Never rejects natively; a missing module (Jest, web) is nothing to apply to.
  }
}

/** Read the stored setting and apply it (boot). */
export async function applyStoredForgotToStartSetting(db: Db, deps: ForgottenDriveDeps = {}): Promise<boolean> {
  const enabled = (await createSettingsRepo(db).get<boolean>(FORGOT_TO_START_KEY)) === true;
  await applyForgotToStartSetting(enabled, deps);
  return enabled;
}

/** Whether `d` overlaps a drive this device recorded. */
export async function overlapsRecordedDrive(db: Db, d: ForgottenDrive): Promise<boolean> {
  const { rows } = await db.execute(
    'SELECT 1 FROM trips WHERE started_at <= ? AND COALESCE(ended_at, started_at + 43200000) >= ? LIMIT 1',
    [d.endedAt, d.startedAt]
  );
  return rows.length > 0;
}

/**
 * One iOS check: the latest confident car trip since the last check that no recorded drive covers,
 * or null. Moves the check mark either way, so the same stretch is never offered twice.
 */
export async function checkForgottenDrive(db: Db, now: number, deps: ForgottenDriveDeps = {}): Promise<ForgottenDrive | null> {
  const settings = createSettingsRepo(db);
  if ((await settings.get<boolean>(FORGOT_TO_START_KEY)) !== true) return null;
  const since = (await settings.get<number>(FORGOTTEN_CHECKED_AT_KEY)) ?? now - FIRST_LOOKBACK_MS;
  const check = deps.checkForgottenDrive ?? ((ms: number) => DriveSense.checkForgottenDrive(ms));
  let found: ForgottenDrive | null = null;
  try {
    found = await check(since);
  } catch {
    found = null;
  }
  await settings.set(FORGOTTEN_CHECKED_AT_KEY, now);
  if (found === null || (await overlapsRecordedDrive(db, found))) return null;
  return found;
}

export interface ForgottenDriveNotice {
  startedAt: number;
  endedAt: number;
  dismiss(): void;
}

/** Home's one-line notice (iOS): checked on mount and on every foreground; null when nothing to say. */
export function useForgottenDriveNotice(deps: ForgottenDriveDeps & { os?: string; now?: () => number } = {}): ForgottenDriveNotice | null {
  const db = useDb();
  const [found, setFound] = useState<ForgottenDrive | null>(null);
  const os = deps.os ?? Platform.OS;
  const now = deps.now ?? Date.now;

  useEffect(() => {
    if (os !== 'ios') return;
    let live = true;
    const run = () => {
      void checkForgottenDrive(db, now(), deps)
        .then((d) => {
          if (live && d !== null) setFound(d);
        })
        .catch(() => {});
    };
    run();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => {
      live = false;
      sub.remove();
    };
    // `deps` is a seam object; callers pass a stable one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, os]);

  const dismiss = useCallback(() => setFound(null), []);
  return found === null ? null : { startedAt: found.startedAt, endedAt: found.endedAt, dismiss };
}
