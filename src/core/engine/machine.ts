// The drive state machine (product spec v3 "Starting and ending a drive", plan §1 decision 4).
//
//   idle → recording → finalizing → idle
//
// A drive starts only on `start` (the user's Start Drive tap, at any speed; the host has already
// checked permissions). It ends on `end` (the hold-to-end), by itself once the car has not moved for
// `IDLE_END_S` (`session.autoEndAt`) or at `MAX_DRIVE_MS`, or when the driver walks away (`motion`
// reports; `motion.ts` W1/W2). Every end but a prompt hold closes the drive where the car last moved
// (`closeAtLastMovement`; a walking end at or before the walk began): a manual end
// `MANUAL_CUT_AFTER_S` or more after the idle clock's base is cut too (its phone use kept whole), a
// sooner one ends at the tap.
// A reducer over one explicit state, driven by 1 Hz rows and a few events through a serialised
// `dispatch`; the only clock is the `ts` on what comes in. Everything the engine wants done —
// persistence, sound, scoring — goes out through callbacks.
import { PHONE_MIN_MPH, type EventType, type Tier } from '@scoring';

import { knownSpeed, limitMphFor, MPS_PER_MPH, ROW_MS, UNKNOWN_LIMIT } from '@/core/detectors/common';
import { MAX_DRIVE_MS } from '@/data/sync/payload';

import type { MotionActivity } from '@drive-sense';

import type { AdoptedTrip, Engine, EngineDeps, EngineEvent, EngineSnapshot, EngineStatus, TripSession } from './engine.types';
import { footReading, ON_FOOT_DROP_MS, shownSpeed, WALK_CONFIRM_MS, WALK_STALE_FIX_MS } from './motion';
import {
  appendRow,
  autoEndAt,
  closeAtLastMovement,
  closeSession,
  createSession,
  DRIVING_SPEED_MPS,
  idleSince,
  noteWarmup,
  snapshotSession,
} from './session';
import type { DetectorContext, DetectorSuite, FeatureRow, LimitSample } from './types';

