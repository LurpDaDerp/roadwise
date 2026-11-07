/**
 * What the practice log keeps per drive beside the drive's own row, in two `permit.*` settings maps
 * keyed by `clientTripId`, so it outlives what the row loses:
 * - `permit.driveSupervisors`: each practice drive's supervisor (written with the row's
 *   `practice_supervisor`). A plain sign-out deletes the drives and the restore brings them back
 *   without the column (it is never uploaded); the map is kept like the other `permit.*` keys, so
 *   the log still names who rode along.
 * - `permit.archivedNight`: a drive's night minutes under each night rule, worked out just before the
 *   183-day archive clears where it went (`keepArchivedNight`), so its day and night split stays
 *   exactly what it was.
 *
 * Both are on this phone only; the device wipe when another account signs in clears them.
 */
import type { SettingsRepo } from '@/data/db/settings';

import { cleanName } from './prefs';
import { NIGHT_RULES, type NightRule } from './states';

export const DRIVE_SUPERVISORS_KEY = 'permit.driveSupervisors';
export const ARCHIVED_NIGHT_KEY = 'permit.archivedNight';

/** A drive's night minutes under each rule. */
export type NightByRule = Record<NightRule, number>;

export interface PracticeNotes {
  supervisors: Readonly<Record<string, string>>;
  night: Readonly<Record<string, NightByRule>>;
}

export const EMPTY_NOTES: PracticeNotes = Object.freeze({ supervisors: Object.freeze({}), night: Object.freeze({}) });

const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The supervisors map, each name checked on its own. */
export function parseSupervisors(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(record(v))) {
    const clean = cleanName(name);
    if (clean !== null) out[id] = clean;
  }
  return out;
}

/** The night map: an entry needs a finite, non-negative number under every rule. */
export function parseNight(v: unknown): Record<string, NightByRule> {
  const out: Record<string, NightByRule> = {};
  for (const [id, entry] of Object.entries(record(v))) {
    const e = record(entry);
    if (NIGHT_RULES.every((r) => typeof e[r] === 'number' && Number.isFinite(e[r]) && (e[r] as number) >= 0)) {
      out[id] = Object.fromEntries(NIGHT_RULES.map((r) => [r, e[r] as number])) as NightByRule;
    }
  }
  return out;
}

/** Both maps; empty on a failed read. */
export async function readPracticeNotes(settings: SettingsRepo): Promise<PracticeNotes> {
  try {
    const raw = await settings.getMany([DRIVE_SUPERVISORS_KEY, ARCHIVED_NIGHT_KEY]);
    return { supervisors: parseSupervisors(raw[DRIVE_SUPERVISORS_KEY]), night: parseNight(raw[ARCHIVED_NIGHT_KEY]) };
  } catch {
    return EMPTY_NOTES;
  }
}

/** Set (or, with no name, forget) one drive's supervisor in the map. */
export async function writeSupervisorNote(settings: SettingsRepo, clientTripId: string, name: string | null): Promise<void> {
  const map = parseSupervisors(await settings.get<unknown>(DRIVE_SUPERVISORS_KEY));
  const clean = cleanName(name);
  if ((map[clientTripId] ?? null) === clean) return;
  if (clean === null) delete map[clientTripId];
  else map[clientTripId] = clean;
  await settings.set(DRIVE_SUPERVISORS_KEY, map);
}

/** Add drives' night minutes to the map (a drive already in it keeps its entry). Returns how many were added. */
export async function addNightNotes(settings: SettingsRepo, entries: Readonly<Record<string, NightByRule>>): Promise<number> {
  const map = parseNight(await settings.get<unknown>(ARCHIVED_NIGHT_KEY));
  let added = 0;
  for (const [id, entry] of Object.entries(entries)) {
    if (map[id] !== undefined) continue;
    map[id] = entry;
    added += 1;
  }
  if (added > 0) await settings.set(ARCHIVED_NIGHT_KEY, map);
  return added;
}
