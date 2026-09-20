// The trip state machine (design §3.1; spec §8.4, §8.5, §8.7–8.9, §13.1, §19.1, Appendix A).
//
//   off ⇄ armed → candidate → recording ⇄ ending → finalizing → armed | off
//
// A reducer over one explicit state, driven by 1 Hz rows and OS-style events through a serialised
// `dispatch`. Everything the engine wants done — persistence, scoring, sound — goes out through the
// `EngineDeps` callbacks; the only clock is the `ts` on what comes in.
import { CONSTANTS } from '@scoring';
import type { AlertDecision, ArbiterInput } from '@/core/alerts/types';
import { mergeEvents } from '@/core/detectors';
import type {
  Engine,
  EngineDeps,
  EngineEvent,
  EngineSnapshot,
  EngineStatus,
  StartSource,
  TripRole,
  TripSession,
} from './engine.types';
import { ROW_MS, appendRow, closeSession, createSession, noteGap, snapshotSession } from './session';
import type { DetectorContext, DriveMode, FeatureRow, LimitSample } from './types';

const {
  AUTO_DETECT_CONFIRM_S,
  AUTO_DETECT_CONFIRM_SPEED_MPS,
  AUTO_DETECT_WINDOW_S,
  AUTO_END_STATIONARY_S,
  CHECKPOINT_S,
  GAP_MERGE_S,
  LOCKOUT_SPEED_MPS,
  MPH,
  SPEEDING_TOLERANCE_MPS,
  STOPPED_PANEL_S,
} = CONSTANTS;

/** Below this the car is stationary for the C8 auto-end clock. */
export const STATIONARY_SPEED_MPS = 0.5;
/** The stopped panel (C6) clears once the car is clearly rolling again. */
export const STOPPED_PANEL_CLEAR_MPS = 3 * MPH;
/** Speed-limit tiles are prefetched once per this much distance, never per fix (§3.5). */
export const PREFETCH_EVERY_M = 1000;
/** `handlingScore` at or above this reads as the phone being handled — mirrors `phoneUse.ts`. */
const HANDLING_MIN_SCORE = 0.6;

const UNKNOWN_LIMIT: LimitSample = Object.freeze({
  limitMps: null,
  source: 'unknown',
  matchConfidence: 0,
  parallelRoads: false,
});

// --- row quality for the arbiter ---------------------------------------------------------------
// Mirrors the speeding detector's confidence (§9.5): the arbiter only speaks about an episode the
// detector would score in full, so it must judge the row the same way.
const LIMIT_Q: Record<Exclude<LimitSample['source'], 'unknown'>, number> = {
  posted: 0.9,
  cached: 0.8,
  statutory: 0.7,
};
const LIMIT_Q_AMBIGUOUS = 0.6;
const MATCH_CONFIDENCE_MIN = 0.7;
const H_ACC_MAX_M = 20;
const SPEED_ACC_MAX_MPS = 2;
const GNSS_CAP_Q = 0.4;

const knownLimit = (limit: LimitSample): number | null =>
  limit.source !== 'unknown' ? limit.limitMps : null;

const knownSpeed = (row: FeatureRow): number | null =>
  row.gnssValid && row.speed >= 0 ? row.speed : null;

function rowQuality(row: FeatureRow, limit: LimitSample): number {
  if (limit.source === 'unknown' || limit.limitMps === null || knownSpeed(row) === null) return 0;
  const base = LIMIT_Q[limit.source];
  const ambiguous = limit.parallelRoads || limit.matchConfidence < MATCH_CONFIDENCE_MIN;
  const q = ambiguous ? Math.min(base, LIMIT_Q_AMBIGUOUS) : base;
  const gnssPoor = row.hAcc > H_ACC_MAX_M || row.speedAcc > SPEED_ACC_MAX_MPS;
  return gnssPoor ? Math.min(q, GNSS_CAP_Q) : q;
}

// --- state --------------------------------------------------------------------------------------

/** A row seen while a candidate was open, with the context it arrived in. */
interface BufferedRow {
  row: FeatureRow;
  ctx: Omit<DetectorContext, 'mode'>;
}

