// Screen switches (product spec v3 "Event detection · Screen switches"): RoadWise leaving the
// screen during a drive while the phone is in use is phone use, on Android and iPhone alike.
//
// A row is *away* when RoadWise is not in front (`appForeground` false) while the phone is in use,
// and nothing excuses it:
// - Android (`switchSignal: 'reliable'`): unlocked with its screen on. A lock or the screen going
//   off is exact there, so it is never a switch.
// - iPhone (`lagged` / `unproven`): not reported locked. iOS reports a lock only about 10 s late,
//   and the phone reads as unlocked while a lock screen a notification woke shows (Face ID unlocks
//   it at a glance), so a switch counts only once it spans 15 s plus the lock cut (`iosRunMinS`,
//   26 s with the usual delay), a lock report ends it and cuts it back to the estimated press
//   (`lockCutMs`), and only a phone that has shown a lock in time counts at all (`proven`; the
//   detector proves it in-drive too). Without a passcode (`none`) nothing is ever a switch. A lock
//   undone before its report reads as a short switch, so an iPhone short switch counts toward a
//   burst only when it outlasted the lock cut (`burstRunLong`); a run that began after a lock report
//   (an unlock outside RoadWise, a Face ID glance at the woken lock screen included) never does.
// - Excused: the host's stamps (`row.exempt`: the navigation button, the home screen a restart left
//   behind), a call's own screen (below) and the warm-up.
//
// A call's own screen: a departure while a call rings or is connected, or within `CALL_TAIL_S` after
// its last row, is the call's until RoadWise is back in front, the phone locks or its screen goes
// off, at most `CALL_AFTER_MAX_S` after the call's last row. Once the driver has had RoadWise in
// front for `CALL_FRONT_SPENT_ROWS` rows of the connected call, a departure in that call counts.
//
// This file holds the constants and the pure per-row classification; `phoneUse.ts` turns away rows
// into pickups and handling, one episode for motion and switches alike.
import type { DetectorContext, FeatureRow } from '../engine/types';
import { inWarmup, ROW_MS } from './common';

/** How far a drive's lock flags let a screen switch be told from a lock (`getState` at the Start tap). */
export type SwitchSignal = 'reliable' | 'lagged' | 'unproven' | 'none';

/** An Android run counts once it spans this long (the third row at 1 Hz). */
export const SWITCH_MIN_S_ANDROID = 3;
/** iPhone: a run counts once it spans this plus the lock cut (`iosRunMinS`); a cut that leaves less than this drops it. */
export const SWITCH_MIN_S_IOS = 15;
/** The lock-press-to-report delay assumed when the drive has no measured one, ms. */
export const IOS_LOCK_DELAY_DEFAULT_MS = 10_000;
/** A measured delay is clamped to `IOS_LOCK_DELAY_DEFAULT_MS`–this, ms. */
export const IOS_LOCK_DELAY_MAX_MS = 15_000;
/** A lock reported within this long of RoadWise leaving the screen proves the phone. */
export const LOCK_PROOF_MAX_S = 15;
/** A switch may start on a valid fix this good (looser than the 20 m events in general need). */
export const SWITCH_MAX_H_ACC_M = 50;
/** A departure within this long after a call row is still the call's ("Call ended" screens). */
export const CALL_TAIL_S = 5;
/** A call's screen stays excused at most this long after the call's last row. */
export const CALL_AFTER_MAX_S = 60;
/** After this many rows with RoadWise in front during a connected call, leaving again in it counts. */
export const CALL_FRONT_SPENT_ROWS = 10;
/**
 * A short switch that ends back in RoadWise counts toward a burst when it lasted this long (Android;
 * an iPhone one must also outlast the lock cut, `burstRunLong`).
 */
export const BURST_MIN_RUN_S = 2;
/** This many short switches … */
export const BURST_RUNS = 3;
/** … within this long (the first one's start to the last one's end) are one pickup. */
export const BURST_WINDOW_S = 120;
/** A navigation exemption whose app never took the screen ends this long after the tap (row clock). */
export const LEAVE_WAIT_S = 10;
/** After a process restart mid-drive, at most this long of "not in front" is excused. */
export const RESTART_GRACE_S = 60;

/** A drive's switch signal and the lock delay measured before it, as the host keeps and persists them. */
export interface PhoneSwitchCtx {
  signal: SwitchSignal;
  lockDelayMs: number | null;
}

/** No switch can be told from a lock: an adopted or rebuilt drive whose signal was not kept. */
export const NO_SWITCH: PhoneSwitchCtx = Object.freeze({ signal: 'none', lockDelayMs: null });

/** Android counts switches exactly; iPhone needs the lock checks; `none` never counts one. */
export const isIosSignal = (signal: SwitchSignal): boolean => signal === 'lagged' || signal === 'unproven';

/** A row's age within a run that began at `startTs`, seconds: the first row is 1. */
export const ageS = (ts: number, startTs: number): number => (ts - startTs) / 1000 + 1;

