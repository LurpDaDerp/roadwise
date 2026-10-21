/**
 * What the drive summary derives from a drive before anything is drawn: the points state, the
 * points receipt (and the itemized breakdown it is built from) and the report reasons. Pure.
 */
import { driveScore, IDLE_END_S, isDashcamType, LEGACY_POINTS_PER_MILE, MULT_CAP, STREAK_MULT_CAP, type DriveEvent, type EventType } from '@scoring';

import { formatMultiplier } from '@/ui';

import { formatDistance, type Units } from '@/lib/units';

import { eventName, formatClock, signedPoints } from './format';
import type { LocalDrive, LocalDriveEvent } from './model';

// ── End note ────────────────────────────────────────────────────────────────────────────

/**
 * Under the drive's time and distance, on the phone that recorded it: a drive that ended by itself says so, and so
 * does one ended with End after standing still (it ends where the car stopped; phone use while
 * standing still still counts). Null otherwise.
 */
export function endNote(d: Pick<LocalDrive, 'endCause'>): string | null {
  switch (d.endCause) {
    case 'stopped':
      return `Ended on its own after ${Math.round(IDLE_END_S / 60)} min without moving`;
    case 'walking':
      return 'Ended on its own when you walked away';
    case 'limit':
      return 'Ended on its own at the 12-hour limit';
    case 'manual_still':
      return 'Ends where the car stopped. Phone use before End still counts';
    default:
      return null;
  }
}

// ── Points ──────────────────────────────────────────────────────────────────────────────

export type PointsState =
  | { kind: 'points'; value: number; estimate: boolean }
  | { kind: 'pending' }
  | { kind: 'recording' }
  | { kind: 'too_short' }
  | { kind: 'not_scored' }
  | { kind: 'not_driving' }
  | { kind: 'merged'; into: string | null }
  | { kind: 'failed'; value: number | null };

export function pointsState(d: LocalDrive): PointsState {
  switch (d.status) {
    case 'recording':
      return { kind: 'recording' };
    case 'merged':
      return { kind: 'merged', into: d.mergedInto };
    case 'not_driving':
      return { kind: 'not_driving' };
    case 'unscored':
      return d.reason === 'too_short' || d.result?.reason === 'too_short' ? { kind: 'too_short' } : { kind: 'not_scored' };
    case 'failed':
      return { kind: 'failed', value: d.pointsNet };
    case 'pending':
      // The phone already knows a drive under 0.5 mi and under 2 min won't score: say so now, not "Scoring…".
      if (d.reason === 'too_short') return { kind: 'too_short' };
      return d.pointsNet === null ? { kind: 'pending' } : { kind: 'points', value: d.pointsNet, estimate: true };
    case 'scored':
      return { kind: 'points', value: d.pointsNet ?? d.result?.net ?? 0, estimate: d.estimate };
  }
}

/** The short word a history row shows where points would be. */
export function pointsWord(s: PointsState): string | null {
  switch (s.kind) {
    case 'points':
      return null;
    case 'pending':
      return 'Scoring…';
    case 'recording':
      return 'Recording';
    case 'too_short':
      return 'Too short';
    case 'not_scored':
      return 'Not scored';
    case 'not_driving':
      return 'Not driving';
    case 'merged':
      return 'Merged';
    case 'failed':
      return 'Not synced';
  }
}

// ── Drive score ─────────────────────────────────────────────────────────────────────────

/** A drive's event as the scorer reads it: removed once a report took it off. */
export function toScoringEvent(e: LocalDriveEvent): DriveEvent {
  return {
    id: e.id,
    type: e.type,
    tier: e.tier,
    startedAt: e.startedAt,
    durationS: e.durationS,
    ...(e.units !== null ? { units: e.units } : null),
    stoppedInTraffic: e.stoppedInTraffic,
    status: isRemoved(e) ? 'removed' : 'active',
  };
}

