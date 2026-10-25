// Phone pickups (product spec "Phone use"; phone plan P1). Motion only, on iPhone and Android alike,
// whatever app is in front and with RoadWise in front or behind alike.
//
// - **A use row:** a second of the phone being handled (`handlingScore` ≥ `PHONE_HANDLING_MIN_SCORE`)
//   whose motion sensors reported (an IMU-absent row is evidence of nothing). On iPhone a row with a
//   call (`call` set, ringing or connected) is never a use row, live and rebuilt alike: iOS cannot
//   tell hands-free from handheld. Android motion is never suppressed by a call.
// - **An episode** opens on any use row, from the drive's first row (no warm-up: a pickup needs
//   driving speed anyway).
// - **A pickup** (the episode confirmed): `PHONE_PICKUP_MIN_ROWS` use rows, and one of them at driving
//   speed (`atDrivingSpeed`: a known, trusted GPS speed of `PHONE_PICKUP_MIN_MPH` or more). A pickup
//   at a red light put down before the car reaches driving speed, and parking-lot use, never count.
// - **Before it is a pickup**, an episode is dropped silently after `CLOSE_AFTER_QUIET_ROWS` (2)
//   consecutive quiet rows (or as long without a row): its use rows must come with at most one quiet
//   row between them. A mounted phone's jolts on a rough road (a row or two of "handling" now and
//   then) never add up to a pickup.
// - **A pickup closes** (the phone put down) once `PHONE_PUTDOWN_QUIET_S` of row clock have passed
//   since its last use row ended (a row covers the second from its `ts`) with no new one. A use row
//   within those 10 s continues it: the put-down motion itself, a shift in the hand and a re-grab
//   are never a second pickup. Time, not a row count, so a gap in the rows neither keeps a pickup
//   open nor splits it.
// - It **starts** at the episode's first use row at driving speed. **In hand** (`durationS`, whole
//   seconds, at least 1): the rows from the start through the last use row (the quiet rows between
//   use rows included: the phone is still in hand) whose known speed is `MOVING_MIN_MPH` or more. A
//   red light, a stop after parking and rows with no known speed add nothing.
// - **Tier** by time in hand (`phonePickupTier`): up to `PHONE_SEVERE_S` moderate, longer severe.
// - **Measured:** `speedMph`, the trusted speed at the start row; `maxSpeedMph`, the highest trusted
//   speed from the start through the last use row (both 1 dp).
// - **Alerts** (`alerts()`): on the row a pickup confirms (its tier so far), then a repeat as its
//   time in hand reaches `PHONE_SEVERE_S` and every `PHONE_REPEAT_IN_HAND_S` after, while it stays in
//   hand. A drive rebuilt from its rows replays this state too, so nothing it already told is told
//   again.
// - A drive's end (`flush`) closes an open pickup at its last use row.
import { MOVING_MIN_MPH, PHONE_HANDLING_MIN_SCORE, PHONE_PICKUP_MIN_ROWS, PHONE_PUTDOWN_QUIET_S, PHONE_SEVERE_S, phonePickupTier } from '@scoring';

import type { DetectedEvent, Detector, DetectorContext, FeatureRow, PhoneAlert } from '../engine/types';
import { atDrivingSpeed, knownSpeed, mph, MPS_PER_MPH, phoneWatchable, round1, ROW_MS, speedTrusted } from './common';

/** After the first repeat (at `PHONE_SEVERE_S` in hand), the next one comes each time this much more is in hand. */
export const PHONE_REPEAT_IN_HAND_S = 60;

/** Quiet rows in a row that drop an episode that is not yet a pickup (the false-positive guard). */
export const CLOSE_AFTER_QUIET_ROWS = 2;

const QUIET_MS = PHONE_PUTDOWN_QUIET_S * 1000;
const MOVING_MPS = MOVING_MIN_MPH * MPS_PER_MPH;

/** A use row (see the header): handled, on a second a pickup could be seen in (the IMU read, and on iPhone no call). */
export function isUseRow(row: FeatureRow, platform: DetectorContext['platform']): boolean {
  return row.handlingScore >= PHONE_HANDLING_MIN_SCORE && phoneWatchable(row, platform);
}

interface Episode {
  /** Given as it confirms (an episode that never does takes none); '' before. */
  id: string;
  /** Use rows so far. */
  useRows: number;
  /** Row clock of the latest use row. */
  lastUseTs: number;
  /** Consecutive quiet rows since it. */
  quietRows: number;
  /** The first use row at driving speed (the pickup's start), its trusted speed (mph); null before. */
  startTs: number | null;
  startMph: number;
  /** From the start through the current row: rows with a known speed ≥ 5 mph, and the highest trusted speed. */
  movingRows: number;
  topMph: number;
  /** The same two as of the latest use row: the time in hand and `maxSpeedMph`. */
  inHand: number;
  maxMph: number;
  /** A pickup: enough use rows, one of them at driving speed. */
  confirmed: boolean;
  /** The time in hand (s) at which the next repeat alert is due. */
  nextRepeatS: number;
}

