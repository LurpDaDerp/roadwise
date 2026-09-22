// Phone use (§9.3): sustained handling, RoadWise pushed to the background in mounted mode, or
// RoadWise opened at speed on a trip that is not mounted (SR8), while the car is moving.
// Confidence follows the unlock / app-switch evidence (§9.5).
//
// One episode covers every signal: it is confirmed by PHONE_HANDLING_MIN_S consecutive handling
// rows or by a single app-switch (or SR8 open) row, continues while a signal persists, and ends
// after CLOSE_AFTER_QUIET_ROWS rows without one. Stopped and moving stretches are separate episodes
// so the stopped one can be logged as `possible` (speed 0, severity 0) without diluting the other.
//
// A locked phone is never phone use (plan rev1 I11). The mounted app-switch row needs RoadWise in
// the background on an unlocked, lit screen, and how far that can be believed depends on the lock
// signal the platform gives (`DetectorContext.lockReliable` / `lockLagged`):
//   - reliable (Android): one such row is app-switch evidence, as before;
//   - lagged (iOS with a passcode, ~10 s late): the side button backgrounds the app at once but
//     reports `locked` seconds later, so the rows are held back — the episode is confirmed only on
//     the APP_SWITCH_CONFIRM_S-th consecutive backgrounded, unlocked row (and then covers them
//     all), and is dropped if a locked row turns up first;
//   - unreliable (an iPhone without a passcode never reports locked): a backgrounded app cannot be
//     told from a locked phone, so it is not evidence on its own, and a lit screen is not unlock
//     evidence — only real handling makes an episode, at handling confidence (0.6).
import { CONSTANTS } from '@scoring';
import type { DetectedEvent, Detector, DetectorContext, EventSource, FeatureRow } from '../engine/types';
import { alertableFor, contextOf, knownSpeed, statusFor } from './common';

/** The confirmed open episode, as the alert layer sees it. */
export interface OpenPhoneEpisode {
  id: string;
  /** Rows through the last signal row — what the closed event's `durationS` will be so far. */
  durationS: number;
}

export interface PhoneUseDetector extends Detector {
  /** The confirmed open episode, or null before confirmation and between episodes. */
  openEpisode(): OpenPhoneEpisode | null;
}

/** Phone-use confidence (§9.5): handling alone 0.6; with unlock or app-switch evidence 0.9. */
const Q = { handling: 0.6, evidenced: 0.9 } as const;
/** `handlingScore` at or above this reads as the phone being handled. */
const HANDLING_MIN_SCORE = 0.6;
const CLOSE_AFTER_QUIET_ROWS = 2;
/**
 * With a lagged lock signal, a mounted app switch counts only on this many consecutive
 * backgrounded, unlocked rows — longer than the platform's lock lag, so a side-button press has
 * reported `locked` (and dropped the episode) before it could be charged. Tuning-sensitive.
 */
export const APP_SWITCH_CONFIRM_S = 12;

type Phase = 'stopped' | 'moving';

interface Episode {
  id: string;
  phase: Phase;
  startedAt: number;
  /** rows since the episode opened, quiet and held-back ones included */
  rows: number;
  /** `rows` as of the last signal row: trailing quiet rows never count */
  durationRows: number;
  speedSum: number;
  speedN: number;
  /** the speed sums as of the last signal row */
  speedSumAtSignal: number;
  speedNAtSignal: number;
  quiet: number;
  confirmed: boolean;
  handling: boolean;
  unlock: boolean;
  appSwitch: boolean;
  context: DetectedEvent['context'];
}

