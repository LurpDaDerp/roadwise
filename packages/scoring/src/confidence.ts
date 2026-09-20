import { CONSTANTS } from './constants';

/**
 * Effective confidence `q` used in the deduction (§9.4):
 * below 0.5 the event is "possible" and costs nothing, 0.5–0.8 scales linearly, 0.8 and above is
 * treated as certain.
 *
 * A confidence that is not a finite number is worth nothing rather than everything: every
 * comparison against NaN is false, so without the guard an unmeasurable event would fall through
 * the bands and be charged at full weight.
 */
export function effectiveConfidence(q: number): number {
  if (!Number.isFinite(q) || q < CONSTANTS.Q_UNSCORED_BELOW) return 0;
  if (q >= CONSTANTS.Q_FULL_AT) return 1;
  return q;
}
