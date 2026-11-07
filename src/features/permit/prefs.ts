/**
 * Permit mode's settings, on this phone only (`permit.*` in the settings table): whether it is on,
 * the day the practice log starts, the state (detected from the phone's location or chosen), the
 * hour targets when the driver changed them, the saved supervisor and the name printed on the log.
 *
 * Like the navigation app (`navigation/prefs.ts`) they survive a restart and a plain sign-out; a
 * reinstall, or the device wipe when another account signs in, clears them. Anything stored that
 * this build can't read reads as unset.
 */
import { PRACTICE_SUPERVISOR_MAX } from '@/data/db/types';
import type { SettingsRepo } from '@/data/db/settings';
import { dayKey } from '@/lib/time';

import { stateByCode } from './states';

export const PERMIT_KEYS = {
  enabled: 'permit.enabled',
  startDay: 'permit.startDay',
  state: 'permit.state',
  targets: 'permit.targets',
  supervisor: 'permit.supervisor',
  driverName: 'permit.driverName',
} as const;

/** The longest name kept for the supervisor and for the driver. */
export const PERMIT_NAME_MAX = PRACTICE_SUPERVISOR_MAX;
/** The highest hour target a field takes. */
export const TARGET_MAX_H = 999;

export interface PermitTargets {
  totalH: number | null;
  nightH: number | null;
}

export interface PermitPrefs {
  enabled: boolean;
  /** The log's first day, "YYYY-MM-DD" on the phone's calendar; null until Permit mode is first turned on. */
  startDay: string | null;
  /** The state's postal code (null: none yet) and whether it follows the phone's location. */
  state: { code: string | null; auto: boolean };
  /** The driver's own targets; null: the state's numbers. */
  targets: PermitTargets | null;
  supervisor: string | null;
  driverName: string | null;
}

export const DEFAULT_PERMIT: PermitPrefs = Object.freeze({
  enabled: false,
  startDay: null,
  state: Object.freeze({ code: null, auto: true }),
  targets: null,
  supervisor: null,
  driverName: null,
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A name as kept: trimmed, at most `PERMIT_NAME_MAX` characters; empty is null. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, PERMIT_NAME_MAX).trim();
  return t === '' ? null : t;
}

/** A target as kept: above 0 and at most `TARGET_MAX_H`, to 0.1 h; anything else (0, blank) is no target. */
export function cleanTarget(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return Math.min(TARGET_MAX_H, Math.round(v * 10) / 10) || null;
}

/** Targets as kept: night at most the total. Both unset is still the driver's own choice (no targets). */
export function cleanTargets(v: unknown): PermitTargets | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const totalH = cleanTarget(r.totalH);
  const night = cleanTarget(r.nightH);
  const nightH = night !== null && totalH !== null ? Math.min(night, totalH) : night;
  return { totalH, nightH };
}

/** The stored values, each checked on its own. */
export function parsePermit(raw: Record<string, unknown>): PermitPrefs {
  const day = raw[PERMIT_KEYS.startDay];
  const st = raw[PERMIT_KEYS.state];
  const stateRaw = typeof st === 'object' && st !== null ? (st as Record<string, unknown>) : {};
  return {
    enabled: raw[PERMIT_KEYS.enabled] === true,
    startDay: typeof day === 'string' && DAY.test(day) ? day : null,
    state: { code: stateByCode(stateRaw.code)?.code ?? null, auto: stateRaw.auto !== false },
    targets: cleanTargets(raw[PERMIT_KEYS.targets]),
    supervisor: cleanName(raw[PERMIT_KEYS.supervisor]),
    driverName: cleanName(raw[PERMIT_KEYS.driverName]),
  };
}

/** Permit mode's settings; the defaults on a failed read. */
export async function readPermit(settings: SettingsRepo): Promise<PermitPrefs> {
  try {
    return parsePermit(await settings.getMany(Object.values(PERMIT_KEYS)));
  } catch {
    return DEFAULT_PERMIT;
  }
}

/** Today on the phone's calendar. */
export const todayKey = (now: number): string => dayKey(new Date(now));

/**
 * Turn Permit mode on or off. The first time it is turned on, the log starts that day; a start day
 * already set (turned off and on again) stays.
 */
export async function writePermitEnabled(settings: SettingsRepo, on: boolean, now: number): Promise<void> {
  if (on && (await readPermit(settings)).startDay === null) await settings.set(PERMIT_KEYS.startDay, todayKey(now));
  await settings.set(PERMIT_KEYS.enabled, on);
}

/** Move the log's first day; a day after today is today. */
export async function writeStartDay(settings: SettingsRepo, day: string, now: number): Promise<void> {
  if (!DAY.test(day)) return;
  const today = todayKey(now);
  await settings.set(PERMIT_KEYS.startDay, day > today ? today : day);
}

/** The state: chosen by the driver (`auto` false), or detected (`auto` true; `code` null when nothing was found yet). */
export async function writePermitState(settings: SettingsRepo, code: string | null, auto: boolean): Promise<void> {
  await settings.set(PERMIT_KEYS.state, { code: stateByCode(code)?.code ?? null, auto });
}

/** The driver's own targets; null goes back to the state's numbers. */
export async function writeTargets(settings: SettingsRepo, targets: PermitTargets | null): Promise<void> {
  const clean = targets === null ? null : cleanTargets(targets);
  if (clean === null) await settings.remove(PERMIT_KEYS.targets);
  else await settings.set(PERMIT_KEYS.targets, clean);
}

/** The saved supervisor (the default for every practice drive); empty removes it. */
export async function writeSupervisor(settings: SettingsRepo, name: string): Promise<void> {
  const clean = cleanName(name);
  if (clean === null) await settings.remove(PERMIT_KEYS.supervisor);
  else await settings.set(PERMIT_KEYS.supervisor, clean);
}

/** The name printed on the log; empty removes it. */
export async function writeDriverName(settings: SettingsRepo, name: string): Promise<void> {
  const clean = cleanName(name);
  if (clean === null) await settings.remove(PERMIT_KEYS.driverName);
  else await settings.set(PERMIT_KEYS.driverName, clean);
}