export interface PhoneUseDetector extends Detector {
  /** The alerts the latest row raised (at most one). */
  alerts(): PhoneAlert[];
}

/** The first repeat mark (15 s in hand, then every 60 s) past `inHandS`. */
function nextMarkAfter(inHandS: number): number {
  if (inHandS < PHONE_SEVERE_S) return PHONE_SEVERE_S;
  return PHONE_SEVERE_S + (Math.floor((inHandS - PHONE_SEVERE_S) / PHONE_REPEAT_IN_HAND_S) + 1) * PHONE_REPEAT_IN_HAND_S;
}

export function createPhoneUseDetector(newId: () => string): PhoneUseDetector {
  let ep: Episode | null = null;
  let told: PhoneAlert[] = [];

  /** The episode put down (or the drive over): a pickup when it was confirmed, else nothing. */
  const close = (): DetectedEvent[] => {
    const e = ep;
    ep = null;
    if (e === null || !e.confirmed || e.startTs === null) return [];
    const durationS = Math.max(1, e.inHand);
    return [
      {
        id: e.id,
        type: 'phone_pickup',
        tier: phonePickupTier(durationS),
        startedAt: e.startTs,
        durationS,
        measured: { speedMph: round1(e.startMph), maxSpeedMph: round1(e.maxMph) },
      },
    ];
  };

  return {
    push(row, _limit, ctx) {
      told = [];
      // 1. A pickup put down: 10 s of row clock since its last use row ended, whatever came in
      //    between. An episode not yet a pickup: two seconds without a use row (a gap in the rows) drop it.
      let out: DetectedEvent[] = [];
      if (ep !== null && row.ts - (ep.lastUseTs + ROW_MS) >= (ep.confirmed ? QUIET_MS : CLOSE_AFTER_QUIET_ROWS * ROW_MS)) out = close();
      const use = isUseRow(row, ctx.platform);
      if (ep === null) {
        if (!use) return out;
        ep = {
          id: '',
          useRows: 0,
          lastUseTs: row.ts,
          quietRows: 0,
          startTs: null,
          startMph: 0,
          movingRows: 0,
          topMph: 0,
          inHand: 0,
          maxMph: 0,
          confirmed: false,
          nextRepeatS: PHONE_SEVERE_S,
        };
      }
      const e = ep;
      const speed = knownSpeed(row);
      // 2. Every row after the start counts toward the time in hand once a later use row shows the
      //    phone was still in hand: moving at 5 mph or more, and its trusted speed for the top.
      if (e.startTs !== null) {
        if (speed !== null && speed >= MOVING_MPS) e.movingRows += 1;
        if (speed !== null && speedTrusted(row)) e.topMph = Math.max(e.topMph, mph(speed));
      }
      if (!use) {
        // A quiet row: two in a row drop an episode that is not yet a pickup, silently.
        e.quietRows += 1;
        if (!e.confirmed && e.quietRows >= CLOSE_AFTER_QUIET_ROWS) ep = null;
        return out;
      }
      // 3. A use row.
      e.useRows += 1;
      e.lastUseTs = row.ts;
      e.quietRows = 0;
      if (e.startTs === null && atDrivingSpeed(row)) {
        e.startTs = row.ts;
        e.startMph = mph(speed as number);
        e.movingRows = 1;
        e.topMph = e.startMph;
      }
      if (e.startTs === null) return out;
      e.inHand = e.movingRows;
      e.maxMph = e.topMph;
      // 4. The alerts: the pickup as it confirms, then the repeats by time in hand.
      const inHand = Math.max(1, e.inHand);
      if (!e.confirmed) {
        if (e.useRows < PHONE_PICKUP_MIN_ROWS) return out;
        e.confirmed = true;
        e.id = newId();
        e.nextRepeatS = nextMarkAfter(inHand);
        told = [{ id: e.id, tier: phonePickupTier(inHand), repeat: false }];
      } else if (inHand >= e.nextRepeatS) {
        e.nextRepeatS = nextMarkAfter(inHand);
        told = [{ id: e.id, tier: phonePickupTier(inHand), repeat: true }];
      }
      return out;
    },
    flush() {
      told = [];
      return close();
    },
    alerts: () => told,
  };
}
