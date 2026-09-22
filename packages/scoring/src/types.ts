import type { EventCategory } from './constants';

/** Which camera signal produced a focus event (§9.3). */
export type FocusKind = 'glance' | 'drowsiness';

/** One detected event, as scored by §9.3–§9.5. */
export interface ScorableEvent {
  id: string;
  category: EventCategory;
  /** epoch ms */
  startedAt: number;
  durationS: number;
  /** confidence, 0..1 */
  q: number;
  /** behaviour ended inside the post-alert grace window (§9.3 correction credit) */
  corrected: boolean;
  status: 'scored' | 'possible' | 'disputed' | 'removed';
  measured: {
    speedMps?: number;
    limitMps?: number;
    overMps?: number;
    peakG?: number;
    lateralG?: number;
    glanceS?: number;
    focusKind?: FocusKind;
  };
  context: { night: boolean; precipitation: boolean };
}

/** Trip-level facts the scorer needs to decide exposure and scorability (§9.4, §9.7, §9.8). */
export interface TripMetrics {
  distanceM: number;
  durationS: number;
  validGnssPct: number;
  imuPresent: boolean;
  role: 'driver' | 'passenger' | 'other' | 'unknown';
  maxSustainedSpeedMps: number;
}

/** The result of scoring one trip (§9.4). `score` is a number only when `status` is `'final'`. */
export interface ScoredTrip {
  score: number | null;
  status: 'final' | 'unscored' | 'discarded';
  /**
   * Why there is no score. `role_unknown` is an auto-detected drive whose evidence could not say
   * who was driving (§9.7): it stays unscored until the driver answers, and is never assumed to
   * be theirs.
   */
  reason?: 'passenger' | 'role_unknown' | 'too_short' | 'grade_c' | 'implausible_speed';
  exposure: number;
  dataQuality: 'A' | 'B' | 'C';
  /** Deduction per category after its per-trip cap, in score points. */
  categoryDeductions: Record<EventCategory, number>;
  /** Deduction per event before any cap, keyed by event id — this is the "why this score" list. */
  eventDeductions: Record<string, number>;
  scoringVersion: 1;
}
