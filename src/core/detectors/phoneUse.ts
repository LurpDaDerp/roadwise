// Phone pickups (product spec "Phone use"; phone plan P1). Read from motion, on iPhone and Android
// alike, whatever app is in front and with RoadWise in front or behind alike. A pickup is told by
// the phone's tilt, not by how hard it shakes: each row carries the second's gravity direction
// (`gx`, `gy`, `gz`), the signal Android's own tilt sensor and driving-distraction telematics read.
// Shaking, rattling in a cup holder, a rough road or a pothole move a phone a lot but leave its tilt
// where it was; a hand that picks it up to look at it tilts it far from where it rested.
//
// - **Still and moving seconds.** A second with a gravity reading is moving when its direction moved
//   more than `PHONE_STILL_STEP_DEG` (3°) from the last reading before it, and still when it moved
//   that much or less: a shake within the second that leaves the tilt where it was is still. The
//   reading before must be at most 2 s older (one missing row): after a longer gap the second is
//   neither (nothing tells how the phone moved meanwhile). A second with no reading (`gravityOf`: the
//   IMU absent) is neither and changes nothing: the next reading is judged against the last one.
// - **The resting tilt.** `PHONE_SETTLE_S` (10) still seconds in a row are the phone at rest (in a
//   mount, a cup holder, a pocket, on a seat): their mean direction becomes the resting tilt, which
//   then follows slow drift (a hill, a sagging mount) while the phone stays still. Before the phone
//   has first come to rest in a drive, nothing counts.
// - **Away.** A second the phone is away: it has a gravity reading, is tilted at least
//   `PHONE_TILT_MIN_DEG` (30°) from the resting tilt, and is held the way a phone is held to be looked
//   at (`heldToLook`: the screen tilted up 15° to 80° from lying flat, its top no more than 120° from
//   straight up), no call is ringing or connected (a phone can't tell hands-free from handheld, so a
//   call second is never phone use, on either phone), and, on Android, the screen is on (iPhone gives
//   apps no screen state, so on iPhone the tilt decides alone). An away second that is moving is a
//   **use second**; any other away second is a **held second** (the phone steady in the hand). Every
//   other second is quiet.
// - **Standing.** Held seconds stand (count as use seconds, and toward the time in hand) once the
//   phone makes a moving second (a shift in the hand, the put-down) before it has come to rest, and
//   never if it comes to rest first. Use seconds stand at once.
// - **An episode** opens on a use second. It becomes a **pickup** once it has `PHONE_PICKUP_MIN_ROWS`
//   (3) standing use seconds and the phone was away at driving speed (`atDrivingSpeed`: a known,
//   trusted GPS speed of `PHONE_PICKUP_MIN_MPH`, 10 mph, or more) on a standing second. A phone picked
//   up at a red light and put down before the car reaches driving speed, and parking-lot use, never
//   count. Until then two quiet seconds in a row (or two seconds with no row) drop it silently; held
//   seconds keep it.
// - **Come to rest.** When the phone reaches `PHONE_SETTLE_S` still seconds in a row with an episode
//   open, it was put down where those still seconds began: a pickup closes as it stands (its held
//   seconds in that still run never stand), and an episode that was not yet a pickup is dropped. So a
//   phone moved to a new spot (a mount, a charger, the seat) is no pickup unless moving it took 3 use
//   seconds, a pickup never runs on in a spot it was left in, and a phone held dead steady for 10 s
//   reads as put down.
// - **A pickup closes** (the phone put down) once `PHONE_PUTDOWN_QUIET_S` (10 s) of row clock pass
//   after its last away second with no new one. An away second within those 10 s continues it: the
//   put-down motion, a shift in the hand and a re-grab are never a second pickup.
// - It **starts** at its first away second at driving speed. **In hand** (`durationS`, whole seconds,
//   at least 1): the seconds from the start through its last standing away second (the quiet ones
//   between included) whose known speed is `MOVING_MIN_MPH` or more. A red light, a stop after parking
//   and seconds with no known speed add nothing.
// - **Tier** by time in hand (`phonePickupTier`): up to `PHONE_SEVERE_S` moderate, longer severe.
// - **Measured:** `speedMph`, the trusted speed at the start; `maxSpeedMph`, the highest trusted
//   speed from the start through the last standing away second (both 1 dp).
// - **Alerts** (`alerts()`): on the second a pickup confirms (its tier so far), then a repeat as its
//   standing time in hand reaches `PHONE_SEVERE_S` and every `PHONE_REPEAT_IN_HAND_S` after, while it
//   stays away. A drive rebuilt from its rows replays this state too, so nothing it already told is
//   told again.
// - A drive's end (`flush`) closes an open pickup as it stands.
import {
  MOVING_MIN_MPH,
  PHONE_PICKUP_MIN_ROWS,
  PHONE_PUTDOWN_QUIET_S,
  PHONE_SETTLE_S,
  PHONE_SEVERE_S,
  PHONE_STILL_STEP_DEG,
  PHONE_TILT_MIN_DEG,
  PHONE_VIEW_ROLL_MAX_DEG,
  PHONE_VIEW_TILT_DEG,
  phonePickupTier,
} from '@scoring';

