// The drive state machine (product spec v3 "Starting and ending a drive", plan §1 decision 4).
//
//   idle → recording → finalizing → idle
//
// A drive starts only on `start` (the user's Start Drive tap, at any speed; the host has already
// checked permissions). It ends on `end` (the hold-to-end), by itself once the car has not moved for
// `IDLE_END_S` (`session.autoEndAt`) or at `MAX_DRIVE_MS`, or when the OS reports walking. Every end
// but a prompt hold closes the drive where the car last moved (`closeAtLastMovement`): a manual end
// `MANUAL_CUT_AFTER_S` or more after the idle clock's base is cut too, a sooner one ends at the tap.
// A reducer over one explicit state, driven by 1 Hz rows and a few events through a serialised
// `dispatch`; the only clock is the `ts` on what comes in. Everything the engine wants done —
// persistence, sound, scoring — goes out through callbacks.
import { PHONE_MIN_MPH, type EventType, type Tier } from '@scoring';

import { knownSpeed, limitMphFor, MPS_PER_MPH, ROW_MS, UNKNOWN_LIMIT } from '@/core/detectors/common';
import { MAX_DRIVE_MS } from '@/data/sync/payload';

import type { AdoptedTrip, Engine, EngineDeps, EngineEvent, EngineSnapshot, EngineStatus, TripSession } from './engine.types';
import { appendRow, autoEndAt, closeAtLastMovement, closeSession, createSession, idleSince, noteWarmup, snapshotSession } from './session';
import type { DetectorContext, DetectorSuite, FeatureRow, LimitSample } from './types';

/** Speed-limit tiles are prefetched once per this much distance, never per fix. */
export const PREFETCH_EVERY_M = 1000;
/** Rows between checkpoints (30 s at 1 Hz). */
export const CHECKPOINT_ROWS = 30;
/** At or below this (known) the points may show; above it the UI is locked out. */
export const STOPPED_MPS = PHONE_MIN_MPH * MPS_PER_MPH;
/** A walking report ends the drive only while the car was last known at or below this… */
export const WALK_MAX_SPEED_MPS = 3 * MPS_PER_MPH;
/** …or when the last valid fix is older than this (the car parked where there is no sky). */
export const WALK_STALE_FIX_MS = 60_000;
/** A manual end this long after the idle clock's base (the car standing still) is cut at the last movement. */
export const MANUAL_CUT_AFTER_S = 120;
/** The phone-handling alert, this long after the pickup. */
export const HANDLING_ALERT_MS = 15_000;

interface Seen {
  row: FeatureRow;
  limit: LimitSample;
  limitMph: number | null;
}

const noop = (): void => {};