/**
 * The drive's score out of 100 (`driveScore`: the weighted average of its categories over its
 * active events, its miles floored at 3, Attention over the miles DashPal watched), shown only
 * where the drive's points total shows: a scored drive, an offline estimate, or one not synced
 * yet that has a total. Null everywhere else (scoring, too short, not scored, not driving,
 * merged, recording) and for a drive with no miles.
 */
export function driveScoreOf(d: LocalDrive, events: readonly LocalDriveEvent[]): number | null {
  const s = pointsState(d);
  const total = s.kind === 'points' || (s.kind === 'failed' && netOf(d) !== null);
  if (!total) return null;
  return driveScore(events.map(toScoringEvent), d.miles, d.watchedMiles);
}

// ── Breakdown ───────────────────────────────────────────────────────────────────────────

export type LineTone = 'gain' | 'loss' | 'neutral';

export type BreakdownLine =
  | { kind: 'miles' | 'bonus' | 'mult' | 'net'; key: string; label: string; value: string; tone: LineTone }
  | { kind: 'event'; key: string; label: string; value: string; tone: LineTone; event: LocalDriveEvent; time: string; cost: number | null };

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The points a breakdown paid per credited safe mile: its recorded `pointsPerMile`, else 10 (a
 * breakdown stored before the rate was recorded earned 10 a mile).
 */
export function pointsPerMileOf(b: { pointsPerMile?: number | null }): number {
  const v = b.pointsPerMile;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : LEGACY_POINTS_PER_MILE;
}

/**
 * "streak ×1.20", or "streak ×1.30 (cap)" at the streak cap; on a DashPal drive
 * "streak ×1.20 · DashPal ×1.25 → ×1.50 (cap)", the cap then being the two together.
 */
export function multiplierText(streakMult: number, dashcamMult = 1, mult = streakMult): string {
  if (dashcamMult <= 1) {
    const capped = streakMult >= STREAK_MULT_CAP - 1e-9;
    return `streak ${formatMultiplier(streakMult)}${capped ? ' (cap)' : ''}`;
  }
  const capped = mult >= MULT_CAP - 1e-9;
  return `streak ${formatMultiplier(streakMult)} · DashPal ${formatMultiplier(dashcamMult)} → ${formatMultiplier(mult)}${capped ? ' (cap)' : ''}`;
}

/** An accepted report took this event off: it no longer counts anywhere. */
export const isRemoved = (e: LocalDriveEvent): boolean => e.removed || e.disputeStatus === 'accepted';

/** What an event currently costs: its own penalty, else the server breakdown's, else unknown. */
function penaltyOf(e: LocalDriveEvent, d: LocalDrive): number | null {
  if (isRemoved(e)) return 0;
  return e.penalty ?? d.result?.breakdown.events.find((x) => x.id === e.id)?.penalty ?? null;
}

/**
 * The itemized lines, top to bottom: safe miles, clean bonus, multiplier, one per event, net.
 * Without a server breakdown yet (an offline estimate) the gains lines are left out and `note`
 * says why; events and the net still show.
 */
export function breakdownLines(
  d: LocalDrive,
  events: readonly LocalDriveEvent[],
  units: Units = 'mi'
): { lines: BreakdownLine[]; note: string | null } {
  const lines: BreakdownLine[] = [];
  const b = d.result?.breakdown ?? null;
  if (b && b.scored) {
    const capNote = b.creditedMiles + 1e-9 < b.safeMiles ? ' (daily cap)' : '';
    // Points are counted per mile, so the formula stays in miles; km drivers see the km too.
    const kmNote = units === 'km' ? ` (${formatDistance(b.creditedMiles, 'km')})` : '';
    lines.push({
      kind: 'miles',
      key: 'miles',
      label: `Safe miles: ${round1(b.creditedMiles)} mi${kmNote} × ${pointsPerMileOf(b)}${capNote}`,
      value: signedPoints(Math.round(b.milePoints)),
      tone: 'gain',
    });
    if (b.cleanBonus > 0) {
      lines.push({ kind: 'bonus', key: 'bonus', label: 'Clean-drive bonus', value: signedPoints(b.cleanBonus), tone: 'gain' });
    }
    lines.push({
      kind: 'mult',
      key: 'mult',
      label: `Multiplier: ${multiplierText(b.streakMult, b.dashcamMult, b.mult)}`,
      value: `= ${signedPoints(b.gains)}`,
      tone: 'gain',
    });
  }

  for (const line of eventLines(d, events)) lines.push(line);

  const net = netOf(d);
  if (net !== null) {
    lines.push({ kind: 'net', key: 'net', label: 'Net total', value: signedPoints(net), tone: net < 0 ? 'loss' : net > 0 ? 'gain' : 'neutral' });
  }

  return { lines, note: b ? null : NO_BREAKDOWN_NOTE };
}

