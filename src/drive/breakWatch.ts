// The break reminder: after 2 hours of driving, at the first stop with RoadWise in front, a soft
// tone and "Take a break soon" (spoken even with voice alerts off), and the driving screen's band
// says the same for 4 s; then again at each whole hour after (3 h, 4 h, ...).
//
// The watcher is pure (modelled on the spot nudge's, `src/core/spots/watcher.ts`): the host owns
// the row clock, the foreground state and the drive's driving-speed mark, and feeds it every row of
// a recording drive. Per row, in order:
// - A replayed row (a journal drained) is the past: it neither fires nor counts as a stop.
// - Driving time is row-clock time since the drive first reached driving speed (`droveAt`, the
//   engine's `session.droveAt`), never the Start tap: a Start-card drive still waiting has none.
// - The thresholds are fixed hours after `droveAt`: 2 h, then 3 h, 4 h, ... One is due once the row
//   is past it and it has not been reminded yet.
// - It fires on a row where the car has been stopped (`snap.stopped`: a known speed of 5 mph or
//   less) for 2 rows in a row at least, a red light included; with RoadWise in front only, never
//   while a Start-card drive waits, never while the screen is busy (a phone or DashPal alert showing
//   or just shown, a DashPal alert sounding, a DashPal continuous alert), never while the drive is
//   about to end at a saved place (the place-arrival end pending), and never within 10 min after a
//   DashPal drowsy alert (it already said "Take a break"). Each of those only defers it to a later
//   stop: nothing is used up.
// - A reminder the player drops unplayed (RoadWise went behind before it started) is handed back
//   (`release`): its hours count again, and it comes at the next such stop.
// - A threshold passed while RoadWise was behind fires at the next such stop in front. Several
//   passed at once make one reminder, and the next one is the first whole hour after it.
//
// The last reminded hour is kept per drive in a settings key (`BREAK_KEY`, wiped at sign-out), so a
// drive taken up again after a relaunch does not repeat it.
import type { AlertDecision } from '@/core/alerts/types';
import { createSettingsRepo, type Db } from '@/data/db';
import { t } from '@/i18n';

/** Settings key; wiped at sign-out (`SIGN_OUT_SETTINGS`). */
export const BREAK_KEY = 'drive.breakReminder';
export const HOUR_MS = 3_600_000;
/** The first reminder's driving time, in whole hours; then one every hour. */
export const BREAK_FIRST_H = 2;
/** Consecutive stopped rows before a row counts as a stop. */
export const BREAK_STOP_ROWS = 2;
/** No reminder this long after a DashPal drowsy alert (ms). */
export const BREAK_AFTER_DROWSY_MS = 10 * 60_000;
/** How long the driving screen's band shows the reminder (ms, row clock). */
export const BREAK_REMINDER_MS = 4000;

export interface BreakInput {
  /** The row's time (row clock). */
  ts: number;
  /** When the drive first reached driving speed (row clock), or null before. */
  droveAt: number | null;
  /** The car is stopped on this row (`EngineSnapshot.stopped`). */
  stopped: boolean;
  /** The row is a replay (a journal drained). */
  replay: boolean;
  /** RoadWise is in front. */
  foreground: boolean;
  /** A Start-card drive still waits for driving speed. */
  waiting: boolean;
  /** Another alert (phone or DashPal) is showing or just showed, or a DashPal alert sounds or is continuous. */
  busy: boolean;
  /** The drive is about to end where it stopped (`EngineSnapshot.arriveAt` set: the place-arrival end pending). */
  ending: boolean;
  /** How long ago a DashPal drowsy alert last started or ended (ms), or null when none did. */
  drowsyAgoMs: number | null;
}

/** The reminder the driving screen flashes (`DriveState.breakReminder`): shown once per `key`. */
export interface BreakReminder {
  /** `break@${at}`. */
  key: string;
  /** The row's ts. */
  at: number;
  /** The whole hours driven it marks (2, 3, ...). */
  hours: number;
}

