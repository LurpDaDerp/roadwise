// Phone pickup and phone handling (product spec v3 event table, "Rules against false positives",
// "Screen switches").
//
// One episode takes two kinds of evidence, on iPhone and Android alike:
// - **Motion:** a use row is the phone being handled (`handlingScore` ≥ 0.6), whatever app is in
//   front. A phone that stays still in its mount is never phone use. Three use rows make a pickup
//   (so a tap of under 3 s on a mounted, stable phone never counts) when the car is moving above
//   5 mph, or stopped mid-drive after having moved (`stoppedInTraffic`, half the penalty); before the
//   car has ever moved it is parking-lot use, not a pickup. On iPhone no motion counts during a call
//   (iOS cannot tell hands-free from handheld): `ctx.callActive` live, the row's `call` key in a
//   rebuild too. Android motion is never suppressed by a call.
// - **Screen switches** (`phoneSwitch.ts`): a run of away rows counts once it spans 3 s (Android) or
//   15 s with no lock report (iPhone), from its first chargeable row (a valid fix within 50 m, a known
//   speed, the car moving above 5 mph or stopped after having moved). Once counted, every away row
//   is use whatever its fix or speed, so a stop or a GPS gap neither splits nor ends it; RoadWise
//   back in front, a lock, the screen off or an excused row ends it. An iPhone run ended by a lock
//   report is cut back to the estimated press; if less than 15 s is left it was a lock reported
//   late, and nothing of it is kept. A departure that joins an open pickup counts at once on
//   Android; on iPhone it is held (neither use nor quiet) until it has lasted 15 s. Three short
//   switches (2 s or more each, each ending back in RoadWise; on iPhone each longer than the lock cut,
//   so a lock undone before its report never counts) within 2 min are one pickup with no handling. A
//   pickup with a switch in it is never `mounted`.
//
// The episode closes after two quiet rows. Its use time is from its start to its last use row:
// past 15 s it adds one `phone_handling` event (moderate ≤ 30 s, severe beyond).
import { PHONE_MIN_MPH, type Tier } from '@scoring';

import type { DetectedEvent, Detector, DetectorContext, FeatureRow, OpenEpisode } from '../engine/types';
import { inWarmup, knownSpeedMph, mountedStable, round1, ROW_MS, rowEligible } from './common';
import {
  ageS,
  BURST_RUNS,
  BURST_WINDOW_S,
  burstRunLong,
  clampLockDelay,
  createSwitchClassifier,
  isIosSignal,
  LOCK_PROOF_MAX_S,
  lockCutMs,
  SWITCH_MAX_H_ACC_M,
  SWITCH_MIN_S_IOS,
  switchMinS,
} from './phoneSwitch';

/** `handlingScore` at or above this reads as the phone being handled. */
export const HANDLING_MIN_SCORE = 0.6;
/** Use rows before a motion pickup counts (the "< 3 s tap" rule). */
export const PICKUP_MIN_ROWS = 3;
/** Quiet rows that close an episode. */
export const CLOSE_AFTER_QUIET_ROWS = 2;
/** Handling beyond this many seconds after the pickup is a `phone_handling` event, in 15-s units. */
export const HANDLING_FREE_S = 15;
export const HANDLING_UNIT_S = 15;
export const HANDLING_SEVERE_S = 30;

interface Episode {
  id: string;
  startedAt: number;
  /** The latest motion use row, and the latest counted switch row; null when none. */
  lastMotionTs: number | null;
  lastSwitchTs: number | null;
  /** Motion use rows so far (the pickup confirms at `PICKUP_MIN_ROWS`). */
  run: number;
  quiet: number;
  confirmed: boolean;
  /** Parking-lot use: never a pickup; closes silently. */
  ignored: boolean;
  mounted: boolean;
  speedAtPickupMph: number | null;
  stoppedInTraffic: boolean;
  phase: 'switching' | 'hold' | null;
  /**
   * Three short switches: one pickup of at most 15 s for them (no handling). `burstUntil`: the
   * last one's end; use after it (a switch that joined the episode) adds its own seconds.
   */
  burst: boolean;
  burstUntil: number | null;
}