/** The measured lock delay clamped to 10–15 s, ms. */
export function clampLockDelay(delayMs: number | null): number {
  const d = delayMs ?? IOS_LOCK_DELAY_DEFAULT_MS;
  return Math.min(IOS_LOCK_DELAY_MAX_MS, Math.max(IOS_LOCK_DELAY_DEFAULT_MS, d));
}

/** How far back from a lock report a counted iPhone switch is cut: the clamped delay plus one row, ms. */
export const lockCutMs = (delayMs: number | null): number => clampLockDelay(delayMs) + ROW_MS;

/**
 * Whether a short run (first row `startTs`, last away row `lastTs`) is long enough to count toward a
 * burst. Android: `BURST_MIN_RUN_S`. iPhone: it must also span more than the lock cut, because a lock
 * undone before iOS reports it (the phone locked and unlocked back into RoadWise within about 10 s)
 * gives exactly the rows of a short switch, and a lock is never a switch. With the default delay the
 * cut is 11 s, so 13 to 25 rows (26 count on their own, `iosRunMinS`); a measured delay moves both
 * ends by the same amount.
 */
export function burstRunLong(signal: SwitchSignal, startTs: number, lastTs: number, delayMs: number | null): boolean {
  if (ageS(lastTs, startTs) < BURST_MIN_RUN_S) return false;
  return signal === 'reliable' || lastTs - startTs > lockCutMs(delayMs);
}

/**
 * iPhone: the span a run needs before it counts, seconds: `SWITCH_MIN_S_IOS` plus the lock cut (26 s
 * with the usual delay, 31 s with a measured 15 s). iOS lets the phone read as unlocked while its
 * lock screen shows (Face ID unlocks it at a glance when a notification wakes it) and for about 10 s
 * after it sleeps again, whether the screen woke before iOS reported the lock (one run from the
 * press) or after (a run from the unlock). Either way a lock screen woken and asleep again within
 * 15 s ends in a lock report before then, so it never confirms and plays no alert. A run that does
 * count is still charged from its first row.
 */
export const iosRunMinS = (delayMs: number | null): number => SWITCH_MIN_S_IOS + lockCutMs(delayMs) / 1000;

/** What one row is, for screen switches. */
export interface SwitchReading {
  /** RoadWise is not in front while the phone is in use (before any excuse). */
  open: boolean;
  /** iPhone: RoadWise not in front and the phone reported locked (the lock report). */
  lockRow: boolean;
  /** `open`, not excused and past the warm-up: this row belongs to a switch. */
  away: boolean;
  /** The row is excused: a host stamp or a call's own screen. */
  exempt: boolean;
}

/** The classifier's state across one drive's rows. */
export interface SwitchClassifier {
  read(row: FeatureRow, ctx: DetectorContext): SwitchReading;
  /** `ts` of the latest row where RoadWise left the screen (after a row in front), whatever the reason. */
  leftTs(): number | null;
}

export function createSwitchClassifier(): SwitchClassifier {
  let lastCallTs: number | null = null;
  let callFrontRows = 0;
  let callAway = false;
  let leftTs: number | null = null;
  /** RoadWise was in front on the previous row. False before any row: a drive that begins away never set when it left. */
  let prevFront = false;

  return {
    read(row, ctx) {
      // --- calls (row.call is 'ring' | 'live' | undefined) ---
      if (row.call !== undefined) {
        if (lastCallTs === null || row.ts - lastCallTs > CALL_TAIL_S * 1000) callFrontRows = 0; // a new call
        lastCallTs = row.ts;
      }
      const sinceCall = lastCallTs === null ? Number.POSITIVE_INFINITY : row.ts - lastCallTs;
      // Rows in front during a ringing call never spend the call's excuse.
      if (row.appForeground && row.call === 'live') callFrontRows += 1;

      // --- RoadWise not in front while the phone is in use ---
      const signal = ctx.switchSignal;
      let open = false;
      let lockRow = false;
      if (signal === 'reliable') {
        open = !row.appForeground && row.screenOn && !row.locked;
      } else if (isIosSignal(signal)) {
        open = !row.appForeground && !row.locked;
        lockRow = !row.appForeground && row.locked;
      }

      // --- a call's own screen: from the departure until RoadWise is back, capped after the call ---
      if (!open) callAway = false;
      else if (callAway) callAway = sinceCall <= CALL_AFTER_MAX_S * 1000;
      else callAway = sinceCall <= CALL_TAIL_S * 1000 && callFrontRows < CALL_FRONT_SPENT_ROWS;

      const exempt = row.exempt !== undefined || callAway;
      const away = open && !exempt && !inWarmup(row, ctx);

      if (!row.appForeground && prevFront) leftTs = row.ts;
      prevFront = row.appForeground;
      return { open, lockRow, away, exempt };
    },
    leftTs: () => leftTs,
  };
}
