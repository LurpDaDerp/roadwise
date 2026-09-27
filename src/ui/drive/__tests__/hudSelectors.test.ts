import { CONSTANTS } from '@scoring';

import type { LimitSample } from '@/core/engine/types';
import {
  countWords,
  HALO_CRITICAL_OVER_MPS,
  haloLevel,
  HARSH_RECENT_MS,
  hudLimitMph,
  hudSpeedMph,
  hudSpeeding,
  overLimitMps,
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
  // The gate's agreement with the alert and scoring gate is proven over the matcher's real outputs
  // (AWS 0.7, HPMS 0.75, ramp 0.65, ...) in limitGateSeam.test.ts, not by comparing constants.

  test('a confident posted match shows its limit', () => {
    expect(hudLimitMph(limit(35), true)).toBe(35);
    expect(hudLimitMph(limit(60, { matchConfidence: 0.8 }), true)).toBe(60);
  });

  test.each([0.6, 0.65, 0.69])('a ramp or parallel-road match at %s shows "—"', (c) => {
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

describe('overLimitMps — the raw margin, gated exactly like the sign and the readout', () => {
  test('signed m/s over the shown limit', () => {
    expect(overLimitMps(45 * MPH, true, limit(35))).toBeCloseTo(10 * MPH, 6);
    expect(overLimitMps(30 * MPH, true, limit(35))).toBeCloseTo(-5 * MPH, 6);
  });

  test('null without a speed or a limit the HUD would show', () => {
    expect(overLimitMps(45 * MPH, false, limit(35))).toBeNull();
    expect(overLimitMps(45 * MPH, true, limit(35, { matchConfidence: 0.65 }))).toBeNull();
    expect(overLimitMps(45 * MPH, true, UNKNOWN)).toBeNull();
    expect(overLimitMps(45 * MPH, true, null)).toBeNull();
  });
});

describe('haloLevel — the status halo, a pure function of what can unsettle a drive', () => {
  const tol = CONSTANTS.SPEEDING_TOLERANCE_MPS;
  const quiet = { overMps: null, alertLevel: null, harshAgeMs: null } as const;

  test('calm with nothing to report, including under the limit and at the tolerance', () => {
    expect(haloLevel(quiet)).toBe('calm');
    expect(haloLevel({ ...quiet, overMps: -3 })).toBe('calm');
    expect(haloLevel({ ...quiet, overMps: tol })).toBe('calm');
  });

  test('over the tolerance is attention; the tolerance plus 10 mph is critical', () => {
    expect(haloLevel({ ...quiet, overMps: tol + 0.1 })).toBe('attention');
    expect(HALO_CRITICAL_OVER_MPS).toBeCloseTo(tol + 10 * MPH, 6);
    expect(haloLevel({ ...quiet, overMps: HALO_CRITICAL_OVER_MPS - 0.01 })).toBe('attention');
    expect(haloLevel({ ...quiet, overMps: HALO_CRITICAL_OVER_MPS })).toBe('critical');
  });

  test('an L1 or L2 alert is attention, an L3 alert is critical, whatever the speed', () => {
    expect(haloLevel({ ...quiet, alertLevel: 1 })).toBe('attention');
    expect(haloLevel({ ...quiet, alertLevel: 2 })).toBe('attention');
    expect(haloLevel({ ...quiet, alertLevel: 3 })).toBe('critical');
    expect(haloLevel({ ...quiet, alertLevel: 3, overMps: -5 })).toBe('critical');
    expect(haloLevel({ ...quiet, alertLevel: 1, overMps: HALO_CRITICAL_OVER_MPS })).toBe(
      'critical'
    );
  });

  test('a harsh event in the last 10 s is attention; older, or none, is calm', () => {
    expect(haloLevel({ ...quiet, harshAgeMs: 0 })).toBe('attention');
    expect(haloLevel({ ...quiet, harshAgeMs: HARSH_RECENT_MS - 1 })).toBe('attention');
    expect(haloLevel({ ...quiet, harshAgeMs: HARSH_RECENT_MS })).toBe('calm');
    expect(haloLevel({ ...quiet, harshAgeMs: -1 })).toBe('calm');
    expect(HARSH_RECENT_MS).toBe(10_000);
  });

  test('the parts combine to the most serious judgement', () => {
    expect(haloLevel({ overMps: tol + 0.1, alertLevel: null, harshAgeMs: 0 })).toBe('attention');
    expect(haloLevel({ overMps: tol + 0.1, alertLevel: 3, harshAgeMs: 0 })).toBe('critical');
    expect(haloLevel({ overMps: HALO_CRITICAL_OVER_MPS, alertLevel: 1, harshAgeMs: 50_000 })).toBe(
      'critical'
    );
  });
});

test('countWords counts words, not spaces', () => {
  expect(countWords('  Take a break ')).toBe(3);
  expect(countWords('')).toBe(0);
});
