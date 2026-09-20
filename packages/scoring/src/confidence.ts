import { CONSTANTS } from './constants';

/**
 * Effective confidence `q` used in the deduction (§9.4):
 * below 0.5 the event is "possible" and costs nothing, 0.5–0.8 scales linearly, 0.8 and above is
 * treated as certain.
 */
export function effectiveConfidence(q: number): number {
  if (q < CONSTANTS.Q_UNSCORED_BELOW) return 0;
  if (q >= CONSTANTS.Q_FULL_AT) return 1;
  return q;
}
