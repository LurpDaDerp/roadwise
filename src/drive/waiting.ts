// The Start card's waiting session (modes plan §3.7). A swipe on Start drive opens the driving
// screen in a "Ready to roll" state and waits for the car to move: 10 mph held 15 s confirms the
// drive (`MANUAL_TRIGGER`), and the drive then starts at the traced-back moment the car pulled away.
// With no driving, a sheet asks "Still planning to drive?" at 2:00, a countdown runs from 4:30, and
// at 5:00 the wait ends quietly with nothing stored. Any touch on the screen starts the 5 min again.
//
// The clock here is the host's (the tap, the touches); the rows carry their own. On iOS native runs
// the wait and the confirmation (`DriveDetect.startWaiting`) and JS keeps only the phases; on
// Android `createWaitingSession` also confirms from the capture's rows, with the same trigger and
// trace-back as native (`@drive-sense` `confirmStep`, `startOf`). Pure: no platform, no timer.
import { CONFIRM_START, confirmStep, startOf, type ConfirmState, type StartSource } from '@drive-sense';

import type { FeatureRow } from '@/core/engine/types';

/** The whole wait (5 min), restarted by every touch. */
export const WAIT_TOTAL_MS = 300_000;
/** "Still planning to drive?" at 2 min. */
export const WAIT_POPUP_MS = 120_000;
/** The final 30 s countdown from 4:30. */
export const WAIT_COUNTDOWN_MS = 270_000;
/** Android: the rows kept for the trace-back. */
export const WAIT_BUFFER_MS = 120_000;

export type WaitingPhase = 'waiting' | 'popup' | 'countdown';

/** What the driving screen draws while waiting. */
export interface WaitingPublic {
  /** Host clock of the tap or the last touch. */
  since: number;
  phase: WaitingPhase;
  /** When the current phase ends (host clock): the popup at since + 2:00, the countdown at since + 4:30, the quiet end at since + 5:00. */
  deadlineAt: number;
  /** The last trusted GPS speed while waiting (m/s); null before one. */
  speedMps: number | null;
  /** The sign while waiting (whole mph); null shows "-". */
  limitMph: number | null;
}

/** The phase `now − since` into a wait, or `expired` at 5 min. */
export function waitingPhaseAt(since: number, now: number): WaitingPhase | 'expired' {
  const t = now - since;
  if (t >= WAIT_TOTAL_MS) return 'expired';
  if (t >= WAIT_COUNTDOWN_MS) return 'countdown';
  if (t >= WAIT_POPUP_MS) return 'popup';
  return 'waiting';
}

/** When `phase` ends for a wait that began at `since`. */
export function waitingDeadline(since: number, phase: WaitingPhase): number {
  if (phase === 'waiting') return since + WAIT_POPUP_MS;
  if (phase === 'popup') return since + WAIT_COUNTDOWN_MS;
  return since + WAIT_TOTAL_MS;
}

/** The next moment the phase changes (or the wait ends), for the host's one timer. */
export function nextWaitingChange(since: number, now: number): number {
  const phase = waitingPhaseAt(since, now);
  return phase === 'expired' ? now : waitingDeadline(since, phase);
}

/** A confirmed drive from the wait: its traced-back start and the rows from there on, oldest first. */
export interface WaitingConfirmation {
  startedAt: number;
  startSource: StartSource;
  /** Where it started (the traced row's fix), when trusted. */
  startFix: { lat: number; lng: number } | null;
  rows: FeatureRow[];
}

export interface WaitingSession {
  /** A capture row (Android): buffers it and returns the confirmation once 10 mph has held 15 s. */
  push(row: FeatureRow): WaitingConfirmation | null;
  /** The rows buffered (the newest `WAIT_BUFFER_MS`), oldest first. */
  buffered(): readonly FeatureRow[];
}

/**
 * The Android wait's confirmation: a rolling `WAIT_BUFFER_MS` buffer and the manual trigger. On the
 * row that confirms, the start is traced back through the buffer (the last stop before the rise, a
 * short red light skipped; else the buffer's first row) and the rows from there are handed back to
 * replay into the new drive.
 */
export function createWaitingSession(): WaitingSession {
  let buffer: FeatureRow[] = [];
  let confirm: ConfirmState = CONFIRM_START;
  let done = false;

  return {
    push(row) {
      if (done) return null;
      const last = buffer[buffer.length - 1];
      if (last !== undefined && row.ts <= last.ts) return null;
      buffer.push(row);
      const cutoff = row.ts - WAIT_BUFFER_MS;
      if (buffer[0]!.ts < cutoff) buffer = buffer.filter((r) => r.ts >= cutoff);
      const step = confirmStep(confirm, row, 'manual');
      confirm = step.state;
      if (!step.confirmed) return null;
      done = true;
      const runStart = confirm.runStartTs ?? row.ts;
      const h = Math.max(0, buffer.findIndex((r) => r.ts >= runStart));
      const s = startOf(buffer, h, 'manual', 0, null);
      return {
        startedAt: s.startedAt,
        startSource: s.startSource,
        startFix: s.startLat === null || s.startLng === null ? null : { lat: s.startLat, lng: s.startLng },
        rows: buffer.slice(s.index),
      };
    },
    buffered: () => buffer,
  };
}