/** Speed-limit tiles are prefetched once per this much distance, never per fix. */
export const PREFETCH_EVERY_M = 1000;
/** Rows between checkpoints (30 s at 1 Hz). */
export const CHECKPOINT_ROWS = 30;
/** At or below this (known) the points may show; above it the UI is locked out. */
export const STOPPED_MPS = PHONE_MIN_MPH * MPS_PER_MPH;
/** A manual end this long after the idle clock's base (the car standing still) is cut at the last movement. */
export const MANUAL_CUT_AFTER_S = 120;
/** The phone-handling alert, once the pickup's use has lasted this long. */
export const HANDLING_ALERT_MS = 15_000;
/** …and no sooner than this after the pickup alert. */
export const HANDLING_AFTER_PICKUP_MS = 10_000;
/** While a counted screen switch goes on, the handling alert ("Back to RoadWise") repeats this often. */
export const SWITCH_REPEAT_ALERT_MS = 60_000;

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
  /**
   * The latest on-foot report still standing (`motion.ts`): `since` when the walk began, `at` when it
   * arrived, both on the row clock. Null when none, or once cleared or cancelled by driving.
   */
  let foot: { since: number; at: number } | null = null;
  let prefetchedAtM: number | null = null;
  let lastAlert: EngineSnapshot['lastAlert'] = null;
  /** Episodes already alerted: one chime per speeding episode, one pickup and one handling alert per phone episode. */
  let chimed: string | null = null;
  let pickupAlerted: string | null = null;
  let handlingAlerted: string | null = null;
  /** Row clock of the current phone episode's pickup alert, and of its latest phone alert. */
  let pickupAt = 0;
  let lastPhoneAlertAt = 0;

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
      speedMps: row === null || speed === null ? 0 : Math.max(0, shownSpeed(speed, row.speedAcc)),
      speedKnown: speed !== null,
      limit: Object.freeze({ ...(seen?.limit ?? UNKNOWN_LIMIT) }),
      limitMph: seen?.limitMph ?? null,
      speedingTier: status === 'recording' && open !== null ? open.tier : null,
      stopped: status === 'recording' && speed !== null && speed <= STOPPED_MPS,
      autoEndAt: status === 'recording' && session !== null ? autoEndAt(session) : null,
      distanceM: session?.distanceM ?? 0,
      // The last known speed holds the lockout through a dropout, and after an adopt (the rebuilt session's).
      lockedOut: status === 'recording' && (session?.lastSpeed?.mps ?? 0) > STOPPED_MPS,
      lastAlert,
    });
  }

  function clearTrip(): void {
    session = null;
    suite = null;
    seen = null;
    foot = null;
    prefetchedAtM = null;
    lastAlert = null;
    chimed = null;
    pickupAlerted = null;
    handlingAlerted = null;
    pickupAt = 0;
    lastPhoneAlertAt = 0;
    touch();
  }

  function alert(id: string, type: EventType, tier: Tier, at: number, words?: 'switch'): void {
    lastAlert = words === undefined ? { id, type, tier, at } : { id, type, tier, at, words };
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
    // Phone: the pickup alert once per episode ("Back to RoadWise" while a switch counts); the
    // handling alert once its use has lasted 15 s and 10 s have passed since the pickup alert; while
    // a counted switch goes on, the handling alert again every 60 s. Never during an iPhone hold.
    const phone = det.openPhone();
    if (phone !== null && phone.confirmed) {
      const words = phone.phase === 'switching' ? 'switch' : undefined;
      if (pickupAlerted !== phone.id) {
        pickupAlerted = phone.id;
        pickupAt = row.ts;
        lastPhoneAlertAt = row.ts;
        alert(phone.id, 'phone_pickup', 'severe', row.ts, words);
      } else if (phone.phase !== 'hold') {
        const used = (phone.lastUseAt ?? row.ts) - phone.startedAt;
        if (handlingAlerted !== phone.id) {
          if (used >= HANDLING_ALERT_MS && row.ts - pickupAt >= HANDLING_AFTER_PICKUP_MS) {
            handlingAlerted = phone.id;
            lastPhoneAlertAt = row.ts;
            alert(phone.id, 'phone_handling', 'moderate', row.ts, words);
          }
        } else if (phone.phase === 'switching' && row.ts - lastPhoneAlertAt >= SWITCH_REPEAT_ALERT_MS) {
          lastPhoneAlertAt = row.ts;
          alert(phone.id, 'phone_handling', 'moderate', row.ts, 'switch');
        }
      }
    }
    appendRow(s, row, det.unsafe());
    maybePrefetch(row, s.distanceM);

    if (await endIfDue(row.ts + ROW_MS)) return;
    if (await checkFoot(row.ts + ROW_MS)) return;
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

  /**
   * The walking end at `t` (row clock), once the standing on-foot report is `WALK_CONFIRM_MS` old.
   * A report is void for good once the car has been at driving speed at or after the moment its
   * walk began (`session.lastDroveAt` ≥ `since`: two driving rows in a row, the second at or after
   * it), however late the report came: only a walk that began after the car was last at driving
   * speed counts. W1 (the car reached driving speed): unless the last known speed
   * is driving speed and `WALK_STALE_FIX_MS` old or less. W2 (it never did): only once the drive is
   * `ON_FOOT_DROP_MS` old. Cut at the last movement at or before the walk began. True when it
   * ended the drive.
   */
  async function checkFoot(t: number): Promise<boolean> {
    if (foot === null || status !== 'recording') return false;
    const s = session as TripSession;
    // The car drove after the walk began: whatever the report said, it was a misread (or the walk to the car).
    if (s.lastDroveAt !== null && s.lastDroveAt >= foot.since) {
      foot = null;
      return false;
    }
    if (t - foot.at < WALK_CONFIRM_MS) return false;
    if (s.droveAt === null) {
      if (t - s.startedAt < ON_FOOT_DROP_MS) return false;
    } else {
      const last = s.lastSpeed;
      const carDriving = last !== null && last.mps >= DRIVING_SPEED_MPS && t - last.ts <= WALK_STALE_FIX_MS;
      if (carDriving) return false;
    }
    const since = foot.since;
    await finalize((open) => closeAtLastMovement(open, 'walking', { notAfter: since }));
    return true;
  }

  /**
   * An activity report; `ts` is the host's clock, used only before the drive's first row. Only while
   * recording. Every time is on the row clock: the end of the latest row.
   */
  async function onMotion(a: MotionActivity, ts: number): Promise<void> {
    if (status !== 'recording') return;
    const s = session as TripSession;
    const t = seen === null ? ts : seen.row.ts + ROW_MS;
    const reading = footReading(a);
    if (reading === 'clear') foot = null;
    else if (reading === 'onFoot' && foot === null) {
      // A walk that began before the car was last at driving speed (a late or replayed report of
      // the walk to the car, or a misread the driving since contradicts) is void at once in `checkFoot`.
      foot = { since: Math.min(Math.max(a.ts, s.startedAt), t), at: t };
    }
    // A repeat on-foot report (a confidence change, walking to running) keeps the first one's times.
    await checkFoot(t);
  }

  /**
   * The hold (or any manual end) at `ts`: cut when the car had stood still `MANUAL_CUT_AFTER_S` or
   * more, with the phone use while standing still kept (a long red light, End, Start again must not
   * erase a pickup made there).
   */
  function closeManual(open: TripSession, ts: number): Readonly<TripSession> {
    if (open.moved !== null && ts - idleSince(open) >= MANUAL_CUT_AFTER_S * 1000) return closeAtLastMovement(open, 'manual', { keepPhoneUseUntil: ts });
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
    foot = null;
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
    foot = null;
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
      case 'motion':
        await onMotion(e.activity, e.ts);
        return;
      case 'end':
        // A drive already past its automatic end (no row or tick came since) ends as that end would.
        if (status === 'recording' && !(await endIfDue(e.ts))) await finalize((open) => closeManual(open, e.ts));
        return;
      case 'tick':
        if (status === 'recording' && !(await endIfDue(e.ts))) await checkFoot(e.ts);
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