import type { DetectedEvent, Detector, DetectorContext, FeatureRow, PhoneAlert } from '../engine/types';
import {
  angleDeg,
  atDrivingSpeed,
  gravityOf,
  imuAbsent,
  knownSpeed,
  mph,
  MPS_PER_MPH,
  phonePose,
  phoneWatchable,
  round1,
  ROW_MS,
  speedTrusted,
  type Direction,
} from './common';

/** After the first repeat (at `PHONE_SEVERE_S` in hand), the next one comes each time this much more is in hand. */
export const PHONE_REPEAT_IN_HAND_S = 60;

/** Quiet rows in a row that drop an episode that is not yet a pickup. */
export const CLOSE_AFTER_QUIET_ROWS = 2;

const QUIET_MS = PHONE_PUTDOWN_QUIET_S * 1000;
const MOVING_MPS = MOVING_MIN_MPH * MPS_PER_MPH;
/** How fast the resting tilt follows a phone that stays still (per second; about a `PHONE_SETTLE_S` time constant). */
const REST_FOLLOW = 1 / PHONE_SETTLE_S;
/** A reading this much older than the next (one missing row allowed) tells nothing about the step to it. */
const MAX_STEP_MS = 2 * ROW_MS;

/**
 * Held the way a phone is held to be looked at, from its gravity direction: the screen tilted up from
 * lying flat by `PHONE_VIEW_TILT_DEG` (not flat on a seat or a console, not upright in a cup holder or
 * a mount, never face down) and its top within `PHONE_VIEW_ROLL_MAX_DEG` of straight up (upright or
 * on its side, never upside down).
 */
export function heldToLook(g: Direction): boolean {
  const { tilt, roll } = phonePose(g);
  return tilt >= PHONE_VIEW_TILT_DEG.min && tilt <= PHONE_VIEW_TILT_DEG.max && roll <= PHONE_VIEW_ROLL_MAX_DEG;
}

/** What a second is to a pickup (see the header). */
export type PhoneSecond = 'use' | 'held' | 'quiet';

interface Episode {
  /** Given as it confirms (an episode that never does takes none); '' before. */
  id: string;
  /** Use seconds so far (they stand at once). */
  useRows: number;
  /** Held seconds that stand (the phone moved again before it came to rest). */
  standingHeld: number;
  /** Held seconds in the still run the phone is in now: they stand on its next moving second, never if it comes to rest. */
  pendingHeld: number;
  /** The start came from a held second that does not stand yet. */
  startPending: boolean;
  /** Row clock of the latest away (use or held) second. */
  lastAwayTs: number;
  /** Consecutive quiet rows since it. */
  quietRows: number;
  /** The first away second at driving speed (the pickup's start), its trusted speed (mph); null before. */
  startTs: number | null;
  startMph: number;
  /** From the start through the current row: rows with a known speed ≥ 5 mph, and the highest trusted speed. */
  movingRows: number;
  topMph: number;
  /** The same two as of the latest away second (standing or not)… */
  inHand: number;
  maxMph: number;
  /** …and as of the latest standing away second: the time in hand and `maxSpeedMph` the pickup closes with. */
  standInHand: number;
  standMaxMph: number;
  /** A pickup: enough standing use seconds, and away at driving speed on a standing second. */
  confirmed: boolean;
  /** The standing time in hand (s) at which the next repeat alert is due. */
  nextRepeatS: number;
}

