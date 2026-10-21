/**
 * What the drive recap derives from a drive before anything is drawn: its score (computed on the
 * phone, never waiting for the server), its merit tier, the state it shows instead when there is no
 * score, its event list and the report reasons. Pure.
 */
import {
  driveMerit,
  driveScore,
  IDLE_END_S,
  isDashcamType,
  NOT_DRIVING_WINDOW_S,
  type DriveEvent,
  type EventType,
  type MeritTier,
} from '@scoring';

import type { Units } from '@/lib/units';

import { recapCopy } from './copy';
import { eventName, formatClock, pickupDetail } from './format';
import type { LocalDrive, LocalDriveEvent } from './model';

// ── Notes under the time and distance ───────────────────────────────────────────────────

/** "Started on its own" for a drive RoadWise noticed by itself; null for one started from Start drive. */
export function startNote(d: Pick<LocalDrive, 'origin'>): string | null {
  return d.origin === 'auto' ? recapCopy.startNote : null;
}

/** How the drive ended, on the phone that recorded it, when it ended by itself (or with End standing still). Null otherwise. */
export function endNote(d: Pick<LocalDrive, 'endCause'>): string | null {
  switch (d.endCause) {
    case 'stopped':
      return recapCopy.endNote.stopped(Math.round(IDLE_END_S / 60));
    case 'walking':
      return recapCopy.endNote.walking;
    case 'limit':
      return recapCopy.endNote.limit;
    case 'manual_still':
      return recapCopy.endNote.manual_still;
    default:
      return null;
  }
}

