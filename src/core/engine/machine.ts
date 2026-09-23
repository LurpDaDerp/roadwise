// The trip state machine (design §3.1; spec §8.4, §8.5, §8.7–8.9, §13.1, §19.1, Appendix A).
//
//   off ⇄ armed → candidate → recording ⇄ ending → finalizing → armed | off
//                                 └── End (one tap) ──┘
//
// A reducer over one explicit state, driven by 1 Hz rows and OS-style events through a serialised
// `dispatch`. Everything the engine wants done — persistence, scoring, sound — goes out through the
// `EngineDeps` callbacks; the only clock is the `ts` on what comes in.
import { CONSTANTS } from '@scoring';
import type { AlertDecision, Arbiter, ArbiterInput } from '@/core/alerts/types';
import { mergeEvents, type TripDetectors } from '@/core/detectors';
import {
  GNSS_CAP_Q,
  ROW_MS,
  UNKNOWN_LIMIT,
  gnssPoor,
  knownSpeed,
  limitConfidence,
} from '@/core/detectors/common';
import type {
  AdoptedTrip,
  Engine,
  EngineDeps,
  EngineEvent,
  EngineSnapshot,
  EngineStatus,
  StartEvidence,
  StartSource,
  TripRole,
  TripSession,
} from './engine.types';
import { appendRow, closeSession, createSession, noteGap, snapshotSession } from './session';
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

/** Below this the car is stationary: the C8 auto-end clock and the C6 stopped panel both run. */
export const STATIONARY_SPEED_MPS = 0.5;
/** The stopped panel (C6) clears once the car is clearly rolling again. */
export const STOPPED_PANEL_CLEAR_MPS = 3 * MPH;
/** Speed-limit tiles are prefetched once per this much distance, never per fix (§3.5). */
export const PREFETCH_EVERY_M = 1000;
/** Slack for the cumulative fast seconds, which are sums of row spacings. */
const EPSILON_S = 1e-9;
/**
 * A trip that has had no valid fix for this long, on a phone lying still, is parked somewhere GNSS
 * cannot reach (a garage): it goes to `ending` as a stationary one would (plan rev1 I13).
 *
 * Known limitation (E1 review M5, kept by ruling; device-pass item 6): a tunnel longer than this,
 * driven smoothly enough that a mounted phone passes the stillness test, ends the same way. If the
 * drive then resumes inside the gap window, the tunnel's rows become a gap: the events detected in
 * it stay, but its time leaves the exposure, so the per-hour rate reads slightly high. Rare, and
 * the thresholds are tuning-sensitive; revisit with device traces rather than by rule here.
 */
export const NO_FIX_END_S = 600;
/** `gravityStability` at or above this, with no handling and a quiet IMU, reads as a still phone. */
export const STILL_GRAVITY_MIN = 0.95;
/** Each of the six IMU extremes within this (the yaw-rate and jerk extremes on the same bound). */
export const STILL_IMU_MAX_G = 0.05;

/** A row with no fix on a phone that is not moving: the no-fix end's evidence. */
export function stillWithoutFix(row: FeatureRow): boolean {
  return (
    !row.gnssValid &&
    row.gravityStability >= STILL_GRAVITY_MIN &&
    row.handlingScore === 0 &&
    Math.abs(row.aLonMax) <= STILL_IMU_MAX_G &&
    Math.abs(row.aLonMin) <= STILL_IMU_MAX_G &&
    Math.abs(row.aLatMax) <= STILL_IMU_MAX_G &&
    Math.abs(row.aLatMin) <= STILL_IMU_MAX_G &&
    Math.abs(row.yawRateMax) <= STILL_IMU_MAX_G &&
    Math.abs(row.jerkMax) <= STILL_IMU_MAX_G
  );
}

const knownLimit = (limit: LimitSample): number | null =>
  limit.source !== 'unknown' ? limit.limitMps : null;

/**
 * The speeding detector's own confidence for this row (§9.5), so the arbiter judges it the same way.
 * It reaches `Q_FULL_AT` exactly when `limitActionable(limit)` holds and the fix is good — the same
 * line the HUD's limit sign is drawn on (common.ts, Ruling U1-I1).
 */
