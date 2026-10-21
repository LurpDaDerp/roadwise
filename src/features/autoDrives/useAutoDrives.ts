/**
 * Whether drives start on their own on this phone, for the screens to word themselves by (iPhone
 * only; ui.md §4.1): `on`, `off` with what is missing in display order, `unsupported` (Android, or
 * an iPhone that can't run it) or `unknown` (not read yet, or the read failed). Read from the
 * native auto-detect status (`readAutoDetectStatus`, the boot package's), again whenever a screen
 * that uses it comes into focus and when RoadWise returns to the front; never on a timer.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { readAutoDetectStatus } from './port';

export type AutoDrivesMissing = 'locationAlways' | 'precise' | 'motion' | 'backgroundRefresh';
export type AutoDrives =
  | { state: 'unsupported' }
  | { state: 'on' }
  | { state: 'off'; missing: readonly AutoDrivesMissing[] }
  | { state: 'unknown' };

export type AutoDetectStatus = Awaited<ReturnType<typeof readAutoDetectStatus>>;

/** The order Home, Settings and Permissions name what is missing in. */
export const MISSING_ORDER: readonly AutoDrivesMissing[] = ['locationAlways', 'precise', 'motion', 'backgroundRefresh'];

/** The native names of the needs the screens word (Live Activities never stop a drive). */
const FROM_NATIVE: Readonly<Record<string, AutoDrivesMissing>> = {
  locationAlways: 'locationAlways',
  locationPrecise: 'precise',
  motion: 'motion',
  backgroundRefresh: 'backgroundRefresh',
};

/**
 * The screens' reading of the native status. `on` when armed and sensing; otherwise what is missing,
 * from the native list and the permissions themselves (so a phone not yet armed still says what it
 * needs); `unknown` when nothing is missing but drives are not on yet (arming follows on the next
 * foreground). Null (Android, Jest, a failed read) and an iPhone that can't run it are `unsupported`.
 */
export function autoDrivesFrom(status: AutoDetectStatus | undefined): AutoDrives {
  if (status === null || status === undefined) return { state: 'unsupported' };
  if (status.status === 'unavailable') return { state: 'unsupported' };
  if (status.status === 'on') return { state: 'on' };
  const found = new Set<AutoDrivesMissing>();
  for (const m of status.missing ?? []) {
    const k = FROM_NATIVE[m];
    if (k) found.add(k);
  }
  const p = status.permissions;
  if (p) {
    if (p.location !== 'always') found.add('locationAlways');
    if (!p.precise) found.add('precise');
    if (p.motion === 'denied' || p.motion === 'undetermined') found.add('motion');
    if (p.backgroundRefresh === 'denied') found.add('backgroundRefresh');
  }
  const missing = MISSING_ORDER.filter((m) => found.has(m));
  return missing.length > 0 ? { state: 'off', missing } : { state: 'unknown' };
}

/** Whether a screen should use its automatic-drive words. */
export const autoDrivesOn = (a: AutoDrives): boolean => a.state === 'on';

// The last reading, so a screen that mounts later starts from it instead of `unknown`.
let last: AutoDrives = { state: 'unknown' };

/** Reads the status once (never rejects). */
export async function readAutoDrives(): Promise<AutoDrives> {
  try {
    last = autoDrivesFrom(await readAutoDetectStatus());
  } catch {
    last = { state: 'unknown' };
  }
  return last;
}

/** Forgets the last reading (tests, sign-out). */
export function resetAutoDrivesForTests(): void {
  last = { state: 'unknown' };
}

const same = (a: AutoDrives, b: AutoDrives): boolean =>
  a.state === b.state && (a.state !== 'off' || b.state !== 'off' || a.missing.join() === b.missing.join());

export function useAutoDrives(): AutoDrives {
  const [value, setValue] = useState<AutoDrives>(last);
  const alive = useRef(true);
  const reread = useCallback(() => {
    void readAutoDrives().then((next) => {
      if (alive.current) setValue((prev) => (same(prev, next) ? prev : next));
    });
  }, []);
  useEffect(() => {
    alive.current = true;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') reread();
    });
    return () => {
      alive.current = false;
      sub.remove();
    };
  }, [reread]);
  useFocusEffect(reread);
  return value;
}
