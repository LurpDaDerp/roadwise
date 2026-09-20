import { effectiveConfidence } from './confidence';
import { CATEGORY, CONSTANTS, type EventCategory } from './constants';
import { contextMultiplier } from './context';
import { exposure } from './exposure';
import { dataQualityGrade } from './quality';
import { baseWeight, durationFactor, severity } from './severity';
import type { ScorableEvent, ScoredTrip, TripMetrics } from './types';

const CATEGORIES = Object.keys(CATEGORY) as EventCategory[];
const zero = () => Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<EventCategory, number>;

/**
 * Score one finished trip (§9.4).
 *
 * Each event costs `d = B × s × t × q_eff × x`; the category total is divided by the trip's exposure
 * `E` and then capped, so a long trip absorbs a mistake that would sink a short one and no single
 * category can take the whole score. Events the driver disputed, the detector only called
 * "possible", or that fall below the confidence floor cost nothing at all.
 */
export function scoreTrip(m: TripMetrics, events: ScorableEvent[]): ScoredTrip {
  // One NaN or Infinity anywhere in the trip's measurements propagates through exposure into every
  // deduction and out as a NaN score, which would then be stored and shown. A trip we cannot even
  // measure is graded C and left unscored, like any other trip too thin to judge.
  const measured =
    Number.isFinite(m.distanceM) &&
    Number.isFinite(m.durationS) &&
    Number.isFinite(m.validGnssPct) &&
    Number.isFinite(m.maxSustainedSpeedMps);

  const E = measured ? exposure(m.distanceM, m.durationS) : CONSTANTS.EXPOSURE_FLOOR;
  const dataQuality = measured ? dataQualityGrade(m.validGnssPct, m.imuPresent) : 'C';
  const unscored = (
    reason: NonNullable<ScoredTrip['reason']>,
    status: ScoredTrip['status'] = 'unscored'
  ): ScoredTrip => ({
    score: null,
    status,
    reason,
    exposure: E,
    dataQuality,
    categoryDeductions: zero(),
    eventDeductions: {},
    scoringVersion: 1,
  });

  if (!measured) return unscored('grade_c');
  if (m.maxSustainedSpeedMps > CONSTANTS.DISCARD_SPEED_MPS) {
    return unscored('implausible_speed', 'discarded');
  }
  if (m.role !== 'driver') return unscored('passenger');
  if (m.distanceM < CONSTANTS.MIN_SCORED_DISTANCE_M || m.durationS < CONSTANTS.MIN_SCORED_DURATION_S) {
    return unscored('too_short');
  }
  if (dataQuality === 'C') return unscored('grade_c');

  const raw = zero();
  const eventDeductions: Record<string, number> = {};
  for (const e of events) {
    if (e.status !== 'scored') continue;
    const q = effectiveConfidence(e.q);
    if (q === 0) continue;
    const d = baseWeight(e) * severity(e) * durationFactor(e) * q * contextMultiplier(e);
    eventDeductions[e.id] = d / E;
    raw[e.category] += d;
  }

  const categoryDeductions = zero();
  let total = 0;
  for (const c of CATEGORIES) {
    categoryDeductions[c] = Math.min(CATEGORY[c].cap, raw[c] / E);
    total += categoryDeductions[c];
  }
  const score = Math.max(0, Math.min(100, Math.round(100 - total)));
  return { score, status: 'final', exposure: E, dataQuality, categoryDeductions, eventDeductions, scoringVersion: 1 };
}
