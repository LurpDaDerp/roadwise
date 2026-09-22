/**
 * What the trip screens derive from a `TripSummary` before anything is drawn. Pure: no React,
 * no theme, no database — every rule the summary card prints is testable on its own.
 */
import { CONSTANTS, type EventCategory } from '@scoring';

import { categoryCaps } from '@/content/scoring-explainer';
import type { DayEntry, TripEventView, TripSummary, UnscoredReason } from '@/data/queries';
import { mpsToMph } from '@/lib/units';

import { tripCopy as copy } from './copy';

function inZone(ts: number, tz: string, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(ts);
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz }).format(date);
  } catch {
    // A zone Intl does not know (a row stored with `tz: ''`): the device's own zone is the
    // honest fallback, the same one the finalizer's night rule takes.
    return new Intl.DateTimeFormat('en-US', options).format(date);
  }
}

/** "Mon, Jan 5" in the trip's own zone. */
export function formatTripDate(ts: number, tz: string): string {
  return inZone(ts, tz, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "7:42 AM" in the trip's own zone. */
export function formatClock(ts: number, tz: string): string {
  return inZone(ts, tz, { hour: 'numeric', minute: '2-digit' });
}

/** "7:42 – 8:12 AM": one period when both ends share it, "7:42 AM – 1:05 PM" otherwise. */
export function formatTimeSpan(start: number, end: number | null, tz: string): string {
  const from = formatClock(start, tz);
  if (end === null) return from;
  const to = formatClock(end, tz);
  const periodOf = (s: string) => (s.endsWith(' AM') || s.endsWith(' PM') ? s.slice(-2) : null);
  const same = periodOf(from) !== null && periodOf(from) === periodOf(to);
  return `${same ? from.slice(0, -3) : from} – ${to}`;
}

/** The route line: the stored endpoint labels, or "Start → End" until geocoding exists. */
export function routeLine(trip: Pick<TripSummary, 'startLabel' | 'endLabel'>): string {
  return `${trip.startLabel ?? copy.route.start} → ${trip.endLabel ?? copy.route.end}`;
}

/**
 * The same route, spoken. VoiceOver and TalkBack read the arrow as "right arrow" or drop it
 * silently (Task 6 review, M-7), so every `accessibilityLabel` that names a route uses this and
 * never `routeLine`.
 */
export function spokenRoute(trip: Pick<TripSummary, 'startLabel' | 'endLabel'>): string {
  return `${trip.startLabel ?? copy.route.start} ${copy.route.to} ${trip.endLabel ?? copy.route.end}`;
}

/** "Mon, Jan 5 · 7:42 – 8:12 AM". */
export function dateLine(trip: Pick<TripSummary, 'startedAt' | 'endedAt' | 'tz'>): string {
  return `${formatTripDate(trip.startedAt, trip.tz)} · ${formatTimeSpan(trip.startedAt, trip.endedAt, trip.tz)}`;
}

/** Night and rain as words, never as icons alone. */
export function conditionsLabel(trip: Pick<TripSummary, 'conditions'>): string {
  const { night, precipitation } = trip.conditions;
  if (night && precipitation) return copy.conditions.nightRain;
  if (night) return copy.conditions.night;
  if (precipitation) return copy.conditions.rain;
  return copy.conditions.day;
}

export type Highlight =
  | { kind: 'positive'; category: EventCategory; text: string }
  | { kind: 'cost'; category: EventCategory; text: string; points: number; episodes: number };

export const MAX_HIGHLIGHTS = 3;

/**
 * A speeding event whose stored confidence is below `Q_FULL_AT`: the limit was below the action
 * line (the HUD showed "—"; §9.5) or the GPS fix was too loose (capped at 0.4). Either way the
 * reading is uncertain, so every surface labels it "uncertain reading" — which never names the
 * wrong cause. An event with no stored confidence makes no claim either way.
 */
export function isReadingUncertain(event: Pick<TripEventView, 'category' | 'confidence'>): boolean {
  return (
    event.category === 'speeding' &&
    event.confidence !== null &&
    event.confidence < CONSTANTS.Q_FULL_AT
  );
}

/**
 * Below this share of the drive with a known limit, "kept to the limit" would be a claim about
 * roads the app could not see; speeding is not scored where the limit is unknown (§9.3).
 */
export const LIMIT_KNOWN_PCT = 50;

/** A clean category the app actually measured on this drive. */
function claimable(trip: TripSummary, category: EventCategory): boolean {
  if (category === 'focus') return trip.cameraSession;
  if (category === 'speeding') return (trip.limitCoveragePct ?? 0) >= LIMIT_KNOWN_PCT;
  return true;
}

const CATEGORY_LABEL: Readonly<Record<EventCategory, string>> = Object.fromEntries(
  categoryCaps.map((entry) => [entry.category, entry.label])
) as Record<EventCategory, string>;

export function categoryLabel(category: EventCategory): string {
  return CATEGORY_LABEL[category];
}

/**
 * The three highlights (§7.D D1): positives first, in cap order, then the one category that cost
 * the most. Only a category the drive actually measured is claimed clean; only events that cost
 * points are counted as episodes, so a `possible` event never inflates the count.
 */
export function highlightsFor(trip: TripSummary, events: readonly TripEventView[]): Highlight[] {
  if (!trip.scored) return [];
  const worst = trip.worstCategory;
  const cost: Highlight | null =
    worst === null
      ? null
      : (() => {
          const counted = events.filter((e) => e.category === worst && e.affectsScore);
          const episodes = counted.length;
          const uncertain = counted.filter(isReadingUncertain).length;
          const label = categoryLabel(worst);
          const count =
            uncertain > 0
              ? `${copy.highlights.episodes(episodes)}, ${uncertain} ${copy.readingUncertain}`
              : copy.highlights.episodes(episodes);
          return {
            kind: 'cost',
            category: worst,
            text: episodes > 0 ? `${label}: ${count}` : label,
            points: trip.categoryDeductions[worst],
            episodes,
          };
        })();
  const room = MAX_HIGHLIGHTS - (cost ? 1 : 0);
  const positives: Highlight[] = categoryCaps
    .map((entry) => entry.category)
    .filter((category) => trip.categoryDeductions[category] <= 0 && claimable(trip, category))
    .slice(0, room)
    .map((category) => ({
      kind: 'positive',
      category,
      text: copy.highlights.positive[category],
    }));
  return cost ? [...positives, cost] : positives;
}

/** A drive with a score and nothing lost: the celebratory variant. */
export function isPerfect(trip: TripSummary): boolean {
  return trip.scored && trip.worstCategory === null;
}

export interface UnscoredCopy {
  title: string;
  body: string;
  /** The PASSENGER stamp, when the reason is who was at the wheel. */
  stamp: 'passenger' | null;
}

/**
 * What the score field says when there is no score. An unclassified trip asks its question
 * before any reason is offered; a reason the row cannot explain is "calculating" while the
 * upload is pending (the server scores it) and an honest "couldn't be scored" once it is not.
 */
export function unscoredCopy(trip: TripSummary, reason: UnscoredReason | null): UnscoredCopy {
  if (trip.role === 'unknown') {
    return { title: copy.score.whoWasDriving, body: copy.unscored.unknownRole, stamp: null };
  }
  switch (reason) {
    case 'role_unknown':
      return { title: copy.score.whoWasDriving, body: copy.unscored.unknownRole, stamp: null };
    case 'passenger':
      return { title: copy.score.notScored, body: copy.unscored.passenger, stamp: 'passenger' };
    case 'too_short':
      return { title: copy.score.notScored, body: copy.unscored.tooShort, stamp: null };
    case 'grade_c':
      return { title: copy.score.notScored, body: copy.unscored.gradeC, stamp: null };
    case 'implausible_speed':
      return { title: copy.score.notScored, body: copy.unscored.implausible, stamp: null };
    case null:
      return trip.syncState === 'synced' || trip.syncState === 'failed'
        ? { title: copy.score.notScored, body: copy.unscored.unknown, stamp: null }
        : { title: copy.score.calculating, body: copy.unscored.calculating, stamp: null };
  }
}

/** The caption under a data-quality grade: the words, since the stamp only has the letter. */
export function qualityCaption(grade: 'A' | 'B' | 'C'): string {
  return copy.quality[grade];
}

export type EarnedKind = 'safeDay' | 'goodDay' | 'safeOnTrack' | 'goodOnTrack' | 'counts';

/**
 * The EARNED field (§7.D D1) before points exist: the day's cached evaluation when the server
 * has seen this drive, otherwise where this drive's score puts the day. The cache is only
 * trusted for a synced trip — a day row written before this drive uploaded says nothing about it.
 */
export function earnedFor(trip: TripSummary, day: DayEntry | null): EarnedKind {
  if (trip.syncState === 'synced' && day !== null) {
    // The server has evaluated this day with this drive in it. Whatever it says is the answer —
    // including "neither", which must not fall through to an "on track" claim derived from this
    // one drive's score (Task 6 review, M-2).
    if (day.safeDay) return 'safeDay';
    if (day.goodDay) return 'goodDay';
    return 'counts';
  }
  if (!trip.scored || trip.score === null) return 'counts';
  if (trip.score >= CONSTANTS.SAFE_DAY_AVG) return 'safeOnTrack';
  if (trip.score >= CONSTANTS.GOOD_DAY_AVG) return 'goodOnTrack';
  return 'counts';
}

const seconds = (s: number) => `${Math.max(1, Math.round(s))} s`;
const gees = (g: number | undefined) => (g === undefined ? null : `${Math.abs(g).toFixed(2)} g`);

/** One event in plain language, for the tip's "from this drive" examples. */
export function describeEvent(event: TripEventView): string {
  const m = event.measured;
  switch (event.category) {
    case 'speeding': {
      const over = m.overMps === undefined ? null : Math.round(mpsToMph(m.overMps));
      return over === null
        ? `Over the limit for ${seconds(event.durationS)}`
        : `${over} mph over for ${seconds(event.durationS)}`;
    }
    case 'phone':
      return `Phone handled for ${seconds(event.durationS)}`;
    case 'braking': {
      const g = gees(m.peakG);
      return g === null ? 'Hard brake' : `${g} brake`;
    }
    case 'accel': {
      const g = gees(m.peakG);
      return g === null ? 'Hard pull-away' : `${g} pull-away`;
    }
    case 'cornering': {
      const g = gees(m.lateralG);
      return g === null ? 'Sharp turn' : `${g} turn`;
    }
    case 'focus':
      return m.focusKind === 'drowsiness'
        ? 'Signs of drowsiness'
        : `Eyes off the road for ${seconds(m.glanceS ?? event.durationS)}`;
    case null:
      return event.rawCategory;
  }
}
