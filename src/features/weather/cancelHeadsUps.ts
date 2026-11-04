/**
 * The live weather heads-up planner (`commuteHeadsUp.ts`) reached without loading the notifications
 * module at import: the session, the device wipes, the saved places and the quiet-hours sync. A
 * replan reaches only a planner already attached; a take-down loads the module when called.
 * Neither ever throws.
 */

let replanLive: (() => void) | null = null;

/** The live planner registers how to plan again (`attachCommuteHeadsUp`); null when it detaches. */
export function setCommuteReplan(fn: (() => void) | null): void {
  replanLive = fn;
}

/** Plan the heads-ups again now, past the throttle (the places or the quiet hours changed). No live planner: nothing to do. */
export function requestCommuteReplanLazily(): void {
  try {
    replanLive?.();
  } catch {
    // never in the caller's way
  }
}

/** Every weather heads-up before the commute taken down. */
export async function cancelCommuteHeadsUpsLazily(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const { cancelCommuteHeadsUps } = require('./commuteHeadsUp') as typeof import('./commuteHeadsUp');
    await cancelCommuteHeadsUps();
  } catch {
    // No notifications module: nothing is scheduled that could fire.
  }
}
