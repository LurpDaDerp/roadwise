import { CONSTANTS } from './constants';

/**
 * Trip exposure `E` (§9.4): `max(miles / 10, minutes / 20)`, floored at 0.75.
 *
 * City driving has low miles but high exposure and highway driving the opposite, so both terms
 * matter; the floor stops one event on a very short trip from dominating the score.
 */
export function exposure(distanceM: number, durationS: number): number {
  const miles = distanceM / CONSTANTS.MILE;
  const minutes = durationS / 60;
  return Math.max(CONSTANTS.EXPOSURE_FLOOR, miles / 10, minutes / 20);
}
