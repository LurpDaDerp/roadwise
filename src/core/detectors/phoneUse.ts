// Phone pickup and phone handling (product spec v3 event table, "Rules against false positives").
//
// A use row is the phone being handled (`handlingScore` ≥ 0.6) or, where the lock signal can be
// believed and is not lagged, unlocked with the screen on and RoadWise in the background. Three
// consecutive use rows make a pickup — so a tap of under 3 s on a mounted, stable phone never
// counts — when the car is moving above 5 mph, or stopped mid-drive after having moved
// (`stoppedInTraffic`, half the penalty). A pickup before the car has ever moved is parking-lot
// phone use, not a pickup. The episode continues while use rows persist and closes after two quiet
// rows; handling past 15 s adds one `phone_handling` event (moderate ≤ 30 s, severe beyond).
// A hands-free call suppresses everything (CarPlay / Android Auto are not detectable; documented).
import { PHONE_MIN_MPH, type Tier } from '@scoring';

import type { DetectedEvent, Detector, OpenEpisode } from '../engine/types';
import { knownSpeedMph, mountedStable, round1, rowEligible } from './common';

/** `handlingScore` at or above this reads as the phone being handled. */
export const HANDLING_MIN_SCORE = 0.6;
/** Consecutive use rows before a pickup counts (the "< 3 s tap" rule). */
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
  lastUseTs: number;
  run: number;
  quiet: number;
  confirmed: boolean;
  /** Parking-lot use: never a pickup; closes silently. */
  ignored: boolean;
  mounted: boolean;
  speedAtPickupMph: number | null;
  stoppedInTraffic: boolean;
}

export interface PhoneUseDetector extends Detector {
  open(): OpenEpisode | null;
  /** A confirmed episode is open: the row's distance is not safe miles. */
  active(): boolean;
}

export function createPhoneUseDetector(newId: () => string): PhoneUseDetector {
  let ep: Episode | null = null;
  /** The car has moved above 5 mph at some point of the drive. */
  let moved = false;

  const close = (): DetectedEvent[] => {
    const e = ep;
    ep = null;
    if (e === null || !e.confirmed || e.ignored) return [];
    const durationS = (e.lastUseTs - e.startedAt) / 1000 + 1;
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

  return {
    push(row, _limit, ctx) {
      const speedMph = knownSpeedMph(row);
      if (speedMph !== null && speedMph > PHONE_MIN_MPH) moved = true;
      const unlockedElsewhere = ctx.lockReliable && !ctx.lockLagged && !row.locked && row.screenOn && !row.appForeground;
      const useRow =
        rowEligible(row, ctx) && !ctx.callActive && speedMph !== null && (row.handlingScore >= HANDLING_MIN_SCORE || unlockedElsewhere);

      if (useRow) {
        if (ep === null) {
          ep = {
            id: newId(),
            startedAt: row.ts,
            lastUseTs: row.ts,
            run: 0,
            quiet: 0,
            confirmed: false,
            ignored: false,
            mounted: true,
            speedAtPickupMph: null,
            stoppedInTraffic: false,
          };
        }
        ep.run += 1;
        ep.lastUseTs = row.ts;
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
        return [];
      }

      if (ep === null) return [];
      ep.quiet += 1;
      if (ep.quiet < CLOSE_AFTER_QUIET_ROWS) return [];
      if (!ep.confirmed) {
        ep = null;
        return [];
      }
      return close();
    },
    flush: close,
    open() {
      if (ep === null || ep.ignored) return null;
      return { id: ep.id, type: 'phone_pickup', tier: 'severe', startedAt: ep.startedAt, confirmed: ep.confirmed };
    },
    active: () => ep !== null && ep.confirmed && !ep.ignored,
  };
}
