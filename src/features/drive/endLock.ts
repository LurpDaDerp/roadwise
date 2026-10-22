// End drive's lock at speed (modes plan §3.6): the swipe greys out and takes no touch while the car
// is at or over the speed an automatic drive starts at, and comes back only under 10 mph, so a car
// hovering at the line never flickers it. With the drive locked in, "Not driving?" (while it is
// still offered) is the way to drop a drive at speed; End is for a car that has slowed or stopped.

/** End locks at this row speed (mph) and over: the automatic trigger's speed (`AUTO_TRIGGER.mph`). */
export const END_LOCK_MPH = 20;
/** …and unlocks only under this (mph): the manual trigger's speed (`MANUAL_TRIGGER.mph`). */
export const END_UNLOCK_MPH = 10;

/**
 * End's lock after this row: locked at 20 mph and over, unlocked under 10, an unknown speed holds
 * the last answer (the navigation button's `nextNavLock` pattern).
 */
export const nextEndLock = (locked: boolean, rowSpeedMph: number | null): boolean =>
  rowSpeedMph === null || !Number.isFinite(rowSpeedMph) ? locked : locked ? rowSpeedMph >= END_UNLOCK_MPH : rowSpeedMph >= END_LOCK_MPH;
