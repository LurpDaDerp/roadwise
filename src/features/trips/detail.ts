/**
 * What D2, D3 and D4 derive before anything is drawn. Pure: no React, no theme, no database.
 *
 * `format.ts` holds what the card back needs; this holds the timeline, the event detail and the
 * history list. `describeEvent` (format.ts) stays the short line — "3 mph over for 38 s" — and
 * `measuredLine` below is the long one D3 asks for: "47 mph in a 35 zone for 38 s".
 */
import { CONSTANTS, type EventCategory } from '@scoring';

import { HIGH_SEVERITY } from '@/content/tips';
import type { TripEventView, TripSummary } from '@/data/queries';
import type { LatLng } from '@/lib/geo';
import { haversineMeters } from '@/lib/geo';
import { decodePolyline } from '@/lib/polyline';
import { mpsToMph } from '@/lib/units';

import { tripCopy as copy } from './copy';
import { categoryLabel, describeEvent, formatClock } from './format';

const mph = (mps: number): number => Math.round(mpsToMph(mps));
const seconds = (s: number): string => `${Math.max(1, Math.round(s))} s`;
const gees = (g: number): string => `${Math.abs(g).toFixed(2)} g`;

/**
 * The measured values in plain language (§7.D D3): the numbers the detector actually recorded,
 * in the units the driver reads. A value the row does not hold is never guessed — the line
 * degrades to `describeEvent`, which degrades again to the category name.
 */
export function measuredLine(event: TripEventView): string {
  const m = event.measured;
  switch (event.category) {
    case 'speeding': {
      if (m.speedMps === undefined) return describeEvent(event);
      const at = copy.measured.speed(mph(m.speedMps));
      const zone = m.limitMps === undefined ? null : copy.measured.zone(mph(m.limitMps));
      const held = copy.measured.forSeconds(seconds(event.durationS));
      return [at, zone, held].filter((part) => part !== null).join(' ');
    }
    case 'phone': {
      const held = copy.measured.phone(seconds(event.durationS));
      return m.speedMps === undefined ? held : `${held} ${copy.measured.atSpeed(mph(m.speedMps))}`;
    }
    case 'braking':
      return m.peakG === undefined ? describeEvent(event) : copy.measured.braking(gees(m.peakG));
    case 'accel':
      return m.peakG === undefined ? describeEvent(event) : copy.measured.accel(gees(m.peakG));
    case 'cornering':
      return m.lateralG === undefined
        ? describeEvent(event)
        : copy.measured.cornering(gees(m.lateralG));
    case 'focus':
      if (m.focusKind === 'drowsiness') return copy.measured.drowsiness;
      return m.glanceS === undefined
        ? describeEvent(event)
        : copy.measured.glance(seconds(m.glanceS));
    case null:
      return describeEvent(event);
  }
}

/** The event's own time in the trip's zone, for the timeline's left column. */
export const eventClock = (event: TripEventView, tz: string): string =>
  formatClock(event.startedAt, tz);

export type SeverityWord = 'none' | 'moderate' | 'severe';

/**
 * How hard the event was, as one of two words (plus "none" for an event that scored nothing).
 *
 * The split is `HIGH_SEVERITY` from the tip catalogue — the severity at which each category
 * enters its top bands (§9.3) — rather than a scale invented here, so a tuning change moves the
 * word with the engine. Two words, not five: the driver is told whether this was the bad kind of
 * the behaviour, and the exact numbers are on the row beside it.
 */
