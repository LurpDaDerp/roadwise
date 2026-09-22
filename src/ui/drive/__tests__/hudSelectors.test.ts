import { CONSTANTS } from '@scoring';

import type { AlertDecision, AlertKind, AlertLevel } from '@/core/alerts/types';
import type { LimitSample } from '@/core/engine/types';
import {
  HUD_LIMIT_CONFIDENCE_MIN,
  countWords,
  hudLimitMph,
  hudSpeedMph,
  hudSpeeding,
  overlayWords,
} from '@/ui/drive/hudSelectors';

const MPH = CONSTANTS.MPH;
const limit = (mph: number, extra: Partial<LimitSample> = {}): LimitSample => ({
  limitMps: mph * MPH,
  source: 'posted',
  matchConfidence: 0.95,
  parallelRoads: false,
  ...extra,
});
const UNKNOWN: LimitSample = {
  limitMps: null,
  source: 'unknown',
  matchConfidence: 0,
  parallelRoads: false,
};

describe('hudSpeedMph — unknown is "—", never 0 and never stale', () => {
  test('a known speed is rounded to whole mph', () => {
    expect(hudSpeedMph(60 * MPH, true)).toBe(60);
    expect(hudSpeedMph(59.6 * MPH, true)).toBe(60);
  });

  test('standing still with a good fix is a real 0', () => {
    expect(hudSpeedMph(0, true)).toBe(0);
  });

  test('a tunnel: speedKnown false hides whatever speed number the snapshot still carries', () => {
    expect(hudSpeedMph(0, false)).toBeNull();
    expect(hudSpeedMph(26.8, false)).toBeNull();
  });

  test('a sentinel or a non-finite speed is unknown even if flagged known', () => {
    expect(hudSpeedMph(-1, true)).toBeNull();
    expect(hudSpeedMph(Number.NaN, true)).toBeNull();
    expect(hudSpeedMph(Number.POSITIVE_INFINITY, true)).toBeNull();
  });
});

describe('hudLimitMph — the one limit gate (controller ruling, §13.2)', () => {
  test('the threshold is the alert and scoring threshold', () => {
    expect(HUD_LIMIT_CONFIDENCE_MIN).toBe(CONSTANTS.Q_FULL_AT);
    expect(HUD_LIMIT_CONFIDENCE_MIN).toBe(0.8);
  });

  test('a confident posted match shows its limit', () => {
    expect(hudLimitMph(limit(35), true)).toBe(35);
    expect(hudLimitMph(limit(60, { matchConfidence: 0.8 }), true)).toBe(60);
  });

  test('a cached limit at full confidence shows', () => {
    expect(hudLimitMph(limit(45, { source: 'cached', matchConfidence: 0.9 }), true)).toBe(45);
  });

  test.each([0.6, 0.65, 0.79])('a ramp or parallel-road match at %s shows "—"', (c) => {
    expect(hudLimitMph(limit(35, { matchConfidence: c }), true)).toBeNull();
  });

  test('a parallel-road flag hides the limit even at a high match score', () => {
    expect(hudLimitMph(limit(35, { parallelRoads: true }), true)).toBeNull();
  });

  test('a statutory guess is never shown (its source confidence is below the gate)', () => {
    expect(hudLimitMph(limit(25, { source: 'statutory' }), true)).toBeNull();
  });

  test('unknown, null and absent limits show "—"', () => {
    expect(hudLimitMph(UNKNOWN, true)).toBeNull();
    expect(hudLimitMph(null, true)).toBeNull();
    expect(hudLimitMph(limit(35, { limitMps: null }), true)).toBeNull();
    expect(hudLimitMph(limit(35, { limitMps: Number.NaN }), true)).toBeNull();
    expect(hudLimitMph(limit(0), true)).toBeNull();
  });

  test('without a current fix there is no current road, so a confident limit is stale', () => {
    expect(hudLimitMph(limit(60), false)).toBeNull();
  });
});

describe('hudSpeeding — only on a speed and a limit the HUD would itself display', () => {
  const tol = CONSTANTS.SPEEDING_TOLERANCE_MPS;

  test('beyond the tolerance is speeding; at or within it is not', () => {
    expect(hudSpeeding(35 * MPH + tol + 0.1, true, limit(35))).toBe(true);
    expect(hudSpeeding(35 * MPH + tol, true, limit(35))).toBe(false);
    expect(hudSpeeding(38 * MPH, true, limit(35))).toBe(false);
  });

  test('never on an unknown speed, however fast the stale number', () => {
    expect(hudSpeeding(80 * MPH, false, limit(35))).toBe(false);
  });

  test('never on a limit the sign would not show', () => {
    expect(hudSpeeding(60 * MPH, true, limit(35, { matchConfidence: 0.65 }))).toBe(false);
    expect(hudSpeeding(60 * MPH, true, UNKNOWN)).toBe(false);
    expect(hudSpeeding(60 * MPH, true, null)).toBe(false);
  });
});

describe('overlayWords — at most three words on the HUD (SR3)', () => {
  const decision = (kind: AlertKind, level: AlertLevel, voice?: AlertDecision['voice']) =>
    ({
      id: 'a',
      kind,
      level,
      ts: 0,
      ...(voice ? { voice } : null),
    }) as AlertDecision;

  test("uses the decision's own phrase", () => {
    expect(overlayWords(decision('phone', 2, 'alert.phoneDown'))).toBe('Phone down');
    expect(overlayWords(decision('speeding', 3, 'alert.slowDown'))).toBe('Slow down');
  });

  test('the four-word break suggestion falls back to a three-word label', () => {
    const words = overlayWords(decision('break', 2, 'alert.takeABreak'));
    expect(countWords(words)).toBeLessThanOrEqual(3);
    expect(words).toBe('Take a break');
  });

  const kinds: AlertKind[] = ['speeding', 'phone', 'eyes_off', 'drowsy', 'break'];
  const levels: AlertLevel[] = [1, 2, 3];
  const voices: (AlertDecision['voice'] | undefined)[] = [
    undefined,
    'alert.easeOff',
    'alert.slowDown',
    'alert.phoneDown',
    'alert.eyesUp',
    'alert.drowsy',
    'alert.takeABreak',
    'alert.recording',
  ];
  test('every kind, level and phrase combination stays within three words', () => {
    for (const k of kinds)
      for (const l of levels)
        for (const v of voices) {
          const words = overlayWords(decision(k, l, v));
          expect(words.length).toBeGreaterThan(0);
          expect(countWords(words)).toBeLessThanOrEqual(3);
        }
  });

  test('the drive-start phrase is not an alert and never labels one', () => {
    expect(overlayWords(decision('phone', 2, 'alert.recording'))).toBe('Phone down');
  });
});
