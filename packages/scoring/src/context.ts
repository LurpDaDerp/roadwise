import { CONSTANTS } from './constants';
import type { EventCategory } from './constants';
import type { ScorableEvent } from './types';

/** Night raises the cost of distraction and speed, not of vehicle handling (§9.4). */
const NIGHT_CATEGORIES: readonly EventCategory[] = ['phone', 'speeding', 'focus'];

/** Rain, snow and fog raise the cost of speed and of harsh manoeuvres (§9.4). */
const PRECIPITATION_CATEGORIES: readonly EventCategory[] = [
  'speeding',
  'braking',
  'accel',
  'cornering',
];

/** Context multiplier `x` (§9.4): the product of the applicable factors, capped at 1.5. */
export function contextMultiplier(e: ScorableEvent): number {
  let x = 1;
  if (e.context.night && NIGHT_CATEGORIES.includes(e.category)) x *= CONSTANTS.CONTEXT_NIGHT;
  if (e.context.precipitation && PRECIPITATION_CATEGORIES.includes(e.category)) {
    x *= CONSTANTS.CONTEXT_PRECIP;
  }
  return Math.min(x, CONSTANTS.CONTEXT_CAP);
}