export interface BreakWatch {
  /** Feed one row of the recording drive; a reminder to give now, or null. */
  push(input: BreakInput): BreakReminder | null;
  /** The last whole hour reminded on this drive (0 before the first). */
  remindedH(): number;
  /**
   * `reminder` was never given (the player dropped it unplayed): its hours count again, so it comes
   * at the next stop. Ignored unless it is the latest reminder.
   */
  release(reminder: BreakReminder): void;
}

/** A watcher over one drive; `remindedH`: the hour this drive was last reminded at (after a relaunch). */
export function createBreakWatch(opts: { remindedH?: number } = {}): BreakWatch {
  let reminded = validHours(opts.remindedH) ?? 0;
  let stoppedRows = 0;
  /** The latest reminder's key, and the hour reminded before it (what `release` goes back to). */
  let lastKey: string | null = null;
  let before = reminded;

  return {
    push(input) {
      if (input.replay) {
        stoppedRows = 0;
        return null;
      }
      stoppedRows = input.stopped ? stoppedRows + 1 : 0;
      if (input.droveAt === null || input.waiting) return null;
      const driven = input.ts - input.droveAt;
      const next = Math.max(BREAK_FIRST_H, reminded + 1);
      if (!(driven >= next * HOUR_MS)) return null;
      if (stoppedRows < BREAK_STOP_ROWS || !input.foreground || input.busy || input.ending) return null;
      const drowsy = input.drowsyAgoMs;
      if (drowsy !== null && drowsy >= 0 && drowsy < BREAK_AFTER_DROWSY_MS) return null;
      // Every hour passed is covered by this one reminder; the next is the first whole hour after now.
      before = reminded;
      reminded = Math.floor(driven / HOUR_MS);
      lastKey = `break@${input.ts}`;
      return { key: lastKey, at: input.ts, hours: reminded };
    },
    remindedH: () => reminded,
    release(reminder) {
      if (reminder.key !== lastKey) return;
      lastKey = null;
      reminded = before;
    },
  };
}

/**
 * What the player gives: the soft tone (level 1), "Take a break soon" spoken even with voice alerts
 * off (`voiceAlways`; never on a call), and one light pulse. The alert style rules as for every
 * alert: vibration-only is the pulse alone, sound-only the tone and the words.
 */
export function breakDecision(reminder: BreakReminder, clientTripId: string): AlertDecision {
  return {
    id: `break:${clientTripId}:${reminder.hours}`,
    level: 1,
    kind: 'break',
    ts: reminder.at,
    voice: t('alert.takeABreak'),
    voiceAlways: true,
    intensity: 1,
  };
}

// --- the stored mark ----------------------------------------------------------------------------

export interface BreakMark {
  clientTripId: string;
  /** The last whole hour reminded on that drive. */
  remindedH: number;
}

function validHours(h: unknown): number | null {
  return typeof h === 'number' && Number.isInteger(h) && h >= 0 ? h : null;
}

/** A stored mark, or null when absent or not one. */
export function parseBreakMark(raw: unknown): BreakMark | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.clientTripId !== 'string' || r.clientTripId.length === 0) return null;
  const h = validHours(r.remindedH);
  return h === null ? null : { clientTripId: r.clientTripId, remindedH: h };
}

export async function writeBreakMark(db: Db, mark: BreakMark): Promise<void> {
  await createSettingsRepo(db).set(BREAK_KEY, mark);
}

/** The hour `clientTripId` was last reminded at (another drive's mark is ignored), or 0. */
export async function remindedHFor(db: Db, clientTripId: string): Promise<number> {
  const mark = parseBreakMark(await createSettingsRepo(db).get<unknown>(BREAK_KEY));
  return mark !== null && mark.clientTripId === clientTripId ? mark.remindedH : 0;
}
