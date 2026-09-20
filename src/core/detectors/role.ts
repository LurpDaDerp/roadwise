// Driver vs. passenger (§9.7): evidence folded into P(driver), then thresholded.

export interface RoleEvidence {
  manualStart: boolean;
  cameraFaceDriverSeat: boolean;
  statedPassenger: boolean;
  continuousHandlingMinutes: number;
  habitualDriverRoute: boolean;
  transitPattern: boolean;
}

export type Role = 'driver' | 'passenger' | 'other' | 'unknown';

export interface RoleInference {
  role: Role;
  /** P(driver), 0..1 */
  pDriver: number;
  /** ambiguous: ask the user (C10) */
  ask: boolean;
}

/** How each piece of evidence moves P(driver) (§9.7). */
const P = {
  statedPassenger: 0.02,
  transit: 0.05,
  strongDriver: 0.95,
  cap: 0.98,
  handlingFactor: 0.5,
  habitualBonus: 0.15,
} as const;
const HANDLING_MINUTES_MIN = 3;
/** `P ≥ DRIVER_AT` → driver; `P ≤ PASSENGER_AT` → passenger; in between, ask. */
const DRIVER_AT = 0.8;
const PASSENGER_AT = 0.2;
const NEUTRAL_PRIOR = 0.5;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function inferRole(e: RoleEvidence, prior: number): RoleInference {
  if (e.statedPassenger) return { role: 'passenger', pDriver: P.statedPassenger, ask: false };
  if (e.transitPattern) return { role: 'other', pDriver: P.transit, ask: false };

  let p: number;
  if (e.manualStart || e.cameraFaceDriverSeat) {
    p = P.strongDriver;
  } else {
    p = Number.isFinite(prior) ? clamp01(prior) : NEUTRAL_PRIOR;
    if (e.continuousHandlingMinutes >= HANDLING_MINUTES_MIN) p *= P.handlingFactor;
    if (e.habitualDriverRoute) p = Math.min(P.cap, p + P.habitualBonus);
  }

  if (p >= DRIVER_AT) return { role: 'driver', pDriver: p, ask: false };
  if (p <= PASSENGER_AT) return { role: 'passenger', pDriver: p, ask: false };
  return { role: 'unknown', pDriver: p, ask: true };
}