/** "Started on its own · Ended when you walked away", or either alone, or null. */
export function originLine(d: Pick<LocalDrive, 'origin' | 'endCause'>): string | null {
  const parts = [startNote(d), endNote(d)].filter((s): s is string => s !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ── Score ───────────────────────────────────────────────────────────────────────────────

/** What a drive's score card shows: its score, or the state that stands in for one. */
export type ScoreState =
  | { kind: 'score'; value: number; notSynced: boolean }
  | { kind: 'recording' }
  | { kind: 'too_short' }
  | { kind: 'not_scored' }
  | { kind: 'not_driving' }
  | { kind: 'merged'; into: string | null };

/** Whether a drive has a score to show, before its events are read: scored, uploading or not synced yet, and long enough. */
export type DriveKind = { kind: 'scorable'; notSynced: boolean } | Exclude<ScoreState, { kind: 'score' }>;

export function driveKind(d: LocalDrive): DriveKind {
  const tooShort = d.reason === 'too_short' || d.result?.reason === 'too_short';
  switch (d.status) {
    case 'recording':
      return { kind: 'recording' };
    case 'merged':
      return { kind: 'merged', into: d.mergedInto };
    case 'not_driving':
      return { kind: 'not_driving' };
    case 'unscored':
      return tooShort ? { kind: 'too_short' } : { kind: 'not_scored' };
    case 'failed':
      return tooShort ? { kind: 'too_short' } : { kind: 'scorable', notSynced: true };
    case 'pending':
      return tooShort ? { kind: 'too_short' } : { kind: 'scorable', notSynced: false };
    case 'scored':
      return { kind: 'scorable', notSynced: false };
  }
}

/** A drive's event as the scorer reads it: removed once a report took it off. */
export function toScoringEvent(e: LocalDriveEvent): DriveEvent {
  return {
    id: e.id,
    type: e.type,
    tier: e.tier,
    startedAt: e.startedAt,
    durationS: e.durationS,
    status: isRemoved(e) ? 'removed' : 'active',
    measured: e.measured,
  };
}

/**
 * The drive's score out of 100 (`driveScore`: each category judged per chance over this drive
 * alone, from its active events and its exposure), for a drive that has one: scored, uploading or
 * not synced yet. Null everywhere else and for a drive with no miles.
 */
export function driveScoreOf(d: LocalDrive, events: readonly LocalDriveEvent[]): number | null {
  if (driveKind(d).kind !== 'scorable') return null;
  return driveScore(events.filter(isShownEvent).map(toScoringEvent), d.miles, d.watchedMiles, d.exposure);
}

/** The score card's state: the score, or what stands in for it (a scored drive with no miles reads "Not scored"). */
export function scoreState(d: LocalDrive, events: readonly LocalDriveEvent[]): ScoreState {
  const k = driveKind(d);
  if (k.kind !== 'scorable') return k;
  const value = driveScoreOf(d, events);
  return value === null ? { kind: 'not_scored' } : { kind: 'score', value, notSynced: k.notSynced };
}

/** The word a history row shows where a score would be (null for a score). */
export function stateWord(s: Pick<ScoreState, 'kind'>): string | null {
  switch (s.kind) {
    case 'score':
      return null;
    case 'recording':
      return recapCopy.history.words.recording;
    case 'too_short':
      return recapCopy.history.words.too_short;
    case 'not_scored':
      return recapCopy.history.words.not_scored;
    case 'not_driving':
      return recapCopy.history.words.not_driving;
    case 'merged':
      return recapCopy.history.words.merged;
    default:
      return null;
  }
}

/** The drive's merit tier (score AND distance), null with no score. */
export function meritOf(d: LocalDrive, events: readonly LocalDriveEvent[]): MeritTier | null {
  return driveMerit(driveScoreOf(d, events), d.miles);
}

// ── Events ──────────────────────────────────────────────────────────────────────────────

/** A type no build records any more (an older build's phone handling) is never shown, counted or pinned. */
export const isShownEvent = (e: Pick<LocalDriveEvent, 'type'>): boolean => (e.type as string) !== 'phone_handling';

/** An accepted report took this event off: it no longer counts anywhere. */
export const isRemoved = (e: LocalDriveEvent): boolean => e.removed || e.disputeStatus === 'accepted';

/** Rows the recap's event list shows before "Show more". */
export const EVENT_LIST_MAX = 3;

export interface EventRow {
  key: string;
  label: string;
  time: string;
  /** A phone pickup's time in hand and speed ("In hand 24 s · 38 mph"), and the same in words; null for any other event. */
  detail: { text: string; spoken: string } | null;
  event: LocalDriveEvent;
}

/** The recap's event list: shown events, oldest first. */
export function eventRows(events: readonly LocalDriveEvent[], units: Units = 'mi'): EventRow[] {
  return events
    .filter(isShownEvent)
    .sort((x, y) => x.startedAt - y.startedAt)
    .map((e) => ({
      key: `event-${e.id}`,
      label: eventName(e.type, e.tier),
      time: formatClock(e.startedAt),
      detail: e.type === 'phone_pickup' ? pickupDetail(e, units) : null,
      event: e,
    }));
}

// ── Reports ─────────────────────────────────────────────────────────────────────────────

export type ReportReason = 'hazard' | 'wrong_limit' | 'mounted' | 'camera_wrong' | 'not_driving';

export const REPORT_LABEL: Record<ReportReason, string> = {
  hazard: 'I braked for a hazard',
  wrong_limit: 'The speed limit was wrong',
  mounted: 'My phone was mounted',
  camera_wrong: 'DashPal got it wrong',
  not_driving: "I wasn't driving",
};

/** The event type's own reason, if it has one. */
function specificReason(type: EventType): ReportReason | null {
  switch (type) {
    case 'hard_brake':
      return 'hazard';
    case 'speeding':
      return 'wrong_limit';
    case 'phone_pickup':
      return 'mounted';
    default:
      return isDashcamType(type) ? 'camera_wrong' : null;
  }
}

/** The reasons that make sense for this event type, "wasn't driving" always last. */
export function reportReasons(type: EventType): ReportReason[] {
  const specific = specificReason(type);
  return specific === null ? ['not_driving'] : [specific, 'not_driving'];
}

/**
 * The reasons a report on this event can give right now: "I wasn't driving" only where the
 * whole-drive action is allowed. Empty (a hard start or a sharp turn when it is not) means the
 * event has nothing to report and offers no Report.
 */
export function availableReasons(type: EventType, allowNotDriving: boolean): ReportReason[] {
  return reportReasons(type).filter((r) => r !== 'not_driving' || allowNotDriving);
}

/** Whether an event can still be reported (one report per event). */
export const canReport = (e: LocalDriveEvent): boolean => e.disputeStatus === 'none';

/** "Report sent", "Report accepted · event removed", "Not accepted: …". */
export function disputeText(e: LocalDriveEvent): string | null {
  switch (e.disputeStatus) {
    case 'none':
      return null;
    case 'pending':
      return 'Report sent';
    case 'accepted':
      return e.disputeMessage ?? recapCopy.report.accepted;
    case 'rejected':
      return e.disputeMessage ? `Not accepted: ${e.disputeMessage}` : 'Report not accepted';
  }
}

// ── "Wasn't driving" ────────────────────────────────────────────────────────────────────

/** "Wasn't driving" works only within this long after the drive ended. */
export const NOT_DRIVING_WINDOW_MS = NOT_DRIVING_WINDOW_S * 1000;

/**
 * Whether to offer "Wasn't driving" on this drive: a kept drive the server holds or will hold
 * (scored, not scored, or still uploading: its upload goes ahead of the mark), within a day of its
 * end, whose in-drive "Not driving?" never ran out, and that the server has not already refused. A
 * drive whose upload the server refused (`failed`) is not on the server, so it has nothing to mark.
 * The monthly uses are the caller's to check.
 */
export function canMarkNotDriving(d: LocalDrive, now: number): boolean {
  const kept = d.status === 'scored' || d.status === 'pending' || d.status === 'unscored';
  if (!kept || d.notDrivingExpired) return false;
  if (now - (d.endedAt ?? d.startedAt) > NOT_DRIVING_WINDOW_MS) return false;
  return notDrivingRefusal(d) === null;
}

/** The server's refusals of a "Wasn't driving" (stored on the trip as `sync_error`), in words. */
export const NOT_DRIVING_REFUSALS: Readonly<Record<string, string>> = recapCopy.refusals;

/** The server's refusal of a "Wasn't driving" in words; null for anything else, including upload errors. */
export function notDrivingRefusal(d: Pick<LocalDrive, 'status' | 'syncError'>): string | null {
  if (d.status === 'not_driving' || d.syncError === null) return null;
  return NOT_DRIVING_REFUSALS[d.syncError] ?? null;
}

/** "Wasn't driving (2 left this month)". */
export const notDrivingLabel = recapCopy.notDriving.label;