export function createPhoneUseDetector(newId: () => string): PhoneUseDetector {
  let open: Episode | null = null;
  let handlingRun = 0;
  /** Consecutive backgrounded, unlocked rows in mounted mode (the lagged-lock confirmation). */
  let switchRun = 0;
  /** Whether the previous row showed RoadWise open on an unlocked screen; null before the first. */
  let prevInApp: boolean | null = null;

  const newEpisode = (row: FeatureRow, phase: Phase, ctx: DetectorContext): Episode => ({
    id: newId(),
    phase,
    startedAt: row.ts,
    rows: 0,
    durationRows: 0,
    speedSum: 0,
    speedN: 0,
    speedSumAtSignal: 0,
    speedNAtSignal: 0,
    quiet: 0,
    confirmed: false,
    handling: false,
    unlock: false,
    appSwitch: false,
    context: contextOf(ctx),
  });

  const close = (): DetectedEvent[] => {
    const ep = open;
    open = null;
    if (!ep || !ep.confirmed) return [];
    const evidenced = ep.unlock || ep.appSwitch;
    const q = evidenced ? Q.evidenced : Q.handling;
    const stopped = ep.phase === 'stopped';
    const status = stopped ? 'possible' : statusFor(q);
    const speedMps = stopped ? 0 : ep.speedSumAtSignal / ep.speedNAtSignal;
    const source: EventSource = ep.handling && evidenced ? 'both' : evidenced ? 'os' : 'imu';
    return [
      {
        id: ep.id,
        category: 'phone',
        startedAt: ep.startedAt,
        durationS: ep.durationRows,
        q,
        corrected: false,
        status,
        measured: { speedMps },
        context: ep.context,
        alertable: alertableFor(status, q),
        source,
      },
    ];
  };

  return {
    push(row, _limit, ctx) {
      const speed = knownSpeed(row);
      const handlingRow = speed !== null && row.handlingScore >= HANDLING_MIN_SCORE;
      handlingRun = handlingRow ? handlingRun + 1 : 0;
      const unlockedScreen = !row.locked && row.screenOn;

      // Mounted app switch: RoadWise in the background on an unlocked, lit screen (I11).
      const backgroundedUnlocked =
        speed !== null && ctx.mode === 'mounted' && !row.appForeground && unlockedScreen;
      let appSwitchRow = false;
      /** Held back: taken into the episode only if the lagged confirmation completes. */
      let pendingRow = false;
      if (!ctx.lockReliable) {
        switchRun = 0;
      } else if (!ctx.lockLagged) {
        switchRun = 0;
        appSwitchRow = backgroundedUnlocked;
      } else {
        switchRun = backgroundedUnlocked ? switchRun + 1 : 0;
        appSwitchRow = backgroundedUnlocked && switchRun >= APP_SWITCH_CONFIRM_S;
        pendingRow = backgroundedUnlocked && !appSwitchRow;
      }

      // SR8: RoadWise brought to the front at speed on a trip that is not mounted. The row that
      // opens it is the evidence — the transition, not the state, so a screen left lit afterwards
      // does not keep charging; handling while it is open extends the episode as usual.
      const inApp = row.appForeground && unlockedScreen;
      const openedRow =
        ctx.mode !== 'mounted' &&
        speed !== null &&
        speed >= CONSTANTS.LOCKOUT_SPEED_MPS &&
        inApp &&
        prevInApp === false;
      prevInApp = inApp;

      const evidenceRow = appSwitchRow || openedRow;
      // Without a lock signal to believe, a lit screen says nothing about an unlock.
      const unlockRow = ctx.lockReliable && unlockedScreen;
      const out: DetectedEvent[] = [];

      if (speed !== null && (handlingRow || evidenceRow || pendingRow)) {
        const phase: Phase = speed < CONSTANTS.LOCKOUT_SPEED_MPS ? 'stopped' : 'moving';
        if (open && open.phase !== phase) out.push(...close());
        if (!open) open = newEpisode(row, phase, ctx);
        open.rows += 1;
        open.speedSum += speed;
        open.speedN += 1;
        if (pendingRow && !handlingRow) {
          // Inside the episode's span but not yet its duration: the confirmation takes it in, a
          // locked row drops it. Meanwhile it neither closes the episode nor extends it.
          return out;
        }
        open.quiet = 0;
        open.durationRows = open.rows;
        open.speedSumAtSignal = open.speedSum;
        open.speedNAtSignal = open.speedN;
        open.handling = open.handling || handlingRow;
        open.appSwitch = open.appSwitch || evidenceRow;
        open.unlock = open.unlock || unlockRow;
        if (evidenceRow || handlingRun >= CONSTANTS.PHONE_HANDLING_MIN_S) open.confirmed = true;
      } else if (open && !open.confirmed) {
        // The handling run broke (or a held-back app switch locked) before it meant anything.
        open = null;
      } else if (open) {
        open.rows += 1;
        open.quiet += 1;
        if (speed !== null) {
          open.speedSum += speed;
          open.speedN += 1;
        }
        open.unlock = open.unlock || unlockRow;
        if (open.quiet >= CLOSE_AFTER_QUIET_ROWS) out.push(...close());
      }
      return out;
    },
    flush: close,
    openEpisode() {
      return open !== null && open.confirmed ? { id: open.id, durationS: open.durationRows } : null;
    },
  };
}