function rowQuality(row: FeatureRow, limit: LimitSample): number {
  const q = limitConfidence(limit);
  if (q === null || knownSpeed(row) === null) return 0;
  return gnssPoor(row) ? Math.min(q, GNSS_CAP_Q) : q;
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
  evidence: StartEvidence;
  mode: DriveMode;
  role: TripRole;
  /** The confirming event's `ts`, used as the start only when no row exists yet. */
  ts: number;
  /** Whether the last buffered row is *now* and may be alerted on. */
  liveLast: boolean;
}

/** The per-trip detector suite and arbiter, made fresh at confirmation. */
interface TripSuite {
  detectors: TripDetectors;
  arbiter: Arbiter;
}

const noop = (): void => {};

export function createEngine(deps: EngineDeps): Engine {
  let status: EngineStatus = 'off';
  let autoDetect = false;
  let candidate: Candidate | null = null;
  let session: TripSession | null = null;
  let suite: TripSuite | null = null;
  /** The role a trip starts with; `setPassenger` before confirmation lands here. */
  let pendingRole: TripRole = 'driver';
  /** "I'm driving now" said before the trip confirmed (M4); carried onto the session. */
  let pendingStatedDriver = false;
  let seen: Seen | null = null;

  // Per-row derived state while a trip is open. Everything here is recomputed from rows alone.
  /** First row of the current run below `STATIONARY_SPEED_MPS`. */
  let stationarySinceTs: number | null = null;
  let stoppedPanel = false;
  let endingSinceTs: number | null = null;
  /** Where driving stopped when the trip went to `ending`: the gap starts, or the trip ends, here. */
  let pausedAt: number | null = null;
  /** First row of the current run beyond limit + tolerance, for the arbiter's `overForS`. */
  let firstOverTs: number | null = null;
  /**
   * The last speed a valid fix reported this run; null until one has. The lockout (SR2) is
   * judged on it, so a GNSS dropout at 60 mph keeps the HUD locked until a fix says otherwise.
   */
  let lastKnownSpeedMps: number | null = null;
  /** Trip distance at the last prefetch; null until the first fix of a candidate or trip. */
  let prefetchedAtM: number | null = null;
  /** Start of the current stretch of continuous driving, for the break suggestion (§8.7). */
  let continuousSinceTs = 0;
  /** First row of the current run of fix-less rows on a still phone (the no-fix end). */
  let noFixSinceTs: number | null = null;
  /** Set by `adopt` and a rowless resume; cleared by the first row with a known speed. */
  let awaitingSpeedAfterResume = false;

  // --- notification -----------------------------------------------------------------------------
  const listeners = new Set<(snapshot: EngineSnapshot) => void>();
  let version = 0;
  let notified = 0;

  const touch = (): void => {
    version += 1;
  };

  /** A listener's exception is the listener's problem: reported if there is somewhere to, never fatal. */
  function notify(): void {
    if (version === notified) return;
    notified = version;
    const current = snapshot();
    for (const fn of listeners) {
      try {
        fn(current);
      } catch (err) {
        deps.onError?.(err);
      }
    }
  }

  /** Status changes are announced at once, so a subscriber sees `finalizing` while it runs. */
  function setStatus(next: EngineStatus): void {
    status = next;
    touch();
    notify();
  }

  const idle = (): EngineStatus => (autoDetect ? 'armed' : 'off');

  /** Hand a failure to the host, or fail the dispatch with it when there is no host sink. */
  function report(err: unknown): void {
    if (deps.onError) deps.onError(err);
    else throw err;
  }

  /** SR2: recording as the driver, at a last known speed over the lockout. */
  const lockedOut = (): boolean =>
    status === 'recording' &&
    (session?.role ?? pendingRole) === 'driver' &&
    (lastKnownSpeedMps ?? 0) > LOCKOUT_SPEED_MPS;

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
      // The current row's own speed, never the last good one: a tunnel shows unknown (I8).
      speedKnown: row !== null && knownSpeed(row) !== null,
      awaitingSpeedAfterResume,
      limit: Object.freeze({ ...(seen?.limit ?? UNKNOWN_LIMIT) }),
      distanceM: session?.distanceM ?? 0,
      stationarySinceTs,
      lockedOut: lockedOut(),
      stoppedPanel: status === 'recording' && stoppedPanel,
    });
  }

  // --- resets -----------------------------------------------------------------------------------

  /** Forget the per-row state of a stretch of driving; the next row starts every clock afresh. */
  function resetRun(): void {
    stationarySinceTs = null;
    stoppedPanel = false;
    endingSinceTs = null;
    pausedAt = null;
    firstOverTs = null;
    lastKnownSpeedMps = null;
    noFixSinceTs = null;
    awaitingSpeedAfterResume = false;
  }

  /** Forget everything about the candidate or trip that just closed. */
  function clearTrip(): void {
    candidate = null;
    session = null;
    suite = null;
    pendingRole = 'driver';
    pendingStatedDriver = false;
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
    // A row vouches for the time since the row before it, at most one row-length: dense fixes
    // count what they cover, sparse ones cannot claim more than a second each. The first row has
    // nothing before it and stands for a full row-length.
    const coversS = (last === undefined ? ROW_MS : Math.min(row.ts - last.row.ts, ROW_MS)) / 1000;
    c.rows.push({ row, ctx: deps.ctx() });
    seen = { row, limit: seen?.limit ?? UNKNOWN_LIMIT };
    touch();
    maybePrefetch(row, 0);
    // Only a valid fix vouches for speed: an invalid one may carry a stale reading.
    if ((knownSpeed(row) ?? 0) > AUTO_DETECT_CONFIRM_SPEED_MPS) c.fastS += coversS;
    if (c.fastS + EPSILON_S >= AUTO_DETECT_CONFIRM_S) {
      await confirm({
        source: 'auto',
        evidence: 'auto',
        mode: 'auto',
        role: pendingRole,
        ts: row.ts,
        liveLast: true,
      });
    }
  }

  /**
   * Open the trip with its own detectors and arbiter. The rows buffered while it was a candidate
   * belong to it (§8.5 step 2), so they are replayed through the detectors and the accumulators —
   * but not the arbiter: an alert about the past is noise, so only the confirming row may speak.
   */
  async function confirm(c: Confirmation): Promise<void> {
    const buffered = candidate?.rows ?? [];
    const backfillTs = candidate?.backfillTs ?? null;
    const startedAt = backfillTs ?? buffered[0]?.row.ts ?? c.ts;
    // The factories run before anything is assigned: if one throws, there is no session without
    // detectors, and the candidate (rows included) is exactly as it was.
    const made: TripSuite = { detectors: deps.createDetectors(), arbiter: deps.createArbiter() };
    session = createSession({
      clientTripId: deps.newId(),
      mode: c.mode,
      role: c.role,
      startEvidence: c.evidence,
      startedAt,
      startApproximate: backfillTs !== null,
    });
    if (pendingStatedDriver && c.role === 'driver') session.statedDriver = true;
    suite = made;
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

  function arbiterInput(
    row: FeatureRow,
    limit: LimitSample,
    ctx: DetectorContext,
    detectors: TripDetectors
  ): ArbiterInput {
    const limitMps = knownLimit(limit);
    const speed = knownSpeed(row);
    const overMps = limitMps !== null && speed !== null ? Math.max(0, speed - limitMps) : 0;
    if (overMps > SPEEDING_TOLERANCE_MPS) {
      if (firstOverTs === null) firstOverTs = row.ts;
    } else {
      firstOverTs = null;
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
    // A passenger hears nothing (product §8.15): decided and logged, never delivered.
    if ((session as TripSession).role === 'passenger') input.silent = true;
    const phone = detectors.openPhoneEpisode();
    if (phone !== null) input.phoneEpisode = phone;
    const cam = ctx.cameraFocus;
    if (cam) {
      if (cam.kind === 'glance') input.eyesOffS = cam.glanceS;
      else input.drowsy = true;
    }
    return input;
  }

  function deliver(decision: AlertDecision | null, ts: number, detectors: TripDetectors): void {
    if (decision === null) return;
    const s = session as TripSession;
    let delivered = decision;
    if (decision.kind === 'speeding') {
      const id = detectors.openSpeedingEpisodeId();
      if (id !== null) {
        detectors.markAlerted(id, ts);
        delivered = { ...decision, eventId: id };
      }
    }
    s.alerts.push(delivered);
    // The alert is on record either way; a sound or UI failure is the host's, never the row's
    // (SR9: failure while moving is silent).
    try {
      deps.onAlert(delivered);
    } catch (err) {
      deps.onError?.(err);
    }
  }

  /**
   * The stationary clock (C8) and the stopped panel (C6), from this row alone. An unknown speed
   * proves neither motion nor stillness, so it changes nothing: a run already counting keeps
   * counting through the dropout, and one that had not started does not start on it.
   */
  function updateFlags(row: FeatureRow): void {
    const speed = knownSpeed(row);
    if (speed === null) return;
    if (speed < STATIONARY_SPEED_MPS) {
      if (stationarySinceTs === null) stationarySinceTs = row.ts;
    } else {
      stationarySinceTs = null;
    }
    if (
      stationarySinceTs !== null &&
      row.ts + ROW_MS - stationarySinceTs >= STOPPED_PANEL_S * 1000
    ) {
      stoppedPanel = true;
    }
    if (speed > STOPPED_PANEL_CLEAR_MPS) stoppedPanel = false;
  }

  /**
   * Persist what the ring holds beyond the last checkpoint, if anything, and record it. The
   * arbiter's state rides along, so a relaunch resumes with the budget and the mutes it had.
   */
  async function checkpointTail(s: TripSession): Promise<void> {
    const last = s.checkpoints[s.checkpoints.length - 1] ?? null;
    if (s.lastRowTs === null || (last !== null && s.lastRowTs <= last)) return;
    if (suite !== null) s.arbiterState = suite.arbiter.state();
    await deps.onCheckpoint(snapshotSession(s));
    s.checkpoints.push(s.lastRowTs);
  }

  /**
   * "Mute for this drive" is an explicit choice, so it is made durable now rather than at the next
   * cadence point (E1 review M4): a checkpoint of whatever tail there is, carrying the arbiter
   * state — the recorder writes the state even when no row is new. Nothing is written before the
   * trip's first row (there is nothing to adopt). A failed write keeps the mute in memory and is
   * reported; the next checkpoint carries it again.
   */
  async function persistMute(): Promise<void> {
    const s = session;
    if (s === null || suite === null || s.lastRowTs === null) return;
    const last = s.checkpoints[s.checkpoints.length - 1] ?? null;
    s.arbiterState = suite.arbiter.state();
    try {
      await deps.onCheckpoint(snapshotSession(s));
    } catch (err) {
      report(err);
      return;
    }
    if (last === null || s.lastRowTs > last) s.checkpoints.push(s.lastRowTs);
  }

  /** One row of the open trip. `live` is false for a replayed candidate row. */
  async function processRow(
    row: FeatureRow,
    ctx: Omit<DetectorContext, 'mode'>,
    live: boolean
  ): Promise<void> {
    const s = session as TripSession;
    const trip = suite as TripSuite;
    const limit = deps.limits.lookup(row.lat, row.lng, row.course) ?? UNKNOWN_LIMIT;
    seen = { row, limit };
    const speed = knownSpeed(row);
    if (speed !== null) {
      lastKnownSpeedMps = speed;
      awaitingSpeedAfterResume = false;
    }
    touch();
    appendRow(s, row, limit);
    maybePrefetch(row, s.distanceM);
    const full: DetectorContext = { ...ctx, mode: s.mode };
    s.events.push(...trip.detectors.push(row, limit, full));
    const input = arbiterInput(row, limit, full, trip.detectors);
    if (live) deliver(trip.arbiter.consider(input), row.ts, trip.detectors);
    updateFlags(row);
    noFixSinceTs = stillWithoutFix(row) ? (noFixSinceTs ?? row.ts) : null;
    if (
      status === 'recording' &&
      stationarySinceTs !== null &&
      row.ts + ROW_MS - stationarySinceTs >= AUTO_END_STATIONARY_S * 1000
    ) {
      await beginEnding(row.ts);
    } else if (
      status === 'recording' &&
      noFixSinceTs !== null &&
      row.ts + ROW_MS - noFixSinceTs >= NO_FIX_END_S * 1000
    ) {
      // Driving stopped where the fix-less stillness began, as a stationary end trims its idle run.
      await beginEnding(row.ts, noFixSinceTs);
    }
    if (s.rowsCount % CHECKPOINT_S === 0) await checkpointTail(s);
  }

  // --- ending and finalizing --------------------------------------------------------------------

  /** Where driving stopped: the start of an idle stretch still open, else just past the last row. */
  function drivingStoppedTs(s: TripSession): number | null {
    if (stationarySinceTs !== null) return stationarySinceTs;
    return s.lastRowTs !== null ? s.lastRowTs + ROW_MS : null;
  }

  /**
   * Into the gap-merge window. The un-checkpointed tail is persisted now, because the ring evicts
   * by time and a gap can be far longer than the ring.
   */
  async function beginEnding(ts: number, stoppedAt?: number): Promise<void> {
    const s = session as TripSession;
    pausedAt = stoppedAt ?? drivingStoppedTs(s) ?? ts;
    endingSinceTs = ts;
    setStatus('ending');
    await checkpointTail(s);
  }

  const withinGap = (ts: number): boolean =>
    endingSinceTs !== null && ts - endingSinceTs < GAP_MERGE_S * 1000;

  /** Gap-merge: the same trip carries on, with the missing stretch on record (§19.1). */
  function resume(
    ts: number,
    changes?: { mode: DriveMode; role: TripRole },
    resumingSpeedMps?: number
  ): void {
    const s = session as TripSession;
    const fromTs = pausedAt ?? s.startedAt;
    if (ts > fromTs) noteGap(s, fromTs, ts);
    if (changes) {
      s.mode = changes.mode;
      s.role = changes.role;
    }
    resetRun();
    if (resumingSpeedMps === undefined) {
      // No row has spoken for the speed since the gap (U2 gates touch on this meanwhile).
      awaitingSpeedAfterResume = true;
    } else {
      // The fast row that resumes is the speed: subscribers never see an unlocked moment.
      lastKnownSpeedMps = resumingSpeedMps;
    }
    continuousSinceTs = ts;
    setStatus('recording');
  }

  /**
   * Take over a trip the previous process was recording (§19.1), rebuilt from its durable rows.
   * The time since its last durable row is a gap — whatever happened then was not recorded — and
   * the arbiter resumes from the state stored with that checkpoint.
   */
  function adopt(trip: AdoptedTrip, ts: number): void {
    // The factory runs first: if it throws, nothing has changed.
    const arbiter = deps.createArbiter(trip.arbiterState ?? undefined);
    const s: TripSession = {
      ...trip.session,
      rows: trip.session.rows.slice(),
      events: trip.session.events.slice(),
      alerts: trip.session.alerts.slice(),
      gaps: trip.session.gaps.slice(),
      checkpoints: trip.session.checkpoints.slice(),
      arbiterState: trip.arbiterState,
    };
    const fromTs = trip.checkpointTs + ROW_MS;
    // The break clock (§8.7, E1 review M3): a relaunch is not a stop. The current stretch began
    // where the last real gap ended, or at the trip start; the hole the relaunch left counts as
    // driving unless it is as long as a stationary auto-end, which would have ended the stretch.
    const lastGap = s.gaps[s.gaps.length - 1];
    const stretchStart = lastGap?.toTs ?? s.startedAt;
    continuousSinceTs = ts - fromTs >= AUTO_END_STATIONARY_S * 1000 ? ts : stretchStart;
    if (ts > fromTs) noteGap(s, fromTs, ts);
    candidate = null;
    session = s;
    suite = { detectors: trip.detectors, arbiter };
    seen = null;
    prefetchedAtM = null;
    resetRun();
    awaitingSpeedAfterResume = true;
    setStatus('recording');
  }

  /**
   * Close the trip and hand it over exactly once. Whatever fails on the way — the tail
   * checkpoint, the detectors' flush, the finalizer itself — the engine returns to idle so the
   * next drive is not lost with this one; the first failure is thrown after that.
   */
  async function finalize(atTs: number): Promise<void> {
    const s = session as TripSession;
    const trip = suite as TripSuite;
    setStatus('finalizing');
    let failure: { err: unknown } | null = null;
    try {
      // The rows since the last checkpoint must be durable before the finalizer reads the session.
      try {
        await checkpointTail(s);
      } catch (err) {
        failure = { err };
      }
      s.events = mergeEvents([...s.events, ...trip.detectors.flush()]);
      const closed = closeSession(s, pausedAt ?? drivingStoppedTs(s) ?? atTs);
      await deps.onFinalize(closed);
    } catch (err) {
      if (failure === null) failure = { err };
    } finally {
      clearTrip();
      setStatus(idle());
    }
    if (failure !== null) throw failure.err;
  }

  /**
   * Finalize, then run the follow-on (a new candidate or trip) even if finalizing failed, and only
   * then report the failure — a lost upload must never cost the next drive.
   */
  async function finalizeThen(atTs: number, follow: () => Promise<void> | void = noop): Promise<void> {
    let failure: { err: unknown } | null = null;
    try {
      await finalize(atTs);
    } catch (err) {
      failure = { err };
    }
    try {
      await follow();
    } finally {
      if (failure !== null) report(failure.err);
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
      case 'ending': {
        const s = session as TripSession;
        if (s.lastRowTs !== null && row.ts <= s.lastRowTs) return;
        // Not processed, so not looked up: the limit of the road the trip left is not this row's
        // (E1 review M1). A row that resumes the trip is looked up by `processRow` below.
        seen = { row, limit: UNKNOWN_LIMIT };
        touch();
        if (!withinGap(row.ts)) {
          await finalizeThen(row.ts);
        } else if ((knownSpeed(row) ?? 0) > LOCKOUT_SPEED_MPS) {
          resume(row.ts, undefined, knownSpeed(row) ?? undefined);
          await processRow(row, deps.ctx(), true);
        }
        return;
      }
      default:
        return;
    }
  }

  async function onActivity(e: Extract<EngineEvent, { type: 'activity' }>): Promise<void> {
    if (e.walking) {
      if (status === 'recording') await beginEnding(e.ts);
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
        await finalizeThen(e.ts, () => {
          if (autoDetect) openCandidate(e.ts, e.candidateStartTs);
        });
      }
    }
  }

  async function onManualStart(e: Extract<EngineEvent, { type: 'manualStart' }>): Promise<void> {
    const role: TripRole = e.passenger ? 'passenger' : 'driver';
    const start: Confirmation = {
      source: 'manual',
      evidence: e.evidence ?? 'tap',
      mode: e.mode,
      role,
      ts: e.ts,
      liveLast: false,
    };
    switch (status) {
      case 'off':
      case 'armed':
      case 'candidate':
        await confirm(start);
        return;
      case 'ending':
        if (withinGap(e.ts)) resume(e.ts, { mode: e.mode, role });
        else await finalizeThen(e.ts, () => confirm(start));
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
      // Switching back from passenger is the driver saying so ("I'm driving now", M4).
      session.statedDriver = !passenger;
    } else {
      if (pendingRole === role) return;
      pendingRole = role;
      pendingStatedDriver = !passenger;
    }
    touch();
  }

  /** SR7: the mode is set up only while not locked out; `auto` becomes whichever is chosen. */
  function onSetMode(mode: 'mounted' | 'pocket'): void {
    if (status !== 'recording' && status !== 'ending') return;
    if (lockedOut()) return;
    const s = session as TripSession;
    if (s.mode === mode) return;
    s.mode = mode;
    touch();
  }

  /** End (C6) is one tap: whether recording or already in the gap window, the trip closes now. */
  async function onEnd(ts: number): Promise<void> {
    switch (status) {
      case 'candidate':
        discardCandidate();
        return;
      case 'recording':
      case 'ending':
        await finalizeThen(ts);
        return;
      default:
        return;
    }
  }

  async function onTick(ts: number): Promise<void> {
    if (status === 'candidate' && windowClosed(candidate as Candidate, ts)) {
      discardCandidate();
    } else if (status === 'ending' && !withinGap(ts)) {
      await finalizeThen(ts);
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
      case 'setMode':
        onSetMode(e.mode);
        return;
      case 'adopt':
        // Only an idle engine may take a trip over: a candidate or a trip already open owns
        // the drive, and a second recording for the same drive must never exist.
        if (status === 'off' || status === 'armed') adopt(e.trip, e.ts);
        return;
      case 'muteCurrent':
        suite?.arbiter.mute(e.ts);
        return;
      case 'muteForDrive':
        if (suite === null) return;
        suite.arbiter.muteAll(e.ts);
        await persistMute();
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