interface Candidate {
  /** The wake that opened it: the confirmation window is measured from here. */
  startTs: number;
  /** The OS motion-history start, if the wake carried one (§8.5 step 4). */
  backfillTs: number | null;
  rows: BufferedRow[];
  /** Seconds so far over `AUTO_DETECT_CONFIRM_SPEED_MPS`, cumulative. */
  fastS: number;
}

/** The last row shown to the outside world, and the limit it was judged against. */
interface Seen {
  row: FeatureRow;
  limit: LimitSample;
}

interface Confirmation {
  source: StartSource;
  mode: DriveMode;
  role: TripRole;
  /** The confirming event's `ts`, used as the start only when no row exists yet. */
  ts: number;
  /** Whether the last buffered row is *now* and may be alerted on. */
  liveLast: boolean;
}

const noop = (): void => {};

export function createEngine(deps: EngineDeps): Engine {
  let status: EngineStatus = 'off';
  let autoDetect = false;
  let candidate: Candidate | null = null;
  let session: TripSession | null = null;
  /** The role a trip starts with; `setPassenger` before confirmation lands here. */
  let pendingRole: TripRole = 'driver';
  let seen: Seen | null = null;

  // Per-row derived state while a trip is open. Everything here is recomputed from rows alone.
  let stationarySinceTs: number | null = null;
  let zeroSinceTs: number | null = null;
  let stoppedPanel = false;
  let endingSinceTs: number | null = null;
  /** First row of the current run beyond limit + tolerance, for the arbiter's `overForS`. */
  let firstOverTs: number | null = null;
  /** The current run of handling rows, offered to the arbiter as a phone episode. */
  let handling: { id: string; rows: number } | null = null;
  /** Trip distance at the last prefetch; null until the first fix of a candidate or trip. */
  let prefetchedAtM: number | null = null;
  /** Start of the current stretch of continuous driving, for the break suggestion (§8.7). */
  let continuousSinceTs = 0;

  // --- notification -----------------------------------------------------------------------------
  const listeners = new Set<(snapshot: EngineSnapshot) => void>();
  let version = 0;
  let notified = 0;

  const touch = (): void => {
    version += 1;
  };

  function notify(): void {
    if (version === notified) return;
    notified = version;
    const current = snapshot();
    for (const fn of listeners) fn(current);
  }

  /** Status changes are announced at once, so a subscriber sees `finalizing` while it runs. */
  function setStatus(next: EngineStatus): void {
    status = next;
    touch();
    notify();
  }

  const idle = (): EngineStatus => (autoDetect ? 'armed' : 'off');

  function snapshot(): EngineSnapshot {
    const row = seen?.row ?? null;
    const speed = row?.speed ?? 0;
    const role = session?.role ?? pendingRole;
    return Object.freeze({
      status,
      mode: session?.mode ?? 'auto',
      role,
      clientTripId: session?.clientTripId ?? null,
      startedAt: session?.startedAt ?? null,
      lastRowTs: row?.ts ?? null,
      speedMps: Math.max(0, speed),
      limit: Object.freeze({ ...(seen?.limit ?? UNKNOWN_LIMIT) }),
      distanceM: session?.distanceM ?? 0,
      stationarySinceTs,
      lockedOut: status === 'recording' && speed > LOCKOUT_SPEED_MPS && role === 'driver',
      stoppedPanel: status === 'recording' && stoppedPanel,
    });
  }

  // --- resets -----------------------------------------------------------------------------------

  /** Forget the per-row state of a stretch of driving; the next row starts every clock afresh. */
  function resetRun(): void {
    stationarySinceTs = null;
    zeroSinceTs = null;
    stoppedPanel = false;
    endingSinceTs = null;
    firstOverTs = null;
    handling = null;
  }

  /** Forget everything about the candidate or trip that just closed. */
  function clearTrip(): void {
    candidate = null;
    session = null;
    pendingRole = 'driver';
    seen = null;
    prefetchedAtM = null;
    resetRun();
    touch();
  }

  // --- candidate --------------------------------------------------------------------------------

  function openCandidate(startTs: number, backfillTs: number | undefined): void {
    candidate = { startTs, backfillTs: backfillTs ?? null, rows: [], fastS: 0 };
    setStatus('candidate');
  }

  /** Not a drive after all: nothing is kept and nobody is told (§8.5 step 3). */
  function discardCandidate(): void {
    clearTrip();
    setStatus(idle());
  }

  const windowClosed = (c: Candidate, ts: number): boolean =>
    ts - c.startTs >= AUTO_DETECT_WINDOW_S * 1000;

  async function onCandidateRow(row: FeatureRow): Promise<void> {
    const c = candidate as Candidate;
    if (windowClosed(c, row.ts)) {
      discardCandidate();
      return;
    }
    const last = c.rows[c.rows.length - 1];
    if (last !== undefined && row.ts <= last.row.ts) return;
    c.rows.push({ row, ctx: deps.ctx() });
    seen = { row, limit: seen?.limit ?? UNKNOWN_LIMIT };
    touch();
    maybePrefetch(row, 0);
    if (row.speed > AUTO_DETECT_CONFIRM_SPEED_MPS) c.fastS += 1;
    if (c.fastS >= AUTO_DETECT_CONFIRM_S) {
      await confirm({ source: 'auto', mode: 'auto', role: pendingRole, ts: row.ts, liveLast: true });
    }
  }

  /**
   * Open the trip. The rows buffered while it was a candidate belong to it (§8.5 step 2), so they
   * are replayed through the detectors and the accumulators — but not the arbiter: an alert about
   * the past is noise, so only the confirming row itself may speak.
   */
  async function confirm(c: Confirmation): Promise<void> {
    const buffered = candidate?.rows ?? [];
    const backfillTs = candidate?.backfillTs ?? null;
    const startedAt = backfillTs ?? buffered[0]?.row.ts ?? c.ts;
    session = createSession({
      clientTripId: deps.newId(),
      mode: c.mode,
      role: c.role,
      startSource: c.source,
      startedAt,
      startApproximate: backfillTs !== null,
    });
    candidate = null;
    resetRun();
    continuousSinceTs = startedAt;
    setStatus('recording');
    for (const [i, entry] of buffered.entries()) {
      await processRow(entry.row, entry.ctx, c.liveLast && i === buffered.length - 1);
    }
  }

  // --- recording --------------------------------------------------------------------------------

  function maybePrefetch(row: FeatureRow, distanceM: number): void {
    if (!row.gnssValid) return;
    if (prefetchedAtM !== null && distanceM - prefetchedAtM < PREFETCH_EVERY_M) return;
    deps.limits.prefetch(row.lat, row.lng, row.course);
    prefetchedAtM = distanceM;
  }

  function arbiterInput(row: FeatureRow, limit: LimitSample, ctx: DetectorContext): ArbiterInput {
    const limitMps = knownLimit(limit);
    const speed = knownSpeed(row);
    const overMps = limitMps !== null && speed !== null ? Math.max(0, speed - limitMps) : 0;
    if (overMps > SPEEDING_TOLERANCE_MPS) {
      if (firstOverTs === null) firstOverTs = row.ts;
    } else {
      firstOverTs = null;
    }
    if (speed !== null && row.handlingScore >= HANDLING_MIN_SCORE) {
      handling = handling ? { id: handling.id, rows: handling.rows + 1 } : { id: `phone@${row.ts}`, rows: 1 };
    } else {
      handling = null;
    }
    const input: ArbiterInput = {
      ts: row.ts,
      speedMps: speed ?? 0,
      limitMps,
      overMps,
      overForS: firstOverTs === null ? 0 : (row.ts - firstOverTs) / 1000,
      q: rowQuality(row, limit),
      drivingS: (row.ts - continuousSinceTs) / 1000,
    };
    if (handling !== null) input.phoneEpisode = { id: handling.id, durationS: handling.rows };
    const cam = ctx.cameraFocus;
    if (cam) {
      if (cam.kind === 'glance') input.eyesOffS = cam.glanceS;
      else input.drowsy = true;
    }
    return input;
  }

  function deliver(decision: AlertDecision | null, ts: number): void {
    if (decision === null) return;
    const s = session as TripSession;
    let delivered = decision;
    if (decision.kind === 'speeding') {
      const id = deps.detectors.openSpeedingEpisodeId();
      if (id !== null) {
        deps.detectors.markAlerted(id, ts);
        delivered = { ...decision, eventId: id };
      }
    }
    s.alerts.push(delivered);
    deps.onAlert(delivered);
  }

  /** The C8 stationary clock and the C6 stopped panel, from this row alone. */
  function updateFlags(row: FeatureRow): void {
    const speed = row.speed;
    // An unknown speed (-1) cannot prove motion, so it keeps the stationary clock running.
    if (speed < STATIONARY_SPEED_MPS) {
      if (stationarySinceTs === null) stationarySinceTs = row.ts;
    } else {
      stationarySinceTs = null;
    }
    if (speed === 0) {
      if (zeroSinceTs === null) zeroSinceTs = row.ts;
    } else {
      zeroSinceTs = null;
    }
    if (zeroSinceTs !== null && row.ts + ROW_MS - zeroSinceTs >= STOPPED_PANEL_S * 1000) {
      stoppedPanel = true;
    }
    if (speed > STOPPED_PANEL_CLEAR_MPS) stoppedPanel = false;
  }

  /** One row of the open trip. `live` is false for a replayed candidate row. */
  async function processRow(
    row: FeatureRow,
    ctx: Omit<DetectorContext, 'mode'>,
    live: boolean
  ): Promise<void> {
    const s = session as TripSession;
    const limit = deps.limits.lookup(row.lat, row.lng, row.course) ?? UNKNOWN_LIMIT;
    seen = { row, limit };
    touch();
    appendRow(s, row, limit);
    maybePrefetch(row, s.distanceM);
    const full: DetectorContext = { ...ctx, mode: s.mode };
    s.events.push(...deps.detectors.push(row, limit, full));
    const input = arbiterInput(row, limit, full);
    if (live) deliver(deps.arbiter.consider(input), row.ts);
    updateFlags(row);
    if (
      status === 'recording' &&
      stationarySinceTs !== null &&
      row.ts + ROW_MS - stationarySinceTs >= AUTO_END_STATIONARY_S * 1000
    ) {
      beginEnding(row.ts);
    }
    if (s.rowsCount % CHECKPOINT_S === 0) {
      await deps.onCheckpoint(snapshotSession(s));
      s.checkpoints.push(row.ts);
    }
  }

  // --- ending and finalizing --------------------------------------------------------------------

  function beginEnding(ts: number): void {
    endingSinceTs = ts;
    setStatus('ending');
  }

  const withinGap = (ts: number): boolean =>
    endingSinceTs !== null && ts - endingSinceTs < GAP_MERGE_S * 1000;

  /** Gap-merge: the same trip carries on, with the missing stretch on record (§19.1). */
  function resume(ts: number, changes?: { mode: DriveMode; role: TripRole }): void {
    const s = session as TripSession;
    const fromTs = s.lastRowTs !== null ? s.lastRowTs + ROW_MS : s.startedAt;
    if (ts > fromTs) noteGap(s, fromTs, ts);
    if (changes) {
      s.mode = changes.mode;
      s.role = changes.role;
    }
    resetRun();
    continuousSinceTs = ts;
    setStatus('recording');
  }

  /**
   * Close the trip and hand it over exactly once. The finalizer may fail; the engine still
   * returns to idle so the next drive is not lost with it.
   */
  async function finalize(atTs: number): Promise<void> {
    const s = session as TripSession;
    setStatus('finalizing');
    s.events = mergeEvents([...s.events, ...deps.detectors.flush()]);
    const closed = closeSession(s, s.lastRowTs !== null ? s.lastRowTs + ROW_MS : atTs);
    try {
      await deps.onFinalize(closed);
    } finally {
      clearTrip();
      setStatus(idle());
    }
  }

  // --- events -----------------------------------------------------------------------------------

  async function onRow(row: FeatureRow): Promise<void> {
    switch (status) {
      case 'candidate':
        await onCandidateRow(row);
        return;
      case 'recording': {
        const s = session as TripSession;
        if (s.lastRowTs !== null && row.ts <= s.lastRowTs) return;
        await processRow(row, deps.ctx(), true);
        return;
      }
      case 'ending':
        seen = { row, limit: seen?.limit ?? UNKNOWN_LIMIT };
        touch();
        if (!withinGap(row.ts)) {
          await finalize(row.ts);
        } else if (row.speed > LOCKOUT_SPEED_MPS) {
          resume(row.ts);
          await processRow(row, deps.ctx(), true);
        }
        return;
      default:
        return;
    }
  }

  async function onActivity(e: Extract<EngineEvent, { type: 'activity' }>): Promise<void> {
    if (e.walking) {
      if (status === 'recording') beginEnding(e.ts);
      else if (status === 'candidate') discardCandidate();
      return;
    }
    if (!e.automotive) return;
    if (status === 'armed') {
      openCandidate(e.ts, e.candidateStartTs);
    } else if (status === 'ending') {
      if (withinGap(e.ts)) {
        resume(e.ts);
      } else {
        await finalize(e.ts);
        if (autoDetect) openCandidate(e.ts, e.candidateStartTs);
      }
    }
  }

  async function onManualStart(e: Extract<EngineEvent, { type: 'manualStart' }>): Promise<void> {
    const role: TripRole = e.passenger ? 'passenger' : 'driver';
    const start: Confirmation = { source: 'manual', mode: e.mode, role, ts: e.ts, liveLast: false };
    switch (status) {
      case 'off':
      case 'armed':
      case 'candidate':
        await confirm(start);
        return;
      case 'ending':
        if (withinGap(e.ts)) {
          resume(e.ts, { mode: e.mode, role });
        } else {
          await finalize(e.ts);
          await confirm(start);
        }
        return;
      default:
        // Already recording: the tap changes nothing (§8.4).
        return;
    }
  }

  function onSetPassenger(passenger: boolean): void {
    const role: TripRole = passenger ? 'passenger' : 'driver';
    if (session !== null) {
      if (session.role === role) return;
      session.role = role;
    } else {
      if (pendingRole === role) return;
      pendingRole = role;
    }
    touch();
  }

  async function onEnd(ts: number): Promise<void> {
    switch (status) {
      case 'candidate':
        discardCandidate();
        return;
      case 'recording':
        beginEnding(ts);
        return;
      case 'ending':
        await finalize(ts);
        return;
      default:
        return;
    }
  }

  async function onTick(ts: number): Promise<void> {
    if (status === 'candidate' && windowClosed(candidate as Candidate, ts)) {
      discardCandidate();
    } else if (status === 'ending' && !withinGap(ts)) {
      await finalize(ts);
    }
  }

  async function reduce(e: EngineEvent): Promise<void> {
    switch (e.type) {
      case 'arm':
        autoDetect = true;
        if (status === 'off') setStatus('armed');
        return;
      case 'disarm':
        autoDetect = false;
        if (status === 'armed') setStatus('off');
        else if (status === 'candidate') discardCandidate();
        return;
      case 'wake':
        if (status === 'armed') openCandidate(e.ts, e.candidateStartTs);
        return;
      case 'activity':
        await onActivity(e);
        return;
      case 'manualStart':
        await onManualStart(e);
        return;
      case 'row':
        await onRow(e.row);
        return;
      case 'setPassenger':
        onSetPassenger(e.passenger);
        return;
      case 'end':
        await onEnd(e.ts);
        return;
      case 'tick':
        await onTick(e.ts);
        return;
    }
  }

  async function handle(e: EngineEvent): Promise<void> {
    try {
      await reduce(e);
    } finally {
      notify();
    }
  }

  // --- the engine -------------------------------------------------------------------------------

  /** The tail of the dispatch chain. A rejected dispatch must not poison the ones behind it. */
  let queue: Promise<void> = Promise.resolve();

  return {
    dispatch(e) {
      const run = queue.then(() => handle(e));
      queue = run.then(noop, noop);
      return run;
    },
    snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
