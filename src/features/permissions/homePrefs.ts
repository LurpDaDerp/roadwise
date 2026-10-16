/**
 * What Home remembers about its permission row, on this phone (SQLite settings):
 *
 * - `permissions.homeHidden`: the ids the driver hid with "Don't remind me again". Written only by
 *   `hideOnHome` / `showOnHome`; it stays when the permission later turns on and off again.
 * - `permissions.homeToSettings`: id → the missing state's signature a request had no visible effect
 *   on, so that row's next tap opens Settings. It applies only while the state is still that one.
 *
 * Every write runs through one queue, and each write reads and writes only its own key, so a hide
 * can never be undone by a `toSettings` write and two writes to one key never interleave. A read for
 * display treats a failure or a malformed value as empty: a broken store never hides a row.
 */
import { HOME_HIDDEN_KEY, HOME_TO_SETTINGS_KEY, type SettingsStore } from '@/core/permissions';

import { isPermissionId, PERMISSIONS, type PermissionId } from './registry';

export interface HomePrefs {
  hidden: readonly PermissionId[];
  toSettings: Partial<Record<PermissionId, string>>;
}

export const EMPTY_HOME_PREFS: HomePrefs = { hidden: [], toSettings: {} };

let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every write queued before it, whatever they did. */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const ORDER = new Map(PERMISSIONS.map((d) => [d.id, d.order]));

function parseHidden(raw: unknown): PermissionId[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<PermissionId>();
  for (const v of raw) if (isPermissionId(v)) ids.add(v);
  return [...ids].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
}

function parseToSettings(raw: unknown): Partial<Record<PermissionId, string>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Record<PermissionId, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (isPermissionId(k) && typeof v === 'string') out[k] = v;
  return out;
}

async function readOr<T>(settings: Pick<SettingsStore, 'get'>, key: string, parse: (raw: unknown) => T, fallback: T): Promise<T> {
  try {
    return parse(await settings.get<unknown>(key));
  } catch {
    return fallback;
  }
}

/** Both keys, for display. Never throws. */
export async function readHomePrefs(settings: Pick<SettingsStore, 'get'>): Promise<HomePrefs> {
  const [hidden, toSettings] = await Promise.all([
    readOr(settings, HOME_HIDDEN_KEY, parseHidden, []),
    readOr(settings, HOME_TO_SETTINGS_KEY, parseToSettings, {}),
  ]);
  return { hidden, toSettings };
}

// A write reads strictly: a failed read must not overwrite what is stored with an empty value.

/** "Don't remind me again": `id` leaves Home until Show on Home. Returns the stored list. */
export function hideOnHome(settings: SettingsStore, id: PermissionId): Promise<PermissionId[]> {
  return serial(async () => {
    const cur = parseHidden(await settings.get<unknown>(HOME_HIDDEN_KEY));
    if (cur.includes(id)) return cur;
    const next = parseHidden([...cur, id]);
    await settings.set(HOME_HIDDEN_KEY, next);
    return next;
  });
}

/** Settings › Permissions › Show on Home. Returns the stored list. */
export function showOnHome(settings: SettingsStore, id: PermissionId): Promise<PermissionId[]> {
  return serial(async () => {
    const cur = parseHidden(await settings.get<unknown>(HOME_HIDDEN_KEY));
    if (!cur.includes(id)) return cur;
    const next = cur.filter((x) => x !== id);
    await settings.set(HOME_HIDDEN_KEY, next);
    return next;
  });
}

/** A request had no visible effect on the state `signature`: the row's next tap opens Settings. */
export function markToSettings(settings: SettingsStore, id: PermissionId, signature: string): Promise<Partial<Record<PermissionId, string>>> {
  return serial(async () => {
    const cur = parseToSettings(await settings.get<unknown>(HOME_TO_SETTINGS_KEY));
    if (cur[id] === signature) return cur;
    const next = { ...cur, [id]: signature };
    await settings.set(HOME_TO_SETTINGS_KEY, next);
    return next;
  });
}

/**
 * Drops the entries that no longer apply (`applies(id, signature)` false: the permission is on now,
 * or missing for another reason). Writes only when something changed.
 */
export function pruneToSettings(
  settings: SettingsStore,
  applies: (id: PermissionId, signature: string) => boolean
): Promise<Partial<Record<PermissionId, string>>> {
  return serial(async () => {
    const cur = parseToSettings(await settings.get<unknown>(HOME_TO_SETTINGS_KEY));
    const next: Partial<Record<PermissionId, string>> = {};
    for (const [id, sig] of Object.entries(cur) as [PermissionId, string][]) if (applies(id, sig)) next[id] = sig;
    if (Object.keys(next).length === Object.keys(cur).length) return cur;
    await settings.set(HOME_TO_SETTINGS_KEY, next);
    return next;
  });
}
