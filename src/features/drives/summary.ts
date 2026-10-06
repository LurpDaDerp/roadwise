/**
 * What the drive summary derives from a drive before anything is drawn: the points state, the
 * itemized breakdown, the streak line, the celebration row and the report reasons. Pure.
 */
import { ACHIEVEMENTS, MULT_CAP, type EventType } from '@scoring';

import { formatMultiplier } from '@/ui';

import { eventName, formatClock, signedPoints } from './format';
import type { LocalDrive, LocalDriveEvent } from './model';

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

// ── Breakdown ───────────────────────────────────────────────────────────────────────────

export type LineTone = 'gain' | 'loss' | 'neutral';

export type BreakdownLine =
  | { kind: 'miles' | 'bonus' | 'mult' | 'net'; key: string; label: string; value: string; tone: LineTone }
  | { kind: 'event'; key: string; label: string; value: string; tone: LineTone; event: LocalDriveEvent; time: string };

const round1 = (n: number) => Math.round(n * 10) / 10;

/** "streak ×1.20 · DMS ×1.25 → ×1.50 (cap)". */
export function multiplierText(streakMult: number, dmsMult: number, mult: number): string {
  const parts = [`streak ${formatMultiplier(streakMult)}`];
  if (dmsMult > 1) parts.push(`DMS ${formatMultiplier(dmsMult)}`);
  const capped = mult >= MULT_CAP - 1e-9;
  return `${parts.join(' · ')} → ${formatMultiplier(mult)}${capped ? ' (cap)' : ''}`;
}

/** What an event currently costs: its own penalty, else the server breakdown's, else unknown. */
function penaltyOf(e: LocalDriveEvent, d: LocalDrive): number | null {
  if (e.disputeStatus === 'accepted') return 0;
  return e.penalty ?? d.result?.breakdown.events.find((x) => x.id === e.id)?.penalty ?? null;
}

/**
 * The itemized lines, top to bottom: safe miles, clean bonus, multiplier, one per event, net.
 * Without a server breakdown yet (an offline estimate) the gains lines are left out and `note`
 * says why; events and the net still show.
 */
export function breakdownLines(
  d: LocalDrive,
  events: readonly LocalDriveEvent[]
): { lines: BreakdownLine[]; note: string | null } {
  const lines: BreakdownLine[] = [];
  const b = d.result?.breakdown ?? null;
  if (b && b.scored) {
    const capNote = b.creditedMiles + 1e-9 < b.safeMiles ? ' (daily cap)' : '';
    lines.push({
      kind: 'miles',
      key: 'miles',
      label: `Safe miles: ${round1(b.creditedMiles)} mi × 10${capNote}`,
      value: signedPoints(Math.round(b.milePoints)),
      tone: 'gain',
    });
    if (b.cleanBonus > 0) {
      lines.push({ kind: 'bonus', key: 'bonus', label: 'Clean-drive bonus', value: signedPoints(b.cleanBonus), tone: 'gain' });
    }
    lines.push({
      kind: 'mult',
      key: 'mult',
      label: `Multiplier: ${multiplierText(b.streakMult, b.dmsMult, b.mult)}`,
      value: `= ${signedPoints(b.gains)}`,
      tone: 'gain',
    });
  }

  const sorted = [...events].sort((x, y) => x.startedAt - y.startedAt);
  for (const e of sorted) {
    const p = penaltyOf(e, d);
    lines.push({
      kind: 'event',
      key: `event-${e.id}`,
      label: eventName(e.type, e.tier),
      time: formatClock(e.startedAt),
      value: e.disputeStatus === 'accepted' ? 'Removed' : p === null ? '—' : signedPoints(-p),
      tone: e.disputeStatus === 'accepted' || p === 0 ? 'neutral' : 'loss',
      event: e,
    });
  }

  const net = d.pointsNet ?? b?.net ?? null;
  if (net !== null) {
    lines.push({ kind: 'net', key: 'net', label: 'Net total', value: signedPoints(net), tone: net < 0 ? 'loss' : net > 0 ? 'gain' : 'neutral' });
  }

  const note = b ? null : 'The full breakdown shows up once this drive is scored.';
  return { lines, note };
}

// ── Streak ──────────────────────────────────────────────────────────────────────────────

export type StreakLine = { text: string; state: 'active' | 'atRisk' | 'frozen'; freezeEarned: boolean } | null;

export function streakLine(d: LocalDrive): StreakLine {
  const s = d.result?.streak;
  if (!s || d.status === 'not_driving' || d.status === 'merged') return null;
  const next = `Streak ${s.after} · next drive ${formatMultiplier(s.nextMult)}`;
  const freezeEarned = s.freezeEarned;
  switch (s.outcome) {
    case 'freeze_used':
      return { text: `Freeze used · streak stays at ${s.after}`, state: 'frozen', freezeEarned };
    case 'at_risk':
      return { text: 'Streak at risk: drive clean next time', state: 'atRisk', freezeEarned };
    case 'reset':
      return { text: 'Streak reset. Your next good drive starts a new one.', state: 'active', freezeEarned };
    case 'restored':
      return { text: `Streak saved! ${next}`, state: 'active', freezeEarned };
    case 'grew':
      return { text: next, state: 'active', freezeEarned };
    case 'none':
      return s.after > 0 ? { text: next, state: s.atRisk ? 'atRisk' : 'active', freezeEarned } : null;
  }
}

// ── Celebrations ────────────────────────────────────────────────────────────────────────

export interface Celebration {
  key: string;
  label: string;
  icon: 'trophy' | 'flag' | 'arrow-up-circle' | 'snow';
}

export function celebrations(d: LocalDrive): Celebration[] {
  const r = d.result;
  if (!r || d.status === 'not_driving' || d.status === 'merged') return [];
  const out: Celebration[] = [];
  if (r.progress.levelUp) out.push({ key: 'level', label: `Level ${r.progress.level}!`, icon: 'arrow-up-circle' });
  for (const id of r.achievements) {
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    out.push({ key: `ach-${id}`, label: a ? a.title : id, icon: 'trophy' });
  }
  for (const c of r.challenges) out.push({ key: `ch-${c.id}`, label: `${c.title} · +100`, icon: 'flag' });
  if (r.streak.freezeEarned) out.push({ key: 'freeze', label: 'Freeze earned', icon: 'snow' });
  return out;
}

// ── Reports ─────────────────────────────────────────────────────────────────────────────

export type ReportReason = 'hazard' | 'wrong_limit' | 'mounted' | 'not_driving';

export const REPORT_LABEL: Record<ReportReason, string> = {
  hazard: 'I braked for a hazard',
  wrong_limit: 'The speed limit was wrong',
  mounted: 'My phone was mounted',
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
          : [];
  return [...specific, 'not_driving'];
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

/** Whether "Wasn't driving" applies at all to this drive. */
export const canMarkNotDriving = (d: LocalDrive): boolean =>
  d.status === 'scored' || d.status === 'pending' || d.status === 'unscored' || d.status === 'failed';

/** "Wasn't driving (2 left this month)". */
export function notDrivingLabel(left: number | null): string {
  if (left === null) return "Wasn't driving";
  return `Wasn't driving (${left} left this month)`;
}
