// Phone use (§9.3): sustained handling, or RoadWise pushed to the background in mounted mode,
// while the car is moving. Confidence follows the unlock / app-switch evidence (§9.5).
//
// One episode covers both signals: it is confirmed by PHONE_HANDLING_MIN_S consecutive handling
// rows or by a single app-switch row, continues while either signal persists, and ends after
// CLOSE_AFTER_QUIET_ROWS rows without one. Stopped and moving stretches are separate episodes so
// the stopped one can be logged as `possible` (speed 0, severity 0) without diluting the other.
import { CONSTANTS } from '@scoring';
import type { DetectedEvent, Detector, EventSource } from '../engine/types';
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

type Phase = 'stopped' | 'moving';

interface Episode {
  id: string;
  phase: Phase;
  startedAt: number;
  /** rows since the episode opened, quiet ones included */
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
      const appSwitchRow = speed !== null && ctx.mode === 'mounted' && !row.appForeground;
      const unlockRow = !row.locked && row.screenOn;
      const out: DetectedEvent[] = [];

      if (speed !== null && (handlingRow || appSwitchRow)) {
        const phase: Phase = speed < CONSTANTS.LOCKOUT_SPEED_MPS ? 'stopped' : 'moving';
        if (open && open.phase !== phase) out.push(...close());
        if (!open) {
          open = {
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
          };
        }
        open.rows += 1;
        open.quiet = 0;
        open.speedSum += speed;
        open.speedN += 1;
        open.durationRows = open.rows;
        open.speedSumAtSignal = open.speedSum;
        open.speedNAtSignal = open.speedN;
        open.handling = open.handling || handlingRow;
        open.appSwitch = open.appSwitch || appSwitchRow;
        open.unlock = open.unlock || unlockRow;
        if (appSwitchRow || handlingRun >= CONSTANTS.PHONE_HANDLING_MIN_S) open.confirmed = true;
      } else if (open && !open.confirmed) {
        // The handling run broke before it was long enough to mean anything.
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
