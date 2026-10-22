// A Start-card drive's wait for driving speed (modes plan §3.7; drive-fixes brief). A swipe on
// Start drive opens the driving screen on a drive that records from the tap (speed, limit, halo,
// alerts, the Live Activity), with a "Ready to roll" band until the car reaches driving speed (two
// trusted readings of 10 mph or more in a row, the engine's `droveAt`). Until then a sheet asks
// "Still planning to drive?" at 2:00, a countdown runs from 4:30, and at 5:00 the drive ends
// unsaved (it never reached driving speed, so it is not kept). Any touch on the screen starts the
// 5 min again.
//
// The clock here is the host's (the tap, the touches). On iOS native keeps the same deadline
// (`DriveDetect.startWaiting` / `extendWaiting`) so its safety stop never ends a waiting drive
// before JS would. Pure: no platform, no timer.

/** The whole wait (5 min), restarted by every touch. */
export const WAIT_TOTAL_MS = 300_000;
/** "Still planning to drive?" at 2 min. */
export const WAIT_POPUP_MS = 120_000;
/** The final 30 s countdown from 4:30. */
export const WAIT_COUNTDOWN_MS = 270_000;

export type WaitingPhase = 'waiting' | 'popup' | 'countdown';

/** What the driving screen draws for the wait (the speed and the sign are the drive's own). */
export interface WaitingPublic {
  /** Host clock of the tap or the last touch. */
  since: number;
  phase: WaitingPhase;
  /** When the current phase ends (host clock): the popup at since + 2:00, the countdown at since + 4:30, the unsaved end at since + 5:00. */
  deadlineAt: number;
}

/** The phase `now − since` into a wait, or `expired` at 5 min. */
export function waitingPhaseAt(since: number, now: number): WaitingPhase | 'expired' {
  const t = now - since;
  if (t >= WAIT_TOTAL_MS) return 'expired';
  if (t >= WAIT_COUNTDOWN_MS) return 'countdown';
  if (t >= WAIT_POPUP_MS) return 'popup';
  return 'waiting';
}

/** When `phase` ends for a wait that began at `since`. */
export function waitingDeadline(since: number, phase: WaitingPhase): number {
  if (phase === 'waiting') return since + WAIT_POPUP_MS;
  if (phase === 'popup') return since + WAIT_COUNTDOWN_MS;
  return since + WAIT_TOTAL_MS;
}

/** The next moment the phase changes (or the wait ends), for the host's one timer. */
export function nextWaitingChange(since: number, now: number): number {
  const phase = waitingPhaseAt(since, now);
  return phase === 'expired' ? now : waitingDeadline(since, phase);
}