export function severityWord(event: TripEventView): SeverityWord {
  const s = event.severity;
  if (s === null || s <= 0 || event.category === null) return 'none';
  return s >= HIGH_SEVERITY[event.category] ? 'severe' : 'moderate';
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * How sure the detector was (§9.4): at or above `Q_FULL_AT` the event is treated as certain, from
 * `Q_UNSCORED_BELOW` up it is scaled down, and below that it does not count at all.
 */
export function confidenceLevel(event: TripEventView): ConfidenceLevel {
  const q = event.confidence ?? 0;
  if (q >= CONSTANTS.Q_FULL_AT) return 'high';
  if (q >= CONSTANTS.Q_UNSCORED_BELOW) return 'medium';
  return 'low';
}

/**
 * Why the app is as sure as it is, in the driver's words (§7.D D3: "GPS accuracy was good · speed
 * limit from map data"). Built from what the row actually holds — the sensor that produced the
 * event, and whether a posted limit was known — never from a stock sentence.
 */
export function confidenceReasons(event: TripEventView): string[] {
  const reasons: string[] = [];
  switch (event.category) {
    case 'speeding':
      reasons.push(copy.why.speedFromGps);
      reasons.push(
        event.measured.limitMps === undefined ? copy.why.noLimit : copy.why.limitFromMap
      );
      break;
    case 'phone':
      reasons.push(copy.why.phoneFromDevice);
      break;
    case 'braking':
    case 'accel':
    case 'cornering':
      reasons.push(copy.why.fromMotion);
      break;
    case 'focus':
      reasons.push(copy.why.fromCamera);
      break;
    case null:
      break;
  }
  if (event.corrected) reasons.push(copy.why.corrected);
  return reasons;
}

/** Why this category matters at all, in one sentence — the "why this matters" line on D3. */
export function whyItMatters(category: EventCategory | null): string | null {
  return category === null ? null : copy.whyItMatters[category];
}

export type EventStanding =
  | 'counted'
  | 'possible'
  | 'reportSending'
  | 'reportAccepted'
  | 'reportRecorded'
  | 'reportClosed'
  | 'reportRefused'
  | 'reportUnsent'
  | 'removed'
  | 'free';

/**
 * The refusal codes that are genuinely about this report and will not change on a retry: the
 * 14-day window, and the two §9.9 input refusals for a moment that was never in the score.
 *
 * `dispute_window_closed` gets its own standing because it has its own explanation. Everything
 * else the server refuses — `not_found`, `ambiguous_event`, an `invalid_payload` this build
 * cannot fix — is a refusal whose reason the screen will not invent; and anything *not* in this
 * list that came from the transport rather than the server (`http_400` through an interfering
 * proxy, a ladder that ran out) leaves the report offerable again.
 */
const FINAL_REFUSALS: readonly string[] = [
  'dispute_window_closed',
  'event_not_scored',
  'trip_not_scored',
  'not_found',
  'ambiguous_event',
  'invalid_payload',
];

/**
 * Where this event stands against the score, which is the one thing every timeline row and every
 * D3 screen has to be honest about.
 *
 * `possible` is the §9.4 low-confidence state: detected, shown, and deliberately costing nothing.
 * The `report*` states are §9.9's outcomes, read from the stored record the sync handler settles
 * — never recomputed here, because the allowance lives on the server. **A refusal is never
 * reported as the window closing unless that is what the server said**: `window_closed` is one
 * code, and the rest keep their own standing and their own words.
 */
export function eventStanding(event: TripEventView): EventStanding {
  const dispute = event.dispute;
  if (dispute !== null) {
    if (dispute.outcome === 'queued') return 'reportSending';
    if (dispute.outcome === 'accepted') return 'reportAccepted';
    if (dispute.outcome === 'denied') return 'reportRecorded';
    if (dispute.outcome === 'window_closed') return 'reportClosed';
    if (dispute.outcome === 'refused') {
      return dispute.code !== null && FINAL_REFUSALS.includes(dispute.code)
        ? 'reportRefused'
        : 'reportUnsent';
    }
  }
  if (event.possible) return 'possible';
  if (event.status === 'removed') return 'removed';
  if (event.status === 'disputed') return 'reportSending';
  return event.affectsScore ? 'counted' : 'free';
}

/** The words for a standing, or null where the row needs no label of its own. */
export function standingLabel(standing: EventStanding): string | null {
  switch (standing) {
    case 'possible':
      return copy.standing.possible;
    case 'reportSending':
      return copy.standing.reportSending;
    case 'reportAccepted':
      return copy.standing.reportAccepted;
    case 'reportRecorded':
      return copy.standing.reportRecorded;
    case 'reportClosed':
      return copy.standing.reportClosed;
    case 'reportRefused':
      return copy.standing.reportRefused;
    case 'reportUnsent':
      return copy.standing.reportUnsent;
    case 'removed':
      return copy.standing.removed;
    case 'counted':
    case 'free':
      return null;
  }
}

/**
 * The sentence that makes a standing fair, for this event.
 *
 * It takes the event rather than the standing alone because §9.9's two rails are different
 * shapes — three reports per rolling seven days, or a fifth of the month's scored moments — and
 * the server says which one it hit. A rail this build does not recognise falls back to the words
 * that are true of both.
 */
export function standingWhy(event: TripEventView): string | null {
  const standing = eventStanding(event);
  if (standing === 'reportRecorded') {
    const rail = event.dispute?.deniedReason;
    if (rail === 'allowance_7d') return copy.standing.reportRecordedWhy7d;
    if (rail === 'allowance_30d') return copy.standing.reportRecordedWhy30d;
    return copy.standing.reportRecordedWhy;
  }
  switch (standing) {
    case 'possible':
      return copy.standing.possibleWhy;
    case 'reportSending':
      return copy.standing.reportSendingWhy;
    case 'reportAccepted':
      return copy.standing.reportAcceptedWhy;
    case 'reportClosed':
      return copy.standing.reportClosedWhy;
    case 'reportRefused':
      return copy.standing.reportRefusedWhy;
    case 'reportUnsent':
      return copy.standing.reportUnsentWhy;
    case 'counted':
    case 'free':
    case 'removed':
      return null;
  }
}

/**
 * Whether D3 may offer "This isn't right".
 *
 * One report per event while one stands — and none at all on a `possible` event: it costs
 * nothing, so there is nothing to take off, and the server refuses every such report with
 * `event_not_scored` (task-2b's own smoke run). Offering a button whose only outcome is a refusal
 * would be steering the driver into a dead end. A report that never left (`reportUnsent`) can be
 * sent again, because nothing about it was ever decided.
 */
export function canReport(event: TripEventView): boolean {
  const standing = eventStanding(event);
  return standing === 'counted' || standing === 'free' || standing === 'reportUnsent';
}

/** One timeline row, with everything the list and the screen reader need already decided. */
export interface TimelineRow {
  event: TripEventView;
  clock: string;
  title: string;
  measured: string;
  severity: SeverityWord;
  confidence: ConfidenceLevel;
  standing: EventStanding;
  /** Points this event cost, or null when it cost nothing. */
  points: number | null;
}

/** The D2 timeline, oldest first — the order the drive happened and the order the repo returns. */
export function timelineRows(
  trip: Pick<TripSummary, 'tz'>,
  events: readonly TripEventView[]
): TimelineRow[] {
  return events.map((event) => {
    const standing = eventStanding(event);
    return {
      event,
      clock: eventClock(event, trip.tz),
      title: event.category === null ? event.rawCategory : categoryLabel(event.category),
      measured: measuredLine(event),
      severity: severityWord(event),
      confidence: confidenceLevel(event),
      standing,
      // What it *costs*, read from the row rather than from the standing: a report that was
      // recorded but not applied leaves the event scored, and saying it cost nothing would be
      // the opposite of honest.
      points: event.affectsScore ? event.deduction : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The route (§7.D D2)
// ---------------------------------------------------------------------------------------------

/**
 * How much of each end of the route is dropped before it is drawn (§22: "Endpoint trim ≈ 200 m,
 * D2, F9"). The driver's home is the most sensitive thing this app holds, and a trip detail is
 * the screen most likely to be photographed and sent to a friend; the timeline still carries
 * every event, so nothing about the drive is lost with the last block of it.
 */
export const TRIM_ENDPOINTS_M = 200;

/** How close an event has to be to a stretch of road for that stretch to be drawn as its own. */
export const EVENT_SEGMENT_RADIUS_M = 150;

/** Drop the first and last `meters` of the line. Both ends, measured along the points. */
export function trimRoute(points: readonly LatLng[], meters: number): LatLng[] {
  if (points.length < 3 || meters <= 0) return [...points];
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [...points];
  const inner = points.filter(
    (p) => haversineMeters(p, first) >= meters && haversineMeters(p, last) >= meters
  );
  // A drive shorter than two trim radii would trim to nothing; showing the middle point alone is
  // no route at all, so the whole line is withheld instead of a misleading fragment.
  return inner.length >= 2 ? inner : [];
}

export interface RouteSegment {
  points: LatLng[];
  /** A speeding episode was recorded along this stretch. */
  over: boolean;
}

/**
 * The route split into the stretches a speeding episode was recorded on and the stretches it was
 * not, so the line can be drawn in two inks *and* two patterns (§14: never colour alone).
 *
 * This is what the stored data supports and no more: the device keeps one polyline for the trip
 * and a location per event, not a speed per point. A stretch is "over" when a scored speeding
 * event sits within `EVENT_SEGMENT_RADIUS_M` of it — which is where the driver was speeding,
 * drawn to the accuracy the row allows.
 */
export function routeSegments(
  points: readonly LatLng[],
  events: readonly TripEventView[],
  radiusM: number = EVENT_SEGMENT_RADIUS_M
): RouteSegment[] {
  if (points.length < 2) return [];
  const speeding = events.filter(
    (event): event is TripEventView & { lat: number; lng: number } =>
      event.category === 'speeding' &&
      event.lat !== null &&
      event.lng !== null &&
      eventStanding(event) === 'counted'
  );
  const over = points.map((point) =>
    speeding.some((event) => haversineMeters(point, { lat: event.lat, lng: event.lng }) <= radiusM)
  );

  const segments: RouteSegment[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    if (!from || !to) continue;
    // A segment belongs to the over-limit line when either end is near an episode, so the two
    // lines meet rather than leaving a gap the map would draw as a break in the road.
    const isOver = over[i - 1] === true || over[i] === true;
    const tail = segments[segments.length - 1];
    if (tail && tail.over === isOver) tail.points.push(to);
    else segments.push({ points: [from, to], over: isOver });
  }
  return segments;
}

/** The trip's drawable route: decoded, trimmed, and empty when there is nothing worth drawing. */
export function routeFor(trip: Pick<TripSummary, 'polyline'>): LatLng[] {
  if (trip.polyline === null || trip.polyline.length === 0) return [];
  const decoded = decodePolyline(trip.polyline);
  return trimRoute(decoded, TRIM_ENDPOINTS_M);
}

/** The region a map has to cover to show every point, with a little air around it. */
export function regionFor(points: readonly LatLng[]): {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
} | null {
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const PAD = 1.4;
  const MIN_DELTA = 0.004;
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(MIN_DELTA, (maxLat - minLat) * PAD),
    longitudeDelta: Math.max(MIN_DELTA, (maxLng - minLng) * PAD),
  };
}

// ---------------------------------------------------------------------------------------------
// The history list (§7.D D4)
// ---------------------------------------------------------------------------------------------

export interface TripDayGroup {
  /** The trip's own local calendar date, `YYYY-MM-DD` — what the header is keyed by. */
  day: string;
  trips: TripSummary[];
}

/**
 * The history grouped by the **trip's own** local day, not the device's: a drive that ended after
 * midnight in another time zone belongs to the date it was driven on, which is the date the
 * server filed its day evaluation under. Groups stay in the order the trips arrived (newest
 * first), so the caller's sort is the list's order.
 */
export function groupTripsByDay(trips: readonly TripSummary[]): TripDayGroup[] {
  const groups: TripDayGroup[] = [];
  for (const trip of trips) {
    const tail = groups[groups.length - 1];
    if (tail && tail.day === trip.day) tail.trips.push(trip);
    else groups.push({ day: trip.day, trips: [trip] });
  }
  return groups;
}

/** A flat list of headers and rows, so one `FlatList` renders the grouped history. */
export type HistoryItem =
  | { kind: 'day'; key: string; day: string }
  | { kind: 'trip'; key: string; trip: TripSummary };

export function historyItems(groups: readonly TripDayGroup[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const group of groups) {
    items.push({ kind: 'day', key: `day:${group.day}`, day: group.day });
    for (const trip of group.trips) {
      items.push({ kind: 'trip', key: `trip:${trip.clientTripId}`, trip });
    }
  }
  return items;
}