/** The still run the phone is in: its still seconds and the sum of their directions. */
interface Run {
  still: number;
  sum: [number, number, number];
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

function unit(v: readonly [number, number, number]): Direction | null {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 && Number.isFinite(n) ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

export function createPhoneUseDetector(newId: () => string): PhoneUseDetector {
  let ep: Episode | null = null;
  let told: PhoneAlert[] = [];
  /** The last gravity reading and its row clock (rows with no reading leave them as they were). */
  let prev: Direction | null = null;
  let prevTs = 0;
  let run: Run | null = null;
  /** The resting tilt; null until the phone first comes to rest. */
  let rest: Direction | null = null;

  /**
   * The episode put down, come to rest or the drive over: a pickup when it was confirmed, closed as it
   * stands (held seconds that never stood add nothing), else nothing.
   */
  const close = (): DetectedEvent[] => {
    const e = ep;
    ep = null;
    if (e === null || !e.confirmed || e.startTs === null) return [];
    const durationS = Math.max(1, e.standInHand);
    return [
      {
        id: e.id,
        type: 'phone_pickup',
        tier: phonePickupTier(durationS),
        startedAt: e.startTs,
        durationS,
        measured: { speedMph: round1(e.startMph), maxSpeedMph: round1(e.standMaxMph) },
      },
    ];
  };

  /** The pickup as it confirms (enough standing use seconds, a standing start), then the repeats by standing time in hand. */
  const tell = (e: Episode): void => {
    if (e.startTs === null || e.startPending) return;
    const inHand = Math.max(1, e.standInHand);
    if (!e.confirmed) {
      if (e.useRows + e.standingHeld < PHONE_PICKUP_MIN_ROWS) return;
      e.confirmed = true;
      e.id = newId();
      e.nextRepeatS = nextMarkAfter(inHand);
      told = [{ id: e.id, tier: phonePickupTier(inHand), repeat: false }];
    } else if (inHand >= e.nextRepeatS) {
      e.nextRepeatS = nextMarkAfter(inHand);
      told = [{ id: e.id, tier: phonePickupTier(inHand), repeat: true }];
    }
  };

  /**
   * Feeds one row, as `kind`, to the open episode (opening one on a use second). `moved`: the row is a
   * moving second, so the held seconds before it (the phone steady in the hand, then moved again
   * before it came to rest) now stand.
   */
  const feed = (row: FeatureRow, kind: PhoneSecond, moved: boolean): void => {
    if (ep === null) {
      if (kind !== 'use') return;
      ep = {
        id: '',
        useRows: 0,
        standingHeld: 0,
        pendingHeld: 0,
        startPending: false,
        lastAwayTs: row.ts,
        quietRows: 0,
        startTs: null,
        startMph: 0,
        movingRows: 0,
        topMph: 0,
        inHand: 0,
        maxMph: 0,
        standInHand: 0,
        standMaxMph: 0,
        confirmed: false,
        nextRepeatS: PHONE_SEVERE_S,
      };
    }
    const e = ep;
    if (moved && (e.pendingHeld > 0 || e.startPending)) {
      e.standingHeld += e.pendingHeld;
      e.pendingHeld = 0;
      e.startPending = false;
      e.standInHand = e.inHand;
      e.standMaxMph = e.maxMph;
    }
    const speed = knownSpeed(row);
    // Every row after the start counts toward the time in hand once a later away second shows the
    // phone was still in hand: moving at 5 mph or more, and its trusted speed for the top.
    if (e.startTs !== null) {
      if (speed !== null && speed >= MOVING_MPS) e.movingRows += 1;
      if (speed !== null && speedTrusted(row)) e.topMph = Math.max(e.topMph, mph(speed));
    }
    if (kind === 'quiet') {
      // Two in a row drop an episode that is not yet a pickup, silently.
      e.quietRows += 1;
      if (!e.confirmed && e.quietRows >= CLOSE_AFTER_QUIET_ROWS) {
        ep = null;
        return;
      }
      // The put-down itself can make a steady hold's seconds stand.
      tell(e);
      return;
    }
    // An away second: a use second (moving, standing at once) or a held one (standing later, or never).
    if (kind === 'use') e.useRows += 1;
    else e.pendingHeld += 1;
    e.lastAwayTs = row.ts;
    e.quietRows = 0;
    if (e.startTs === null && atDrivingSpeed(row)) {
      e.startTs = row.ts;
      e.startMph = mph(speed as number);
      e.movingRows = 1;
      e.topMph = e.startMph;
      e.startPending = kind === 'held';
    }
    if (e.startTs === null) return;
    e.inHand = e.movingRows;
    e.maxMph = e.topMph;
    if (kind === 'use') {
      e.standInHand = e.inHand;
      e.standMaxMph = e.maxMph;
    }
    tell(e);
  };

  return {
    push(row, _limit, ctx) {
      told = [];
      // 1. A pickup put down: 10 s of row clock since its last away second ended, whatever came in
      //    between. An episode not yet a pickup: two seconds without an away second drop it.
      let out: DetectedEvent[] = [];
      if (ep !== null && row.ts - (ep.lastAwayTs + ROW_MS) >= (ep.confirmed ? QUIET_MS : CLOSE_AFTER_QUIET_ROWS * ROW_MS)) out = close();

      // 2. Still or moving, the still run, and the resting tilt. A row with the IMU absent has no
      //    reading and leaves all of it as it was.
      const g = imuAbsent(row) ? null : gravityOf(row);
      let moving = false;
      if (g !== null) {
        const stepKnown = prev !== null && row.ts - prevTs <= MAX_STEP_MS;
        const still = stepKnown && angleDeg(g, prev as Direction) <= PHONE_STILL_STEP_DEG;
        moving = stepKnown && !still;
        if (still && run !== null) {
          run.still += 1;
          run.sum = [run.sum[0] + g[0], run.sum[1] + g[1], run.sum[2] + g[2]];
        } else {
          // A moving second, or one after a gap: a new run, its still seconds from the next one.
          run = { still: 0, sum: [0, 0, 0] };
        }
        prev = g;
        prevTs = row.ts;
        if (run.still === PHONE_SETTLE_S) {
          // At rest: a pickup still open was put down where this still run began.
          if (ep !== null) out = [...out, ...close()];
          rest = unit(run.sum) ?? rest;
        } else if (run.still > PHONE_SETTLE_S && rest !== null) {
          rest =
            unit([
              rest[0] * (1 - REST_FOLLOW) + g[0] * REST_FOLLOW,
              rest[1] * (1 - REST_FOLLOW) + g[1] * REST_FOLLOW,
              rest[2] * (1 - REST_FOLLOW) + g[2] * REST_FOLLOW,
            ]) ?? rest;
        }
      }

      // 3. What the second is to a pickup, then the episode.
      feed(row, phoneSecond(row, g, moving, rest, ctx), moving);
      return out;
    },
    flush() {
      told = [];
      return close();
    },
    alerts: () => told,
  };
}

/**
 * What a second is to a pickup (see the header): `use` (away and moving), `held` (away, not moving)
 * or `quiet`. `g` is the row's gravity direction, `moving` whether it is a moving second, `rest` the
 * resting tilt so far.
 */
export function phoneSecond(
  row: FeatureRow,
  g: Direction | null,
  moving: boolean,
  rest: Direction | null,
  ctx: Pick<DetectorContext, 'platform'>
): PhoneSecond {
  if (g === null || rest === null || !phoneWatchable(row)) return 'quiet';
  if (ctx.platform === 'android' && !row.screenOn) return 'quiet';
  if (!heldToLook(g) || angleDeg(g, rest) < PHONE_TILT_MIN_DEG) return 'quiet';
  return moving ? 'use' : 'held';
}