const NO_BREAKDOWN_NOTE = 'The full breakdown shows up once this drive is scored.';

/** The drive's net points: the phone's number, else the server breakdown's, else unknown. */
const netOf = (d: LocalDrive): number | null => d.pointsNet ?? d.result?.breakdown.net ?? null;

/** One line per event, oldest first: what it cost, "Removed" once a report took it off, "—" while unknown. */
function eventLines(d: LocalDrive, events: readonly LocalDriveEvent[]): Extract<BreakdownLine, { kind: 'event' }>[] {
  return [...events]
    .sort((x, y) => x.startedAt - y.startedAt)
    .map((e) => {
      const p = penaltyOf(e, d);
      return {
        kind: 'event',
        key: `event-${e.id}`,
        label: eventName(e.type, e.tier),
        time: formatClock(e.startedAt),
        value: isRemoved(e) ? 'Removed' : p === null ? '—' : signedPoints(-p),
        tone: isRemoved(e) || p === 0 ? 'neutral' : 'loss',
        event: e,
        cost: p,
      };
    });
}

// ── Receipt ─────────────────────────────────────────────────────────────────────────────

/** Entries the receipt shows before "Show more": Earned counts as one, then the deductions. */
export const RECEIPT_MAX_LINES = 3;

export type ReceiptLine = Extract<BreakdownLine, { kind: 'event' }>;

export type Receipt = {
  /** Gross points: safe miles plus any clean bonus, times the multiplier. Null while unknown. */
  earned: number | null;
  /** How `earned` was made, in short parts ("Safe miles 11.8 mi × 20", "Streak ×1.20"). Empty without a server breakdown. */
  detail: string[];
  /** One line per event, oldest first. */
  deductions: ReceiptLine[];
  /** Net points. Null while unknown. */
  total: number | null;
  /** Why the detail is missing (an offline estimate, a drive still uploading). */
  note: string | null;
};

/**
 * The summary's points receipt: Earned (gross gains), one deduction per event, and the total.
 * With a server breakdown, Earned is its gains. Without one (an offline estimate) it is the total
 * plus every active event's cost, when all of those are known; otherwise it is left out.
 */
export function receipt(d: LocalDrive, events: readonly LocalDriveEvent[], units: Units = 'mi'): Receipt {
  const b = d.result?.breakdown ?? null;
  const deductions = eventLines(d, events);
  const total = netOf(d);
  if (b && b.scored) {
    const capNote = b.creditedMiles + 1e-9 < b.safeMiles ? ' (daily cap)' : '';
    const kmNote = units === 'km' ? ` (${formatDistance(b.creditedMiles, 'km')})` : '';
    const mult = multiplierText(b.streakMult, b.dashcamMult, b.mult);
    const detail = [`Safe miles ${round1(b.creditedMiles)} mi${kmNote} × ${pointsPerMileOf(b)}${capNote}`];
    if (b.cleanBonus > 0) detail.push(`Clean bonus ${signedPoints(b.cleanBonus)}`);
    detail.push(mult.charAt(0).toUpperCase() + mult.slice(1));
    return { earned: b.gains, detail, deductions, total, note: null };
  }
  let earned: number | null = null;
  if (total !== null) {
    const costs = events.filter((e) => !isRemoved(e)).map((e) => penaltyOf(e, d));
    if (costs.every((p) => p !== null)) {
      const sum = total + costs.reduce<number>((a, p) => a + (p ?? 0), 0);
      earned = sum >= 0 ? sum : null;
    }
  }
  return { earned, detail: [], deductions, total, note: NO_BREAKDOWN_NOTE };
}

