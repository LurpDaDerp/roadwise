/**
 * The practice log, derived from the phone's drives and Permit mode's settings. Pure.
 *
 * A drive is a practice drive while Permit mode is on when it was kept (scored, waiting to be, or
 * too short to score; never one in progress, one marked "Wasn't driving" or a passenger ride, nor
 * one the server could not score) and it started on or after the log's first day (its own local
 * day). Practice drives score like any other drive; the log only adds them up.
 */
import type { LocalDrive } from '@/data/queries/rows';
import { dayKey } from '@/lib/time';

import { practiceMinutes, type PracticeMinutes } from './night';
import { EMPTY_NOTES, type PracticeNotes } from './notes';
import type { PermitPrefs, PermitTargets } from './prefs';
import { stateByCode, type NightRule, type PermitState } from './states';

/** What the log reads of a drive. */
export type LogDrive = Pick<
  LocalDrive,
  | 'clientTripId'
  | 'startedAt'
  | 'endedAt'
  | 'durationS'
  | 'miles'
  | 'nightMiles'
  | 'polyline'
  | 'start'
  | 'end'
  | 'status'
  | 'reason'
  | 'result'
  | 'tz'
  | 'practiceSupervisor'
  | 'archived'
>;

/** The drive's own calendar day (in its time zone when it has one). */
export const driveDay = (d: Pick<LocalDrive, 'startedAt' | 'tz'>): string => dayKey(new Date(d.startedAt), d.tz || undefined);

/** Kept: scored, waiting for (or refused) its upload, or too short to score. */
export function isKeptDrive(d: Pick<LocalDrive, 'status' | 'reason' | 'result'>): boolean {
  const tooShort = d.reason === 'too_short' || d.result?.reason === 'too_short';
  switch (d.status) {
    case 'scored':
    case 'pending':
    case 'failed':
      return true;
    case 'unscored':
      return tooShort;
    case 'recording':
    case 'not_driving':
      return false;
  }
}

/** Whether a drive counts in the practice log under these settings. */
export function isPracticeDrive(d: Pick<LocalDrive, 'status' | 'reason' | 'result' | 'startedAt' | 'tz'>, prefs: Pick<PermitPrefs, 'enabled' | 'startDay'>): boolean {
  return prefs.enabled && prefs.startDay !== null && isKeptDrive(d) && driveDay(d) >= prefs.startDay;
}

/** The state Permit mode works with, or null when none is known yet. */
export const permitState = (prefs: Pick<PermitPrefs, 'state'>): PermitState | null => stateByCode(prefs.state.code);

/** What counts as night: the state's rule; sunset to sunrise without a state. */
export const nightRuleOf = (state: PermitState | null): NightRule => state?.nightRule ?? 'sunset';

/** The hour targets: the driver's own, else the state's; none without either. */
export function targetsOf(prefs: Pick<PermitPrefs, 'targets' | 'state'>): PermitTargets {
  if (prefs.targets !== null) return prefs.targets;
  const s = permitState(prefs);
  return { totalH: s?.totalH ?? null, nightH: s?.nightH ?? null };
}

export interface LogRow extends PracticeMinutes {
  drive: LogDrive;
  /** Who supervised: the drive's own (its row, else the kept copy), else the saved one; null when none is set. */
  supervisor: string | null;
}

/** Who supervised a drive: its row's name, else the copy kept through a sign-out, else the saved supervisor. */
export const supervisorOf = (d: Pick<LocalDrive, 'clientTripId' | 'practiceSupervisor'>, prefs: Pick<PermitPrefs, 'supervisor'>, notes: PracticeNotes = EMPTY_NOTES): string | null =>
  d.practiceSupervisor ?? notes.supervisors[d.clientTripId] ?? prefs.supervisor;

export interface LogTotals {
  drives: number;
  dayMin: number;
  nightMin: number;
  totalMin: number;
  miles: number;
}

export interface PracticeLog {
  /** Newest first. */
  rows: LogRow[];
  totals: LogTotals;
}

/**
 * A drive's minutes as the log keeps them: whole minutes, the night rounded and the day the rest of
 * the rounded whole, so every row adds up and the totals are the sum of the rows.
 */
export function wholeMinutes(m: PracticeMinutes): PracticeMinutes {
  const nightMin = Math.round(m.nightMin);
  return { nightMin, dayMin: Math.max(0, Math.round(m.dayMin + m.nightMin) - nightMin) };
}

/**
 * The practice drives among `drives`, newest first, with their whole minutes and the totals. `notes`
 * are what was kept beside the rows (`notes.ts`): supervisors through a sign-out, archived drives'
 * night minutes.
 */
export function practiceLog(drives: readonly LogDrive[], prefs: PermitPrefs, notes: PracticeNotes = EMPTY_NOTES): PracticeLog {
  const rule = nightRuleOf(permitState(prefs));
  const rows = drives
    .filter((d) => isPracticeDrive(d, prefs))
    .sort((a, b) => b.startedAt - a.startedAt || (a.clientTripId < b.clientTripId ? -1 : 1))
    .map((drive): LogRow => ({ drive, ...wholeMinutes(practiceMinutes(drive, rule, notes.night[drive.clientTripId])), supervisor: supervisorOf(drive, prefs, notes) }));
  const totals: LogTotals = { drives: rows.length, dayMin: 0, nightMin: 0, totalMin: 0, miles: 0 };
  for (const r of rows) {
    totals.dayMin += r.dayMin;
    totals.nightMin += r.nightMin;
    totals.miles += r.drive.miles;
  }
  totals.totalMin = totals.dayMin + totals.nightMin;
  return { rows, totals };
}

/** Hours to one decimal, never rounded up past what was driven ("12.5"). */
export function hoursText(minutes: number): string {
  const tenths = Math.floor((Math.max(0, minutes) / 60) * 10 + 1e-9);
  return (tenths / 10).toFixed(1);
}

/** A target as written: "50", "12.5". */
export const targetText = (h: number): string => String(Math.round(h * 10) / 10);

/** Done over target, from 0 to 1 (0 without a target). */
export const progressOf = (minutes: number, targetH: number | null): number =>
  targetH === null || targetH <= 0 ? 0 : Math.min(1, Math.max(0, minutes / 60 / targetH));

/** The day target: the total less the night hours (both needed). */
export const dayTargetOf = (t: PermitTargets): number | null =>
  t.totalH !== null && t.nightH !== null ? Math.max(0, Math.round((t.totalH - t.nightH) * 10) / 10) : null;
