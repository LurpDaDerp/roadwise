// Focus & alertness (§9.3): the camera pipeline closes its own episodes and hands one over on the
// row it ended; this turns it into an event with the camera's confidence (§9.5).
import { CONSTANTS } from '@scoring';
import type { DetectedEvent, Detector } from '../engine/types';
import { alertableFor, contextOf, knownSpeed, statusFor } from './common';

export function createFocusDetector(newId: () => string): Detector {
  return {
    push(row, _limit, ctx) {
      const cam = ctx.cameraFocus;
      if (!cam) return [];
      const speed = knownSpeed(row);
      if (cam.kind === 'glance') {
        const fastEnough = speed !== null && speed >= CONSTANTS.EYES_OFF_MIN_SPEED_MPS;
        if (cam.glanceS < CONSTANTS.EYES_OFF_S || !fastEnough) return [];
      }
      const q = Math.min(1, Math.max(0, cam.q));
      const status = statusFor(q);
      const measured: DetectedEvent['measured'] = { glanceS: cam.glanceS, focusKind: cam.kind };
      if (speed !== null) measured.speedMps = speed;
      return [
        {
          id: newId(),
          category: 'focus',
          // The sample arrives when the glance ends, so it started `glanceS` earlier.
          startedAt: row.ts - Math.round(cam.glanceS * 1000),
          durationS: cam.glanceS,
          q,
          corrected: cam.correctedWithinGrace === true,
          status,
          measured,
          context: contextOf(ctx),
          alertable: alertableFor(status, q),
          source: 'camera',
        },
      ];
    },
    flush() {
      return [];
    },
  };
}
