// What a drive's screen-switch rules need to survive a relaunch or a rebuild (design §6.4): the
// switch signal and lock delay fixed at the Start tap, and the navigation button's exemption in
// progress. One device setting, overwritten by the next drive. The exemption stamps already on the
// stored rows need nothing here: they replay as they were.
import type { PhoneSwitchCtx, SwitchSignal } from '@/core/detectors/phoneSwitch';
import type { Db } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';

export const PHONE_SWITCH_KEY = 'drive.phoneSwitch';

/** The navigation button's exemption: since which row (row clock; null before the next row), and whether RoadWise has left. */
export interface LeaveState {
  sinceRowTs: number | null;
  left: boolean;
}

export interface StoredPhoneSwitch {
  clientTripId: string;
  signal: SwitchSignal;
  lockDelayMs: number | null;
  leave: LeaveState | null;
}

const SIGNALS: ReadonlySet<unknown> = new Set<SwitchSignal>(['reliable', 'lagged', 'unproven', 'none']);
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The stored value if it is one, else null (a value this build cannot read charges nothing). */
export function parseStoredPhoneSwitch(raw: unknown): StoredPhoneSwitch | null {
  if (raw === null || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.clientTripId !== 'string' || !SIGNALS.has(v.signal)) return null;
  if (v.lockDelayMs !== null && !isMs(v.lockDelayMs)) return null;
  let leave: LeaveState | null = null;
  if (v.leave !== null && v.leave !== undefined) {
    const l = v.leave as Record<string, unknown>;
    if (typeof l !== 'object' || typeof l.left !== 'boolean' || (l.sinceRowTs !== null && !isMs(l.sinceRowTs))) return null;
    leave = { sinceRowTs: l.sinceRowTs as number | null, left: l.left };
  }
  return { clientTripId: v.clientTripId, signal: v.signal as SwitchSignal, lockDelayMs: v.lockDelayMs as number | null, leave };
}

export async function readPhoneSwitch(db: Db): Promise<StoredPhoneSwitch | null> {
  return parseStoredPhoneSwitch(await createSettingsRepo(db).get<unknown>(PHONE_SWITCH_KEY));
}

export async function writePhoneSwitch(db: Db, value: StoredPhoneSwitch): Promise<void> {
  await createSettingsRepo(db).set(PHONE_SWITCH_KEY, value);
}

/**
 * The rebuild's reader (`RebuildDeps.phoneSwitch`): the drive's own signal and delay, or null when
 * the key belongs to another drive or cannot be read (the rebuild then counts no switch).
 */
export async function phoneSwitchFor(db: Db, clientTripId: string): Promise<PhoneSwitchCtx | null> {
  const stored = await readPhoneSwitch(db);
  return stored !== null && stored.clientTripId === clientTripId ? { signal: stored.signal, lockDelayMs: stored.lockDelayMs } : null;
}
