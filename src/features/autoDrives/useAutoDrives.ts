/**
 * Whether drives start on their own on this phone, for the screens to word themselves by (iPhone
 * only; ui.md §4.1): `on`, `off` with what is missing in display order, `disabled` (the Automatic
 * drives switch in Settings is off), `unsupported` (Android, or an iPhone that can't run it) or
 * `unknown` (not read yet, or the read failed). Read from the native auto-detect status
 * (`readAutoDetectStatus`, the boot package's), again whenever a screen that uses it comes into
 * focus, when RoadWise returns to the front and when the switch changes; never on a timer.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { readAutoDetectStatus, setAutoDetectEnabled } from './port';

export type AutoDrivesMissing = 'locationAlways' | 'precise' | 'motion' | 'backgroundRefresh';
export type AutoDrives =
  | { state: 'unsupported' }
  | { state: 'on' }
  | { state: 'off'; missing: readonly AutoDrivesMissing[] }
  /** Switched off in Settings (this phone's choice): a drive records only from the Start drive swipe. */
  | { state: 'disabled' }
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
 * The screens' reading of the native status. `disabled` when the Automatic drives switch is off
 * (whatever is missing: nothing needs fixing for drives that are off by choice). `on` when armed and
 * sensing; otherwise what is missing, from the native list and the permissions themselves (so a
 * phone not yet armed still says what it needs); `unknown` when nothing is missing but drives are
 * not on yet (arming follows on the next foreground). Null (Android, Jest, a failed read) and an
 * iPhone that can't run it are `unsupported`.
 */
export function autoDrivesFrom(status: AutoDetectStatus | undefined): AutoDrives {
  if (status === null || status === undefined) return { state: 'unsupported' };
  if (status.status === 'unavailable') return { state: 'unsupported' };
  if (status.enabled === false) return { state: 'disabled' };
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
// Reads in flight can land out of order: only the latest started one that has landed stands.
let started = 0;
let landed = 0;
// Every mounted reader, told when the switch changes the reading (a screen behind Settings too).
const readers = new Set<(next: AutoDrives) => void>();

/** Reads the status once (never rejects); resolves with the newest reading that has landed. */
export async function readAutoDrives(): Promise<AutoDrives> {
  const mine = ++started;
  let next: AutoDrives;
  try {
    next = autoDrivesFrom(await readAutoDetectStatus());
  } catch {
    next = { state: 'unknown' };
  }
  if (mine > landed) {
    landed = mine;
    last = next;
  }
  return last;
}

/**
 * The Automatic drives switch (Settings): stores the choice and arms or disarms
 * (`setAutoDetectEnabled`; a drive recording meanwhile finishes), then reads the status again for
 * every mounted screen. Resolves with the new reading; never rejects.
 */
export async function setAutoDrivesEnabled(on: boolean): Promise<AutoDrives> {
  try {
    await setAutoDetectEnabled(on);
  } catch {
    // it never rejects; the reading below says where things stand either way
  }
  const next = await readAutoDrives();
  for (const fn of [...readers]) fn(next);
  return next;
}

/** Forgets the last reading (tests, sign-out). */
export function resetAutoDrivesForTests(): void {
  last = { state: 'unknown' };
  started = 0;
  landed = 0;
}

const same = (a: AutoDrives, b: AutoDrives): boolean =>
  a.state === b.state && (a.state !== 'off' || b.state !== 'off' || a.missing.join() === b.missing.join());

export function useAutoDrives(): AutoDrives {
  const [value, setValue] = useState<AutoDrives>(last);
  const alive = useRef(true);
  const take = useCallback((next: AutoDrives) => {
    if (alive.current) setValue((prev) => (same(prev, next) ? prev : next));
  }, []);
  const reread = useCallback(() => {
    void readAutoDrives().then(take);
  }, [take]);
  useEffect(() => {
    alive.current = true;
    readers.add(take);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') reread();
    });
    return () => {
      alive.current = false;
      readers.delete(take);
      sub.remove();
    };
  }, [reread, take]);
  useFocusEffect(reread);
  return value;
}