/** A stretch of consecutive away rows. */
interface Run {
  startTs: number;
  lastTs: number;
  /** The run's first chargeable row and its speed: where a pickup it opens starts. */
  firstChargeTs: number | null;
  chargeSpeed: number | null;
  /** The run is phone use from here on. */
  counting: boolean;
  /** iPhone: it joined an open pickup and waits out its 15 s. */
  held: boolean;
  /** The episode's `lastSwitchTs` and `mounted` as the run began, for a cut that drops it. */
  floorTs: number | null;
  mountedAtStart: boolean | null;
}

interface BurstEntry {
  startTs: number;
  endTs: number;
  speedMph: number;
}

export interface PhoneUseDetector extends Detector {
  open(): OpenEpisode | null;
  /** A confirmed episode is open (and not only holding an iPhone departure): the row's distance is not safe miles. */
  active(): boolean;
  /** iPhone: the latest in-drive lock proof, or null. */
  lockProof(): { delayMs: number } | null;
}

const lastUse = (e: Episode): number | null =>
  e.lastMotionTs === null ? e.lastSwitchTs : e.lastSwitchTs === null ? e.lastMotionTs : Math.max(e.lastMotionTs, e.lastSwitchTs);

/**
 * The episode's use time, seconds: from its start to its last use row. A burst counts its short
 * switches as at most `HANDLING_FREE_S` (one pickup, no handling), plus any use after the last one.
 */
function usedS(e: Episode): number | null {
  const last = lastUse(e);
  if (last === null) return null;
  if (!e.burst || e.burstUntil === null) return (last - e.startedAt) / 1000 + 1;
  const burstS = Math.min((e.burstUntil - e.startedAt) / 1000 + 1, HANDLING_FREE_S);
  return burstS + Math.max(0, (last - e.burstUntil) / 1000);
}