/** "plus 142 points", "minus 10 points", "0 points": a signed amount for a screen reader. */
export function spokenPoints(n: number): string {
  const r = Math.round(n);
  const abs = Math.abs(r).toLocaleString('en-US');
  const unit = Math.abs(r) === 1 ? 'point' : 'points';
  return r > 0 ? `plus ${abs} ${unit}` : r < 0 ? `minus ${abs} ${unit}` : `0 ${unit}`;
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

/** The reasons that make sense for this event type, "wasn't driving" always last. */
export function reportReasons(type: EventType): ReportReason[] {
  const specific: ReportReason[] =
    type === 'hard_brake'
      ? ['hazard']
      : type === 'speeding'
        ? ['wrong_limit']
        : type === 'phone_pickup' || type === 'phone_handling'
          ? ['mounted']
          : isDashcamType(type)
            ? ['camera_wrong']
            : [];
  return [...specific, 'not_driving'];
}

/**
 * The reasons a report on this event can give right now: "I wasn't driving" only where the
 * whole-drive action is allowed. Empty (a hard start or a sharp turn on an older drive) means the
 * event has nothing to report and offers no Report.
 */
export function availableReasons(type: EventType, allowNotDriving: boolean): ReportReason[] {
  return reportReasons(type).filter((r) => r !== 'not_driving' || allowNotDriving);
}

/** Whether an event can still be reported (one report per event). */
export const canReport = (e: LocalDriveEvent): boolean => e.disputeStatus === 'none';

/** "Report sent", "Removed", "Report not accepted: …". */
export function disputeText(e: LocalDriveEvent): string | null {
  switch (e.disputeStatus) {
    case 'none':
      return null;
    case 'pending':
      return 'Report sent';
    case 'accepted':
      return e.disputeMessage ?? 'Report accepted · points returned';
    case 'rejected':
      return e.disputeMessage ? `Not accepted: ${e.disputeMessage}` : 'Report not accepted';
  }
}

/** "Wasn't driving" works only within this long after the drive ended (plan §4). */
export const NOT_DRIVING_WINDOW_MS = 24 * 3_600_000;

/**
 * Whether to offer "Wasn't driving" on this drive. The server allows it only on the latest drive,
 * within 24 h of its end; offering it anywhere else would only bounce back.
 */
export function canMarkNotDriving(d: LocalDrive, latestClientTripId: string | null, now: number): boolean {
  const open = d.status === 'scored' || d.status === 'pending' || d.status === 'unscored' || d.status === 'failed';
  if (!open || latestClientTripId !== d.clientTripId) return false;
  if (now - (d.endedAt ?? d.startedAt) > NOT_DRIVING_WINDOW_MS) return false;
  return notDrivingRefusal(d) === null;
}

/**
 * The server's refusal of a "Wasn't driving" (stored on the trip as `sync_error`), in words.
 * Null for anything else, including upload errors.
 */
export const NOT_DRIVING_REFUSALS: Readonly<Record<string, string>> = {
  not_latest: 'Only your newest drive can be marked as not driving.',
  too_old: 'This drive is more than 24 hours old, so it can’t be marked.',
  no_uses_left: 'You’ve used both “Wasn’t driving” marks this month.',
  already_marked: 'This drive was already marked as not driving.',
};

export function notDrivingRefusal(d: Pick<LocalDrive, 'status' | 'syncError'>): string | null {
  if (d.status === 'not_driving' || d.syncError === null) return null;
  return NOT_DRIVING_REFUSALS[d.syncError] ?? null;
}

/** "Wasn't driving (2 left this month)". */
export function notDrivingLabel(left: number | null): string {
  if (left === null) return "Wasn't driving";
  return `Wasn't driving (${left} left this month)`;
}
