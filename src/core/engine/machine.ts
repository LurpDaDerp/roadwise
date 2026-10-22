// The drive state machine (product spec "Starting and ending a drive"; modes plan §3.4, §3.9).
//
//   idle → recording → finalizing → idle
//
// A drive starts only on `start` (the host's confirmation: native noticed driving, or the Start
// card's waiting session saw 10 mph held 15 s; `ts` is the traced-back start) or `adopt` (a drive
// the previous process was recording, or a re-opened continuation). It ends on `end` (the
// swipe-to-end, or native's own stop with its cause), by itself once the car has not moved for
// `IDLE_END_S` (`session.autoEndAt`) or at `MAX_DRIVE_MS`, or when the driver walks away, 5 s of
// walking reported with the car at 3 mph or slower, or at a walker's pace with the phone carried
// (`motion` reports; `motion.ts` W1/W2). Every end but a prompt manual one closes the
// drive where the car last moved (`closeAtLastMovement`; a walking end at or before the walk
// began): a manual end `MANUAL_CUT_AFTER_S` or more after the idle clock's base is cut too, a
// sooner one ends at the tap. `cancel` ("Not driving?") discards the drive: never finalized.
//
// Alerts (`deps.onAlert`; the HUD shows `lastAlert`): speeding as the car first passes the speeding
// line, then the chime again while the row stays over it (`speedingRepeatS`, and as the grace
// ends; sounded only, never `lastAlert`); a hard brake, start or turn the row it is confirmed; a
// phone pickup the row it is confirmed, then again (sounded only) as its time in hand reaches 15 s
// and every 60 s more (`detectors/phoneUse.ts`). The halo shakes (`lastShake`) on a hard event and
// a phone pickup as they alert (never on a repeat) and on a speeding episode as its grace ends; two
// on one row are one shake, the later key's. Where a phone alert plays is the host's call.
//
// A reducer over one explicit state, driven by 1 Hz rows and a few events through a serialised
// `dispatch`; the only clock is the `ts` on what comes in. Everything the engine wants done —
// persistence, sound, scoring — goes out through callbacks.
import { MOVING_MIN_MPH, type EventType, type Tier } from '@scoring';

import { speedingRepeatS } from '@/core/alerts/policy';
import { knownSpeed, limitShownMph, MPS_PER_MPH, ROW_MS, UNKNOWN_LIMIT } from '@/core/detectors/common';
import { MAX_DRIVE_MS } from '@/data/sync/payload';

import type { MotionActivity } from '@drive-sense';

import type { AdoptedTrip, AlertEvent, EndCause, Engine, EngineDeps, EngineEvent, EngineSnapshot, EngineStatus, EventShake, TripSession } from './engine.types';
import { nextBearing, NO_BEARING, type DisplayBearing } from './displayBearing';
import { nextDisplayLimit, NO_DISPLAY_LIMIT, type DisplayLimit } from './displayLimit';
import { displayFix, displayRow, type DisplaySpeed } from './displaySpeed';
import { carStillDriving, footReading, ON_FOOT_DROP_MS, WALK_CONFIRM_MS } from './motion';
import { appendRow, autoEndAt, closeAtLastMovement, closeSession, createSession, idleSince, noteWarmup, snapshotSession } from './session';
import type { DetectorContext, DetectorSuite, FeatureRow, LimitSample } from './types';

/** Speed-limit tiles are prefetched once per this much distance, never per fix, and never from a replayed row. */
export const PREFETCH_EVERY_M = 1000;
/** Rows between checkpoints (30 s at 1 Hz). */
export const CHECKPOINT_ROWS = 30;
/** At or below this (known) the car is stopped; above it the UI is locked out. */
export const STOPPED_MPS = MOVING_MIN_MPH * MPS_PER_MPH;
/** A manual end this long after the idle clock's base (the car standing still) is cut at the last movement. */
export const MANUAL_CUT_AFTER_S = 120;
/** The compass takes the GPS course only at this speed or faster (5 mph): slower, the course is noise and the last one holds. */
export const COURSE_MIN_MPS = 5 * MPS_PER_MPH;