export function createEngine(deps: EngineDeps): Engine {
  let status: EngineStatus = 'idle';
  let session: TripSession | null = null;
  let suite: DetectorSuite | null = null;
  let seen: Seen | null = null;
  /** The last speed a valid fix reported this drive; the lockout holds on it through a dropout. */
  let lastKnownSpeedMps: number | null = null;
  /** `ts` of the last row with a known speed (a valid fix). */
  let lastKnownSpeedTs: number | null = null;
  let prefetchedAtM: number | null = null;
  let lastAlert: EngineSnapshot['lastAlert'] = null;
  /** Episodes already alerted: one chime per speeding episode, one pickup and one handling alert per phone episode. */
  let chimed: string | null = null;
  let pickupAlerted: string | null = null;
  let handlingAlerted: string | null = null;

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
    for (const fn of listeners) {
      try {
        fn(current);
      } catch (err) {
        deps.onError?.(err);
      }
    }
  }

  function setStatus(next: EngineStatus): void {
    status = next;
    touch();
    notify();
  }

  function report(err: unknown): void {
    if (deps.onError) deps.onError(err);
    else throw err;
  }

  function snapshot(): EngineSnapshot {
    const row = seen?.row ?? null;
    const speed = row === null ? null : knownSpeed(row);
    const open = suite?.openSpeeding() ?? null;
    return Object.freeze({
      status,
      clientTripId: session?.clientTripId ?? null,
      startedAt: session?.startedAt ?? null,
      lastRowTs: row?.ts ?? null,
      speedMps: Math.max(0, speed ?? 0),
      speedKnown: speed !== null,
      limit: Object.freeze({ ...(seen?.limit ?? UNKNOWN_LIMIT) }),
      limitMph: seen?.limitMph ?? null,
      speedingTier: status === 'recording' && open !== null ? open.tier : null,
      stopped: status === 'recording' && speed !== null && speed <= STOPPED_MPS,
      autoEndAt: status === 'recording' && session !== null ? autoEndAt(session) : null,
      distanceM: session?.distanceM ?? 0,
      lockedOut: status === 'recording' && (lastKnownSpeedMps ?? 0) > STOPPED_MPS,
      lastAlert,
    });
  }

  function clearTrip(): void {
    session = null;
    suite = null;
    seen = null;
    lastKnownSpeedMps = null;
    lastKnownSpeedTs = null;
    prefetchedAtM = null;
    lastAlert = null;
    chimed = null;
    pickupAlerted = null;
    handlingAlerted = null;
    touch();
  }

  function alert(id: string, type: EventType, tier: Tier, at: number): void {
    lastAlert = { id, type, tier, at };
    touch();
    try {
      deps.onAlert(lastAlert);
    } catch (err) {
      deps.onError?.(err);
    }
  }

  // --- recording --------------------------------------------------------------------------------

  function maybePrefetch(row: FeatureRow, distanceM: number): void {
    if (!row.gnssValid) return;
    if (prefetchedAtM !== null && distanceM - prefetchedAtM < PREFETCH_EVERY_M) return;
    deps.limits.prefetch(row.lat, row.lng, row.course);
    prefetchedAtM = distanceM;
  }

  /** Persist the rows not yet durable, if any; a failure leaves them pending for the next try. */
  async function checkpoint(s: TripSession): Promise<void> {
    if (s.pending.length === 0) return;
    const n = s.pending.length;
    await deps.onCheckpoint(snapshotSession(s));
    s.pending.splice(0, n);
    s.checkpointTs = s.lastRowTs;
  }

  async function processRow(row: FeatureRow): Promise<void> {
    const s = session as TripSession;
    const det = suite as DetectorSuite;
    const limit = deps.limits.lookup(row.lat, row.lng, row.course) ?? UNKNOWN_LIMIT;
    seen = { row, limit, limitMph: limitMphFor(row, limit) };
    touch();
    noteWarmup(s, row);
    const ctx: DetectorContext = { ...deps.ctx(), warmupEndsAt: s.warmup.endsAt };
    const closed = det.push(row, limit, ctx);
    for (const e of closed) {
      s.events.push(e);
      // The instant events are told as they close (the row after the peak). Speeding and phone
      // episodes were already told while open, below.
      if (e.type === 'hard_brake' || e.type === 'hard_accel' || e.type === 'hard_corner') {
        alert(e.id, e.type, e.tier, row.ts);
      }
    }
    const speeding = det.openSpeeding();
    if (speeding !== null && speeding.confirmed && chimed !== speeding.id) {
      chimed = speeding.id;
      alert(speeding.id, 'speeding', speeding.tier, row.ts);
    }
    const phone = det.openPhone();
    if (phone !== null && phone.confirmed) {
      if (pickupAlerted !== phone.id) {
        pickupAlerted = phone.id;
        alert(phone.id, 'phone_pickup', 'severe', row.ts);
      } else if (handlingAlerted !== phone.id && row.ts - phone.startedAt >= HANDLING_ALERT_MS) {
        handlingAlerted = phone.id;
        alert(phone.id, 'phone_handling', 'moderate', row.ts);
      }
    }
    appendRow(s, row, det.unsafe());
    maybePrefetch(row, s.distanceM);

    const speed = knownSpeed(row);
    if (speed !== null) {
      lastKnownSpeedMps = speed;
      lastKnownSpeedTs = row.ts;
    }
    if (await endIfDue(row.ts + ROW_MS)) return;
    if (s.rowsCount % CHECKPOINT_ROWS === 0) {
      try {
        await checkpoint(s);
      } catch (err) {
        report(err);
      }
    }
  }

  // --- finalizing -------------------------------------------------------------------------------

  /**
   * The automatic end, checked at `t` (a row's end or a tick): at `MAX_DRIVE_MS` (cause `limit`) or
   * at `autoEndAt` (cause `stopped`), cut at the last movement. True when it ended the drive.
   */
  async function endIfDue(t: number): Promise<boolean> {
    const s = session as TripSession;
    if (t - s.startedAt >= MAX_DRIVE_MS) {
      await finalize((open) => closeAtLastMovement(open, 'limit'));
      return true;
    }
    if (t >= autoEndAt(s)) {
      await finalize((open) => closeAtLastMovement(open, 'stopped'));
      return true;
    }
    return false;
  }

  /** The hold (or any manual end) at `ts`: cut when the car had stood still `MANUAL_CUT_AFTER_S` or more. */
  function closeManual(open: TripSession, ts: number): Readonly<TripSession> {
    if (open.moved !== null && ts - idleSince(open) >= MANUAL_CUT_AFTER_S * 1000) return closeAtLastMovement(open, 'manual');
    return closeSession(open, ts, 'manual');
  }

  /**
   * Close the drive and hand it over exactly once. `close` turns the open session into the closed
   * one, after the detectors' last events are in. Whatever fails on the way, the engine returns to
   * idle so the next drive is not lost with this one; the first failure is reported after.
   */
  async function finalize(close: (open: TripSession) => Readonly<TripSession>): Promise<void> {
    const s = session as TripSession;
    const det = suite as DetectorSuite;
    setStatus('finalizing');
    let failure: { err: unknown } | null = null;
    try {
      try {
        await checkpoint(s);
      } catch (err) {
        failure = { err };
      }
      s.events.push(...det.flush());
      await deps.onFinalize(close(s));
    } catch (err) {
      failure ??= { err };
    } finally {
      clearTrip();
      setStatus('idle');
    }
    if (failure !== null) report(failure.err);
  }

  // --- events -----------------------------------------------------------------------------------

  async function start(ts: number, continues: boolean): Promise<void> {
    if (status !== 'idle') return;
    const made = deps.createDetectors();
    session = createSession({ clientTripId: deps.newId(), startedAt: Math.round(ts), continues });
    suite = made;
    setStatus('recording');
    // The trip row exists from the first second: a process death before the first checkpoint
    // (30 rows) still leaves a drive to continue or finalize.
    try {
      await deps.onCheckpoint(snapshotSession(session));
    } catch (err) {
      report(err);
    }
  }

  function adopt(trip: AdoptedTrip): void {
    if (status !== 'idle') return;
    session = {
      ...trip.session,
      track: trip.session.track.slice(),
      events: trip.session.events.slice(),
      pending: trip.session.pending.slice(),
    };
    suite = trip.detectors;
    setStatus('recording');
  }

  async function reduce(e: EngineEvent): Promise<void> {
    switch (e.type) {
      case 'start':
        await start(e.ts, e.continues);
        return;
      case 'adopt':
        adopt(e.trip);
        return;
      case 'row': {
        if (status !== 'recording') return;
        const s = session as TripSession;
        if (s.lastRowTs !== null && e.row.ts <= s.lastRowTs) return;
        // A row that would carry the drive past `MAX_DRIVE_MS` is never taken in: the drive ends first.
        if (e.row.ts + ROW_MS > s.startedAt + MAX_DRIVE_MS) {
          await endIfDue(e.row.ts + ROW_MS);
          return;
        }
        await processRow(e.row);
        return;
      }
      case 'walking': {
        if (status !== 'recording') return;
        const slow = (lastKnownSpeedMps ?? 0) <= WALK_MAX_SPEED_MPS;
        const staleFix = lastKnownSpeedTs === null || e.ts - lastKnownSpeedTs > WALK_STALE_FIX_MS;
        if (slow || staleFix) await finalize((open) => closeAtLastMovement(open, 'walking'));
        return;
      }
      case 'end':
        // A drive already past its automatic end (no row or tick came since) ends as that end would.
        if (status === 'recording' && !(await endIfDue(e.ts))) await finalize((open) => closeManual(open, e.ts));
        return;
      case 'tick':
        if (status === 'recording') await endIfDue(e.ts);
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

  /** The tail of the dispatch chain. A rejected dispatch must not poison the ones behind it. */
  let queue: Promise<void> = Promise.resolve();

  return {
    dispatch(e) {
      const run = queue.then(() => handle(e));
      queue = run.then(noop, noop);
      return run;
    },
    snapshot,
    session: () => (session === null ? null : snapshotSession(session)),
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