export function createPhoneUseDetector(newId: () => string): PhoneUseDetector {
  let ep: Episode | null = null;
  /** The car has moved above 5 mph at some point of the drive. */
  let moved = false;
  const classifier = createSwitchClassifier();
  let run: Run | null = null;
  let bursts: BurstEntry[] = [];
  /** iPhone: the phone has shown a lock in time (from the signal at the start, or proven here). */
  let proven: boolean | null = null;
  /** iPhone: the delay an in-drive proof measured; replaces the context's. */
  let measuredDelayMs: number | null = null;
  let proof: { delayMs: number } | null = null;
  let prevLocked = false;
  /** This row was motion use (for `active()` during an iPhone hold). */
  let motionNow = false;

  const newEpisode = (startedAt: number, confirmed: boolean): Episode => ({
    id: newId(),
    startedAt,
    lastMotionTs: null,
    lastSwitchTs: null,
    run: 0,
    quiet: 0,
    confirmed,
    ignored: false,
    mounted: !confirmed,
    speedAtPickupMph: null,
    stoppedInTraffic: false,
    phase: null,
    burst: false,
    burstUntil: null,
  });

  const close = (): DetectedEvent[] => {
    const e = ep;
    ep = null;
    if (e === null || !e.confirmed || e.ignored) return [];
    const durationS = usedS(e);
    if (durationS === null) return [];
    const measured: DetectedEvent['measured'] = { mounted: e.mounted };
    if (e.speedAtPickupMph !== null) measured.speedMph = round1(e.speedAtPickupMph);
    const pickup: DetectedEvent = {
      id: e.id,
      type: 'phone_pickup',
      tier: 'severe',
      startedAt: e.startedAt,
      durationS,
      measured,
    };
    if (e.stoppedInTraffic) pickup.stoppedInTraffic = true;
    if (durationS <= HANDLING_FREE_S) return [pickup];
    const extra = durationS - HANDLING_FREE_S;
    const tier: Tier = durationS <= HANDLING_SEVERE_S ? 'moderate' : 'severe';
    const handling: DetectedEvent = {
      id: newId(),
      type: 'phone_handling',
      tier,
      startedAt: e.startedAt + HANDLING_FREE_S * 1000,
      durationS: extra,
      units: Math.max(1, Math.ceil(extra / HANDLING_UNIT_S)),
      measured: { mounted: e.mounted },
    };
    return [pickup, handling];
  };

  /** A confirmed, counting pickup is open (a switch may join it). */
  const openConfirmed = (): boolean => ep !== null && ep.confirmed && !ep.ignored;

  /** The run ends on `row` (the first row that is not away). */
  function endRun(r: Run, row: FeatureRow, lockRow: boolean, ctx: DetectorContext): void {
    if (ep !== null) ep.phase = null;
    if (r.counting && ep !== null && isIosSignal(ctx.switchSignal) && lockRow) {
      // iPhone: the report came about 10 s after the press: cut back to it.
      const cut = row.ts - lockCutMs(measuredDelayMs ?? ctx.lockDelayMs);
      const kept = ageS(cut, r.startTs);
      if (kept < SWITCH_MIN_S_IOS) {
        // A lock reported late, not a switch: nothing of this run is kept.
        ep.lastSwitchTs = r.floorTs;
        if (r.mountedAtStart !== null) ep.mounted = r.mountedAtStart;
      } else if (ep.lastSwitchTs !== null) {
        ep.lastSwitchTs = Math.max(r.floorTs ?? Number.NEGATIVE_INFINITY, Math.min(ep.lastSwitchTs, cut));
      }
      const last = lastUse(ep);
      if (last === null || last < ep.startedAt) ep = null; // no use left: dropped, no event
      return;
    }
    const short =
      !r.counting &&
      !r.held &&
      row.appForeground &&
      burstRunLong(ctx.switchSignal, r.startTs, r.lastTs, measuredDelayMs ?? ctx.lockDelayMs) &&
      r.firstChargeTs !== null &&
      r.chargeSpeed !== null &&
      evidenceOn(ctx) &&
      !openConfirmed();
    if (!short) return;
    bursts.push({ startTs: r.firstChargeTs as number, endTs: r.lastTs, speedMph: r.chargeSpeed as number });
    bursts = bursts.filter((b) => b.startTs >= r.lastTs - BURST_WINDOW_S * 1000);
    if (bursts.length < BURST_RUNS) return;
    const first = bursts[0] as BurstEntry;
    const lastEntry = bursts[bursts.length - 1] as BurstEntry;
    bursts = [];
    if (ep === null || ep.ignored) {
      ep = newEpisode(first.startTs, true);
    } else {
      // an unconfirmed motion episode becomes the burst
      ep.confirmed = true;
      ep.startedAt = Math.min(ep.startedAt, first.startTs);
    }
    ep.burst = true;
    ep.burstUntil = lastEntry.endTs;
    ep.lastSwitchTs = lastEntry.endTs;
    ep.speedAtPickupMph = lastEntry.speedMph;
    ep.stoppedInTraffic = lastEntry.speedMph <= PHONE_MIN_MPH;
    ep.mounted = false;
  }

  /** Switch evidence counts on this drive: Android, or an iPhone that has shown a lock in time. */
  function evidenceOn(ctx: DetectorContext): boolean {
    return ctx.switchSignal === 'reliable' || (isIosSignal(ctx.switchSignal) && proven === true);
  }

  return {
    push(row, _limit, ctx) {
      motionNow = false;
      // 1. the car has moved
      const speedMph = knownSpeedMph(row);
      if (speedMph !== null && speedMph > PHONE_MIN_MPH) moved = true;
      if (proven === null) proven = ctx.switchSignal === 'lagged';

      // 2. classify the row for switches; an iPhone lock report within 15 s of leaving proves the phone
      const c = classifier.read(row, ctx);
      const left = classifier.leftTs();
      if (isIosSignal(ctx.switchSignal) && c.lockRow && !prevLocked && left !== null && row.ts - left <= LOCK_PROOF_MAX_S * 1000) {
        const delayMs = Math.max(0, row.ts - left - ROW_MS);
        proven = true;
        measuredDelayMs = clampLockDelay(delayMs);
        proof = { delayMs };
      }
      prevLocked = row.locked;

      // 3. motion use (iPhone: never during a call, live or rebuilt)
      const motionCall = ctx.callActive || (ctx.platform === 'ios' && row.call !== undefined);
      const motionUse = rowEligible(row, ctx) && !motionCall && speedMph !== null && row.handlingScore >= HANDLING_MIN_SCORE;
      if (motionUse) {
        motionNow = true;
        if (ep === null) {
          ep = newEpisode(row.ts, false);
        }
        ep.run += 1;
        ep.lastMotionTs = row.ts;
        ep.quiet = 0;
        ep.mounted = ep.mounted && mountedStable(row);
        if (!ep.confirmed && !ep.ignored && ep.run >= PICKUP_MIN_ROWS) {
          const movingNow = speedMph > PHONE_MIN_MPH;
          if (movingNow || moved) {
            ep.confirmed = true;
            ep.speedAtPickupMph = speedMph;
            ep.stoppedInTraffic = !movingNow;
          } else {
            ep.ignored = true;
          }
        }
      }

      // 4. run bookkeeping
      // A row a switch may be charged from: past the warm-up, a valid fix within 50 m, a known speed,
      // and the car moving above 5 mph or stopped after having moved.
      const chargeable =
        !inWarmup(row, ctx) && row.gnssValid && row.hAcc <= SWITCH_MAX_H_ACC_M && speedMph !== null && (speedMph > PHONE_MIN_MPH || moved);
      let countingRow = false;
      let heldRow = false;
      if (c.away) {
        if (run === null) {
          run = {
            startTs: row.ts,
            lastTs: row.ts,
            firstChargeTs: null,
            chargeSpeed: null,
            counting: false,
            held: false,
            floorTs: ep?.lastSwitchTs ?? null,
            mountedAtStart: ep === null ? null : ep.mounted,
          };
        } else {
          run.lastTs = row.ts;
        }
        if (chargeable && run.firstChargeTs === null) {
          run.firstChargeTs = row.ts;
          run.chargeSpeed = speedMph;
        }
        // 5. start counting
        if (!run.counting && evidenceOn(ctx)) {
          const age = ageS(row.ts, run.startTs);
          if (openConfirmed()) {
            if (ctx.switchSignal === 'reliable' || age >= SWITCH_MIN_S_IOS) {
              run.counting = true;
              run.held = false;
            } else {
              run.held = true;
            }
          } else if (age >= switchMinS(ctx.switchSignal) && chargeable && run.firstChargeTs !== null) {
            if (ep !== null && ep.ignored) ep = null; // parking-lot use: dropped silently
            if (ep === null) {
              ep = newEpisode(run.firstChargeTs, true);
            } else {
              ep.confirmed = true;
              ep.startedAt = Math.min(ep.startedAt, run.firstChargeTs);
            }
            ep.speedAtPickupMph = speedMph;
            ep.stoppedInTraffic = (speedMph as number) <= PHONE_MIN_MPH;
            run.counting = true;
            run.held = false;
          }
          if (run.counting) bursts = [];
        }
        // 6. a counting away row is use, whatever its fix or speed
        if (run.counting && ep !== null) {
          countingRow = true;
          ep.lastSwitchTs = row.ts;
          ep.phase = 'switching';
          ep.mounted = false;
          ep.quiet = 0;
        } else if (run.held && ep !== null) {
          heldRow = true;
          ep.phase = 'hold';
        }
      } else if (run !== null) {
        // 7. the run ends on this row
        const ended = run;
        run = null;
        endRun(ended, row, c.lockRow, ctx);
      }

      // 8. quiet and close
      if (ep === null || motionUse || countingRow || heldRow) return [];
      ep.quiet += 1;
      if (ep.quiet < CLOSE_AFTER_QUIET_ROWS) return [];
      if (!ep.confirmed) {
        ep = null;
        return [];
      }
      return close();
    },
    flush() {
      run = null;
      bursts = [];
      return close();
    },
    open() {
      if (ep === null || ep.ignored) return null;
      const out: OpenEpisode = { id: ep.id, type: 'phone_pickup', tier: 'severe', startedAt: ep.startedAt, confirmed: ep.confirmed, phase: ep.phase };
      // The use so far as the alerts read it (`lastUseAt − startedAt`): a burst's clamp included.
      const used = usedS(ep);
      if (used !== null) out.lastUseAt = ep.startedAt + (used - 1) * 1000;
      return out;
    },
    active: () => ep !== null && ep.confirmed && !ep.ignored && !(ep.phase === 'hold' && !motionNow),
    lockProof: () => proof,
  };
}