/** The speeding episode the alerts follow: its last sound and whether its grace has ended. */
interface SpeedingAlerts {
  id: string;
  /** Row clock of its last sound (the first alert or a repeat). */
  lastSoundAt: number;
  /** Its grace has ended: it is an event (the halo shook for it). */
  graceDone: boolean;
}

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
  /** The speed the screen shows, as of the last fix or row (`displaySpeed.ts`). */
  let shown: DisplaySpeed | null = null;
  /** The limit the sign shows, as of the last row (`displayLimit.ts`). */
  let shownLimit: DisplayLimit = NO_DISPLAY_LIMIT;
  /**
   * The latest on-foot report still standing (`motion.ts`): `since` when the walk began, `at` when it
   * arrived, both on the row clock. Null when none, or once cleared or cancelled by driving.
   */
  let foot: { since: number; at: number } | null = null;
  let prefetchedAtM: number | null = null;
  let lastAlert: EngineSnapshot['lastAlert'] = null;
  /** The latest event the halo shakes on, or null. */
  let lastShake: EventShake | null = null;
  /** The last GPS course taken (`COURSE_MIN_MPS`), held until the next. */
  let course: number | null = null;
  /** The compass's bearing from where the car went (`displayBearing.ts`), held while stopped. */
  let bearing: DisplayBearing = NO_BEARING;
  /** The speeding episode the alerts follow (`speedingAlertsOn`), or null. */
  let speeding: SpeedingAlerts | null = null;

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

  /** The host holds the automatic ends (a Start-card drive still waiting): only the 12 h cap applies. */
  const held = (): boolean => deps.holdEnds?.() === true;

  /** The row being taken in is a replay (`EngineEvent` row `replay`): its alerts are told, never shown or shaken. */
  let replaying = false;

  function snapshot(): EngineSnapshot {
    const row = seen?.row ?? null;
    const speed = row === null ? null : knownSpeed(row);
    const recording = status === 'recording';
    const open = suite?.openSpeeding() ?? null;
    const reading = recording ? (suite?.speedingNow() ?? null) : null;
    return Object.freeze({
      status,
      clientTripId: session?.clientTripId ?? null,
      origin: recording ? (session?.origin ?? null) : null,
      startedAt: session?.startedAt ?? null,
      lastRowTs: row?.ts ?? null,
      speedMps: shown?.mps ?? 0,
      speedAccelMps2: shown?.accel ?? 0,
      speedAt: shown?.kf != null ? shown.at : null,
      // Never "—" during a drive: 0 until the first fix (`displaySpeed.ts`).
      speedKnown: session !== null || shown !== null,
      rowSpeedMps: speed,
      limit: Object.freeze({ ...(seen?.limit ?? UNKNOWN_LIMIT) }),
      limitMph: shownLimit.mph,
      speedingTier: recording && open !== null ? open.tier : null,
      speedingRatio: reading === null ? null : reading.ratio,
      speedingOver: recording && open !== null,
      courseDeg: recording ? course : null,
      bearingDeg: recording ? bearing.deg : null,
      bearingSource: recording && bearing.deg !== null ? 'track' : null,
      lastShake: recording ? lastShake : null,
      stopped: recording && speed !== null && speed <= STOPPED_MPS,
      autoEndAt: recording && session !== null ? (held() ? session.startedAt + MAX_DRIVE_MS : autoEndAt(session)) : null,
      drove: recording && session !== null && session.droveAt !== null,
      distanceM: session?.distanceM ?? 0,
      // The last known speed holds the lockout through a dropout, and after an adopt (the rebuilt session's).
      lockedOut: recording && (session?.lastSpeed?.mps ?? 0) > STOPPED_MPS,
      lastAlert,
    });
  }

  function clearTrip(): void {
    session = null;
    suite = null;
    seen = null;
    shown = null;
    shownLimit = NO_DISPLAY_LIMIT;
    foot = null;
    prefetchedAtM = null;
    lastAlert = null;
    lastShake = null;
    course = null;
    bearing = NO_BEARING;
    speeding = null;
    touch();
  }

  /** An alert the HUD shows (`lastAlert`; never one on a replayed row) and the alert layer plays. */
  function alert(id: string, type: EventType, tier: Tier, at: number): void {
    const event: AlertEvent = { id, type, tier, at };
    if (!replaying) {
      lastAlert = event;
      touch();
    }
    tell(event);
  }

  function tell(event: AlertEvent): void {
    try {
      deps.onAlert(event);
    } catch (err) {
      deps.onError?.(err);
    }
  }

  /** The halo shakes for `key` on the row at `at`; a later shake on the same row replaces it (one shake per row). Never on a replayed row. */
  function shake(key: string, at: number, tier: Tier): void {
    if (replaying) return;
    lastShake = { key, at, tier };
    touch();
  }

  /**
   * Speeding: the alert on the episode's first over row (`lastAlert`); then, while the row stays
   * over the line, the chime again every `speedingRepeatS` and on the row its grace ends (sounded
   * only). The halo shakes as the grace ends: the episode is an event from there.
   */
  function speedingAlertsOn(row: FeatureRow, det: DetectorSuite): void {
    const ep = det.speedingEpisode();
    if (ep === null) {
      speeding = null;
      return;
    }
    const open = det.openSpeeding();
    if (speeding === null || speeding.id !== ep.id) {
      // A new episode (or one a rebuilt drive was already in: past its grace, it does not shake again).
      speeding = { id: ep.id, lastSoundAt: row.ts, graceDone: ep.confirmed };
      if (ep.over && open !== null) alert(ep.id, 'speeding', open.tier, row.ts);
      return;
    }
    if (!ep.over || open === null) return;
    const graceEnds = ep.confirmed && !speeding.graceDone;
    const overMph = det.speedingNow()?.overMph ?? 0;
    const due = row.ts - speeding.lastSoundAt >= speedingRepeatS(overMph, (row.ts - ep.startedAt) / 1000) * 1000;
    if (!graceEnds && !due) return;
    speeding.lastSoundAt = row.ts;
    if (graceEnds) {
      speeding.graceDone = true;
      shake(`${ep.id}:grace`, row.ts, open.tier);
    }
    tell({ id: ep.id, type: 'speeding', tier: open.tier, at: row.ts, repeat: true });
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
    const limit = deps.limits.lookup(row.lat, row.lng, row.course, { gnssValid: row.gnssValid, speedMps: knownSpeed(row) }) ?? UNKNOWN_LIMIT;
    // The sign's number: a posted limit or a confident class default. The detectors judge the row
    // against `limit` themselves (`limitMphFor`), which refuses a default.
    seen = { row, limit, limitMph: limitShownMph(row, limit) };
    const speedMps = knownSpeed(row);
    if (row.course >= 0 && row.course <= 360 && speedMps !== null && speedMps >= COURSE_MIN_MPS) course = row.course % 360;
    // Replayed rows too: where the car went is a fact, whenever it is taken in.
    bearing = nextBearing(bearing, row);
    shown = displayRow(shown, row, knownSpeed(row));
    shownLimit = nextDisplayLimit(shownLimit, row.ts, seen.limitMph);
    touch();
    noteWarmup(s, row);
    const ctx: DetectorContext = { ...deps.ctx(), warmupEndsAt: s.warmup.endsAt };
    const closed = det.push(row, limit, ctx);
    s.events.push(...closed);
    // A hard brake, start or turn is told the row it is confirmed (one alert per episode, its tier
    // so far), never when its event is released after the veto window: the detector tells every
    // episode that counts on or before the row that releases it.
    for (const a of det.harshAlerts()) {
      alert(a.id, a.type, a.tier, row.ts);
      shake(a.id, row.ts, a.tier);
    }
    speedingAlertsOn(row, det);
    // A phone pickup: the alert (`lastAlert`) and the shake the row it confirms; a repeat is sounded only.
    for (const a of det.phoneAlerts()) {
      if (a.repeat) {
        tell({ id: a.id, type: 'phone_pickup', tier: a.tier, at: row.ts, repeat: true });
      } else {
        alert(a.id, 'phone_pickup', a.tier, row.ts);
        shake(a.id, row.ts, a.tier);
      }
    }
    appendRow(s, row, { unsafe: det.unsafe(), limitUsable: det.speedingNow() !== null, platform: ctx.platform });
    // A replayed row is where the car was, not where it is going: the tiles ahead are asked for from
    // the first live row (the drive's distance so far does not count against it).
    if (!replaying) maybePrefetch(row, s.distanceM);

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
   * at `autoEndAt` (cause `stopped`), cut at the last movement. True when it ended the drive. A
   * replayed row never runs the `stopped` end while the drive has not yet been at driving speed
   * (`droveAt` null): a traced start can sit minutes of crawl before the rows that confirmed the
   * drive, and those rows come later in the same replay. The first live row or tick judges it.
   */
  async function endIfDue(t: number): Promise<boolean> {
    const s = session as TripSession;
    if (t - s.startedAt >= MAX_DRIVE_MS) {
      await finalize((open) => closeAtLastMovement(open, 'limit'));
      return true;
    }
    if (held()) return false;
    if (replaying && s.droveAt === null) return false;
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
   * speed counts. W1 (the car reached driving speed): unless the car may still be driving
   * (`carStillDriving`: the last known speed over 3 mph and `WALK_STALE_FIX_MS` old or less, a
   * walker's own pace from a carried phone excepted). W2 (it never did): only once the drive
   * is `ON_FOOT_DROP_MS` old. Cut at the last movement at or before the walk began. True when it
   * ended the drive.
   */
  async function checkFoot(t: number): Promise<boolean> {
    if (foot === null || status !== 'recording' || held()) return false;
    const s = session as TripSession;
    // The car drove after the walk began: whatever the report said, it was a misread (or the walk to the car).
    if (s.lastDroveAt !== null && s.lastDroveAt >= foot.since) {
      foot = null;
      return false;
    }
    if (t - foot.at < WALK_CONFIRM_MS) return false;
    if (s.droveAt === null) {
      if (t - s.startedAt < ON_FOOT_DROP_MS) return false;
    } else if (carStillDriving(s.lastSpeed, t)) {
      return false;
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

  /** The End swipe (or any manual end) at `ts`: cut when the car had stood still `MANUAL_CUT_AFTER_S` or more. */
  function closeManual(open: TripSession, ts: number): Readonly<TripSession> {
    if (open.moved !== null && ts - idleSince(open) >= MANUAL_CUT_AFTER_S * 1000) return closeAtLastMovement(open, 'manual');
    return closeSession(open, ts, 'manual');
  }

  /** The end event: a manual end without a cause; native's own stop (its cause) is cut at the last movement. */
  function closeEnd(open: TripSession, ts: number, cause: EndCause | undefined): Readonly<TripSession> {
    return cause === undefined || cause === 'manual' ? closeManual(open, ts) : closeAtLastMovement(open, cause);
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

  /**
   * "Not driving?": the drive is discarded, never finalized. `finalizing` while the host drops what
   * was stored (so the routes see a drive closing), then idle; a failure is reported after.
   */
  async function cancel(): Promise<void> {
    const s = session as TripSession;
    setStatus('finalizing');
    let failure: { err: unknown } | null = null;
    try {
      await deps.onCancel(snapshotSession(s));
    } catch (err) {
      failure = { err };
    } finally {
      clearTrip();
      setStatus('idle');
    }
    if (failure !== null) report(failure.err);
  }

  /** The drive goes from memory, unended: what it holds is checkpointed, and storage keeps it `recording`. */
  async function release(): Promise<void> {
    const s = session as TripSession;
    try {
      await deps.onCheckpoint(snapshotSession(s));
    } catch (err) {
      report(err);
    } finally {
      clearTrip();
      setStatus('idle');
    }
  }

  // --- events -----------------------------------------------------------------------------------

  async function start(e: Extract<EngineEvent, { type: 'start' }>): Promise<void> {
    if (status !== 'idle') return;
    foot = null;
    const made = deps.createDetectors();
    session = createSession({
      clientTripId: e.clientTripId ?? deps.newId(),
      startedAt: Math.round(e.ts),
      origin: e.origin,
      continues: e.continues,
      startSource: e.startSource ?? null,
      startPlace: e.startPlace ?? null,
    });
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
        await start(e);
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
        replaying = e.replay === true;
        try {
          await processRow(e.row);
        } finally {
          replaying = false;
        }
        return;
      }
      case 'motion':
        await onMotion(e.activity, e.ts);
        return;
      case 'end':
        // A drive already past its automatic end (no row or tick came since) ends as that end would.
        if (status === 'recording' && !(await endIfDue(e.ts))) await finalize((open) => closeEnd(open, e.ts, e.cause));
        return;
      case 'cancel':
        if (status === 'recording') await cancel();
        return;
      case 'release':
        if (status === 'recording') await release();
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
    speed(fix) {
      if (status !== 'recording') return;
      const next = displayFix(shown, fix);
      if (next === shown) return;
      shown = next;
      touch();
      notify();
    },
  };
}
