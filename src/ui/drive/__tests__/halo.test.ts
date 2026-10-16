// The halo's pure rules (drive-screen design §2, §4): severity per signal, the speeding display hold,
// bursts, the visual, the colour ramps and the geometry.
import { interpolateColor, ReduceMotion } from 'react-native-reanimated';

import { contrastRatio } from '@/ui/contrast';

import {
  burstFor,
  dashpalSeverity,
  deltaEOk,
  glowStops,
  glowWeight,
  HALO_CALM,
  haloGeometry,
  haloNumeralPt,
  haloVisual,
  nextSpeedingHold,
  numeralRamp,
  phoneSeverity,
  rampColor,
  ringRamp,
  SPEEDING_HOLD_NONE,
  speedDigits,
  speedingSeverity,
  type HaloBurst,
  type HaloInput,
  type HoldRow,
  type SpeedingHold,
} from '../halo';
import { HALO_TIMINGS } from '../haloMotion';
import { HALO_BURST, HALO_MAX_SCALE, HALO_RAMP_STOPS, HUD, type HudPalette } from '../hudTokens';

const palettes: [string, HudPalette][] = [
  ['day', HUD.day],
  ['night', HUD.night],
];
const samples = Array.from({ length: 101 }, (_, i) => i / 100);

describe('speeding severity (§4.1)', () => {
  // limit 65: T = 10, L + T = 75
  test.each([
    [0.1, 'minor', 0.3035],
    [2, 'minor', 0.37],
    [5, 'minor', 0.475],
    [5.1, 'moderate', 0.4785],
    [7, 'moderate', 0.545],
    [10, 'moderate', 0.65],
    [10.1, 'severe', 0.6535],
    [15, 'severe', 0.825],
    [20, 'severe', 1],
    [30, 'severe', 1],
  ] as const)('%s mph over L + T, %s: %s', (over, tier, s) => {
    expect(speedingSeverity(tier, 75 + over, 65)).toBeCloseTo(s, 4);
  });

  test('a 35 mph limit (T 5): 41 / 46 / 51 / 60 mph', () => {
    expect(speedingSeverity('minor', 41, 35)).toBeCloseTo(0.335, 4);
    expect(speedingSeverity('moderate', 46, 35)).toBeCloseTo(0.51, 4);
    expect(speedingSeverity('severe', 51, 35)).toBeCloseTo(0.685, 4);
    expect(speedingSeverity('severe', 60, 35)).toBe(1);
  });

  test('kept in the engine tier band on both sides of every edge; unknown speed or limit: the band low end', () => {
    expect(speedingSeverity('moderate', 75 + 4.9, 65)).toBe(0.475);
    expect(speedingSeverity('minor', 75 + 6, 65)).toBe(0.475);
    expect(speedingSeverity('minor', 74, 65)).toBe(0.3);
    expect(speedingSeverity('severe', 75 + 9, 65)).toBe(0.65);
    expect(speedingSeverity('moderate', 75 + 12, 65)).toBe(0.65);
    expect(speedingSeverity('severe', null, 65)).toBe(0.65);
    expect(speedingSeverity('moderate', 80, null)).toBe(0.475);
    expect(speedingSeverity('minor', Number.NaN, 65)).toBe(0.3);
  });
});

describe('the speeding display hold (§4.1)', () => {
  const T = 1_790_000_000_000;
  const rows = (list: Omit<HoldRow, 'recording' | 'rowTs'>[], start = T, recording = true): SpeedingHold[] => {
    let h = SPEEDING_HOLD_NONE;
    return list.map((r, i) => (h = nextSpeedingHold(h, { ...r, recording, rowTs: start + i * 1000 })));
  };

  test('74.9 / 75.1 alternating against L + T = 75 for 30 rows: one entry, held at about 0.30, never calm again', () => {
    const list = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? { tier: 'minor' as const, speedMph: 75.1, limitMph: 65 } : { tier: null, speedMph: 74.9, limitMph: 65 }));
    const out = rows(list);
    expect(out.every((h) => h.s >= 0.3 && h.s <= 0.31)).toBe(true);
    const rises = out.filter((h, i) => h.s > 0 && (i === 0 || out[i - 1]!.s === 0));
    expect(rises).toHaveLength(1);
  });

  test('a one-row tier gap at full red: 1.0 → 0.90 → 1.0', () => {
    const out = rows([
      { tier: 'severe', speedMph: 95, limitMph: 65 },
      { tier: null, speedMph: 95, limitMph: 65 },
      { tier: 'severe', speedMph: 95, limitMph: 65 },
    ]);
    expect(out.map((h) => h.s)).toEqual([1, expect.closeTo(0.9, 6), 1]);
  });

  test('ends on the 5th row under L + T − 2, never snapping on the way (decays, not below 0.30)', () => {
    const out = rows([{ tier: 'severe', speedMph: 95, limitMph: 65 }, ...Array(5).fill({ tier: null, speedMph: 60, limitMph: 65 })]);
    expect(out.map((h) => Number(h.s.toFixed(2)))).toEqual([1, 0.9, 0.8, 0.7, 0.6, 0]);
  });

  test('touched the line once, then just under it (in the 2 mph band): ends on the 10th row without a tier', () => {
    const out = rows([{ tier: 'minor', speedMph: 75.2, limitMph: 65 }, ...Array(10).fill({ tier: null, speedMph: 74, limitMph: 65 })]);
    expect(out.slice(1, 10).every((h) => h.s === 0.3)).toBe(true);
    expect(out[10]!.s).toBe(0);
  });

  test('an unknown speed or limit counts as quiet', () => {
    const out = rows([{ tier: 'minor', speedMph: 76, limitMph: 65 }, ...Array(5).fill({ tier: null, speedMph: null, limitMph: 65 })]);
    expect(out.at(-1)!.s).toBe(0);
    const out2 = rows([{ tier: 'minor', speedMph: 76, limitMph: 65 }, ...Array(5).fill({ tier: null, speedMph: 76, limitMph: null })]);
    expect(out2.at(-1)!.s).toBe(0);
  });

  test('a 4 s row gap restarts from the new row alone; a repeated row does not advance; not recording clears it', () => {
    const a = nextSpeedingHold(SPEEDING_HOLD_NONE, { recording: true, rowTs: T, tier: 'severe', speedMph: 95, limitMph: 65 });
    expect(nextSpeedingHold(a, { recording: true, rowTs: T, tier: null, speedMph: 60, limitMph: 65 })).toBe(a);
    expect(nextSpeedingHold(a, { recording: true, rowTs: T + 4000, tier: null, speedMph: 95, limitMph: 65 }).s).toBe(0);
    expect(nextSpeedingHold(a, { recording: true, rowTs: T + 3000, tier: null, speedMph: 95, limitMph: 65 }).s).toBeCloseTo(0.9, 6);
    expect(nextSpeedingHold(a, { recording: true, rowTs: T - 1000, tier: null, speedMph: 95, limitMph: 65 }).s).toBe(0);
    expect(nextSpeedingHold(a, { recording: false, rowTs: T + 1000, tier: 'severe', speedMph: 95, limitMph: 65 })).toBe(SPEEDING_HOLD_NONE);
    expect(nextSpeedingHold(a, { recording: true, rowTs: null, tier: null, speedMph: null, limitMph: null })).toBe(SPEEDING_HOLD_NONE);
  });

  test('no tier ever: calm', () => {
    expect(rows(Array(5).fill({ tier: null, speedMph: 90, limitMph: 65 })).every((h) => h.s === 0)).toBe(true);
  });
});

describe('phone and DashPal severities (§4.2, §4.3)', () => {
  const T = 1_790_000_000_000;
  test('phone: 0.65 at 2 and 3 s, 0.825 at 16.5 s, 1 from 30 s; none without an episode; a row before it 0.65', () => {
    expect(phoneSeverity(T, T + 2000)).toBeCloseTo(0.65, 6);
    expect(phoneSeverity(T, T + 3000)).toBeCloseTo(0.65, 6);
    expect(phoneSeverity(T, T + 16_500)).toBeCloseTo(0.825, 6);
    expect(phoneSeverity(T, T + 30_000)).toBeCloseTo(1, 6);
    expect(phoneSeverity(T, T + 300_000)).toBeCloseTo(1, 6);
    expect(phoneSeverity(null, T)).toBe(0);
    expect(phoneSeverity(T, T - 5000)).toBeCloseTo(0.65, 6);
    expect(phoneSeverity(T, null)).toBeCloseTo(0.65, 6);
  });

  const held = (sound: number, tier: number, level = 0, since = T) => ({ sound, tier, level, since });
  test('driver not visible is a warning: 0.50 rising 0.03 a second to 0.80, the longer it lasts', () => {
    expect([0, 5000, 10_000, 600_000].map((d) => dashpalSeverity(held(6, 2), T + d))).toEqual([0.5, expect.closeTo(0.65, 6), expect.closeTo(0.8, 6), 0.8]);
  });
  test('critical: 0.80 + 0.07 per level + 0.02 per second, up to 1', () => {
    expect([0, 1, 2, 3].map((l) => dashpalSeverity(held(3, 3, l), T))).toEqual([0.8, expect.closeTo(0.87, 6), expect.closeTo(0.94, 6), 1]);
    expect(dashpalSeverity(held(2, 3), T + 10_000)).toBeCloseTo(1, 6);
    expect(dashpalSeverity(held(2, 3), T + 5000)).toBeCloseTo(0.9, 6);
  });
  test('warning: 0.50 + 0.03 per second, up to 0.80; advisory continuous 0.30; none 0; a future since counts 0 s', () => {
    expect([0, 5000, 10_000, 60_000].map((d) => dashpalSeverity(held(1, 2), T + d))).toEqual([0.5, expect.closeTo(0.65, 6), expect.closeTo(0.8, 6), 0.8]);
    expect(dashpalSeverity(held(5, 1), T + 9000)).toBe(0.3);
    expect(dashpalSeverity(null, T)).toBe(0);
    expect(dashpalSeverity(held(1, 2, 0, T + 60_000), T)).toBe(0.5);
  });
});

describe('bursts (§4.6)', () => {
  test.each(['hard_brake', 'hard_accel', 'hard_corner', 'phone_pickup', 'phone_handling'] as const)('phone %s: red × 3, keyed by type and time', (type) => {
    expect(burstFor({ kind: 'phone', type, at: 5, until: 99 })).toEqual({ key: `phone:${type}:5`, severity: 1, pulses: 3, until: 99 });
  });
  test('a speeding alert never bursts', () => {
    expect(burstFor({ kind: 'phone', type: 'speeding', at: 5, until: 99 })).toBeNull();
  });
  test('DashPal: critical red × 3, warning orange-red × 3 (driver-not-visible too), advisory one amber pulse; never for a resend', () => {
    const d = (tier: number, sound: number, resend = false) => burstFor({ kind: 'dashpal', key: 'k', sound, tier, resend, until: 99 });
    expect(d(3, 3)).toEqual({ key: 'dashpal:k', severity: 1, pulses: 3, until: 99 });
    expect(d(2, 1)).toEqual({ key: 'dashpal:k', severity: 0.75, pulses: 3, until: 99 });
    expect(d(1, 5)).toEqual({ key: 'dashpal:k', severity: 0.45, pulses: 1, until: 99 });
    expect(d(2, 6)).toEqual({ key: 'dashpal:k', severity: 0.75, pulses: 3, until: 99 });
    expect(d(3, 3, true)).toBeNull();
  });
});

describe('the visual (§4.4, §4.5)', () => {
  const T = 1_790_000_000_000;
  const input = (over: Partial<HaloInput> = {}): HaloInput => ({
    reduceMotion: false,
    status: 'recording',
    speeding: 0,
    phoneUseSince: null,
    rowTs: T,
    held: null,
    now: T,
    burst: null,
    ...over,
  });
  const burst: HaloBurst = { key: 'phone:hard_brake:1', severity: 1, pulses: 3, until: T + 1500 };

  test('calm: no pulse, flowing', () => {
    expect(haloVisual(input())).toEqual(HALO_CALM);
    expect(HALO_CALM).toMatchObject({ mode: 'calm', pulsePeriodMs: 0, pulseDepth: 0, pulseScale: 0, flow: true });
  });

  test('a sustained warning pulses by the formulas and stops the flow; every period at least 800 ms', () => {
    for (const s of [0.3, 0.5, 0.825, 1]) {
      const v = haloVisual(input({ speeding: s }));
      expect(v).toMatchObject({ mode: 'speeding', severity: s, colorSeverity: s, flow: false });
      expect(v.pulsePeriodMs).toBeCloseTo(2200 - 1400 * s, 6);
      expect(v.pulseDepth).toBeCloseTo(0.3 + 0.4 * s, 6);
      expect(v.pulseScale).toBeCloseTo(0.015 + 0.02 * s, 6);
    }
    for (const s of samples.slice(1)) expect(haloVisual(input({ speeding: s })).pulsePeriodMs).toBeGreaterThanOrEqual(800);
  });

  test('the strongest signal wins; distraction on a tie', () => {
    const v = haloVisual(input({ speeding: 0.5, phoneUseSince: T - 2000 }));
    expect(v).toMatchObject({ mode: 'distraction', severity: 0.65 });
    expect(haloVisual(input({ speeding: 0.9, phoneUseSince: T - 2000 }))).toMatchObject({ mode: 'speeding', severity: 0.9 });
    expect(haloVisual(input({ speeding: 0.65, phoneUseSince: T - 2000 })).mode).toBe('distraction');
    expect(haloVisual(input({ held: { sound: 3, tier: 3, level: 0, since: T } }))).toMatchObject({ mode: 'distraction', severity: 0.8 });
  });

  test('driver not visible pulses like a warning, redder and faster the longer it lasts', () => {
    const nf = { sound: 6, tier: 2, level: 0, since: T };
    const first = haloVisual(input({ held: nf }));
    expect(first).toMatchObject({ mode: 'distraction', severity: 0.5, flow: false });
    expect(first.pulsePeriodMs).toBeCloseTo(2200 - 1400 * 0.5, 6);
    expect(first.pulseDepth).toBeGreaterThan(0);
    expect(first.pulseScale).toBeGreaterThan(0);
    const later = haloVisual(input({ held: nf, now: T + 10_000 }));
    expect(later.severity).toBeCloseTo(0.8, 6);
    expect(later.pulsePeriodMs).toBeLessThan(first.pulsePeriodMs);
  });

  test('a burst: its mode and colour while it lasts, then the sustained state again', () => {
    expect(haloVisual(input({ burst }))).toMatchObject({ mode: 'burst', severity: 0, colorSeverity: 1, burst, flow: false, pulsePeriodMs: 0 });
    expect(haloVisual(input({ burst, now: T + 1500 }))).toEqual(HALO_CALM);
    const sustained = haloVisual(input({ burst, phoneUseSince: T - 2000 }));
    expect(sustained).toMatchObject({ mode: 'burst', severity: 0.65, colorSeverity: 1 });
    expect(haloVisual(input({ burst, phoneUseSince: T - 2000, now: T + 2000 }))).toMatchObject({ mode: 'distraction', colorSeverity: 0.65, burst: null });
    // a weaker burst never lowers the colour
    expect(haloVisual(input({ speeding: 0.9, burst: { ...burst, severity: 0.45 } })).colorSeverity).toBe(0.9);
  });

  test('not recording: calm whatever the inputs', () => {
    for (const status of ['idle', 'finalizing'] as const) {
      expect(haloVisual(input({ status, speeding: 1, phoneUseSince: T, held: { sound: 3, tier: 3, level: 3, since: T }, burst }))).toEqual(HALO_CALM);
    }
  });

  test('Reduce Motion: no pulse, no flow, the burst as colour only; colours unchanged', () => {
    const still = haloVisual(input({ reduceMotion: true, speeding: 0.8 }));
    expect(still).toMatchObject({ severity: 0.8, colorSeverity: 0.8, pulsePeriodMs: 0, pulseDepth: 0, pulseScale: 0, flow: false, burst: null });
    expect(haloVisual(input({ reduceMotion: true, burst }))).toMatchObject({ mode: 'burst', colorSeverity: 1, burst: null, flow: false });
    expect(haloVisual(input({ reduceMotion: true }))).toMatchObject({ mode: 'calm', flow: false, pulsePeriodMs: 0 });
    expect(haloVisual(input({ reduceMotion: true, status: 'idle' })).flow).toBe(false);
  });

  test('flash safety: a burst is 2.5 pulses a second (under three), opacity never below 0.25', () => {
    expect(1000 / HALO_BURST.periodMs).toBeLessThan(3);
    expect(HALO_TIMINGS.burstHalf.duration * 2).toBe(HALO_BURST.periodMs);
    expect(1 - HALO_BURST.depth).toBeGreaterThanOrEqual(0.25);
    expect(1 - haloVisual(input({ speeding: 1 })).pulseDepth).toBeGreaterThanOrEqual(0.25);
    expect(HALO_BURST.scale).toBeLessThanOrEqual(HALO_MAX_SCALE - 1 + 1e-9);
  });
});

describe('colours (§2.2)', () => {
  test.each(palettes)('%s: the ramp ends and stops are the tokens', (_n, p) => {
    expect(rampColor(ringRamp(p), 0)).toBe(p.haloCalm.toUpperCase());
    expect(rampColor(ringRamp(p), 0.3)).toBe(p.minor.toUpperCase());
    expect(rampColor(ringRamp(p), 0.55)).toBe(p.moderate.toUpperCase());
    expect(rampColor(ringRamp(p), 1)).toBe(p.haloSevere.toUpperCase());
    expect(rampColor(numeralRamp(p), 0)).toBe(p.haloInk.toUpperCase());
    expect(rampColor(numeralRamp(p), 1)).toBe(p.severe.toUpperCase());
    expect(rampColor(ringRamp(p), -1)).toBe(p.haloCalm.toUpperCase());
    expect(rampColor(ringRamp(p), 2)).toBe(p.haloSevere.toUpperCase());
  });

  test.each(palettes)('%s: every numeral sample holds 7:1 on black, every ring sample 4.5:1', (_n, p) => {
    for (const s of samples) {
      expect(contrastRatio(rampColor(numeralRamp(p), s), p.ground)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(rampColor(ringRamp(p), s), p.ground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test.each(palettes)('%s: the first speeding cue is an unmistakable change (ΔE_OK ≥ 15 from calm)', (_n, p) => {
    expect(deltaEOk(rampColor(ringRamp(p), 0), rampColor(ringRamp(p), 0.3))).toBeGreaterThanOrEqual(15);
    expect(deltaEOk(rampColor(numeralRamp(p), 0), rampColor(numeralRamp(p), 0.3))).toBeGreaterThanOrEqual(15);
  });

  test.each(palettes)('%s: the flow (30 %% black over the ring) stays visible at every severity (ΔE_OK ≥ 10)', (_n, p) => {
    const darken = (hex: string) =>
      `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.7).toString(16).padStart(2, '0')).join('')}`;
    for (const s of samples) {
      const c = rampColor(ringRamp(p), s);
      expect(deltaEOk(c, darken(c))).toBeGreaterThanOrEqual(10);
    }
  });

  test('the same colour as Reanimated draws (its OKLab interpolation), within a unit per channel', () => {
    const p = HUD.day;
    for (const s of [0, 0.1, 0.3, 0.42, 0.55, 0.7, 0.9, 1]) {
      const theirs = interpolateColor(s, [...HALO_RAMP_STOPS], [...ringRamp(p)], 'LAB') as string;
      const [r, g, b] = theirs.match(/[\d.]+/g)!.slice(0, 3).map((x) => Math.min(255, Math.max(0, Number(x))));
      const mine = rampColor(ringRamp(p), s);
      const m = [1, 3, 5].map((i) => parseInt(mine.slice(i, i + 2), 16));
      expect(Math.abs(m[0]! - r!)).toBeLessThanOrEqual(1);
      expect(Math.abs(m[1]! - g!)).toBeLessThanOrEqual(1);
      expect(Math.abs(m[2]! - b!)).toBeLessThanOrEqual(1);
    }
  });

  test('glow weights: two layers around s cross-fade, they sum to 1', () => {
    for (const s of samples) {
      const w = [0, 1, 2, 3].map((l) => glowWeight(l, s));
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      expect(w.filter((x) => x > 0).length).toBeLessThanOrEqual(2);
      for (const x of w) expect(x).toBeGreaterThanOrEqual(0);
    }
    expect([0, 1, 2, 3].map((l) => glowWeight(l, 0))).toEqual([1, 0, 0, 0]);
    expect([0, 1, 2, 3].map((l) => glowWeight(l, 0.3))).toEqual([0, 1, 0, 0]);
    expect([0, 1, 2, 3].map((l) => glowWeight(l, 1))).toEqual([0, 0, 0, 1]);
    expect(glowWeight(1, 0.15)).toBeCloseTo(0.5, 9);
  });
});

describe('geometry (§2.1)', () => {
  test.each([
    [288, 17, 24, 106.0, 91.5, 133, 97],
    [309, 19, 26, 113.1, 96.6, 141, 103],
    [328, 20, 28, 119.7, 102.7, 150, 109],
    [343, 21, 29, 125.4, 107.9, 157, 115],
    [361, 22, 31, 131.6, 112.6, 164, 120],
    [398, 24, 34, 145.3, 124.3, 168, 133],
  ])('box %i: W %i, Go %i, r %d, rc %d, numerals %i (2 digits) / %i (3)', (B, W, Go, r, rc, n2, n3) => {
    const g = haloGeometry(B);
    expect(g.W).toBe(W);
    expect(g.Go).toBe(Go);
    expect(g.r).toBeCloseTo(r, 0);
    expect(g.rc).toBeCloseTo(rc, 0);
    expect(haloNumeralPt(g.rc, 2, 20)).toBe(n2);
    expect(haloNumeralPt(g.rc, 3, 20)).toBe(n3);
  });

  test('the glow fits its box at the largest scale; the centre stays clear; stops rise then fall to 0', () => {
    for (let B = 220; B <= 420; B += 1) {
      const g = haloGeometry(B);
      expect(g.Ro * HALO_MAX_SCALE).toBeLessThanOrEqual(B / 2 + 1e-9);
      expect(g.rc).toBeGreaterThan(0);
      expect(g.W).toBeGreaterThanOrEqual(14);
      expect(g.W).toBeLessThanOrEqual(24);
      const stops = glowStops(g);
      expect(stops).toHaveLength(12);
      for (let i = 1; i < stops.length; i += 1) expect(stops[i]!.offset).toBeGreaterThan(stops[i - 1]!.offset);
      expect(stops[0]!.opacity).toBe(0);
      expect(stops.at(-1)!.opacity).toBe(0);
      expect(stops.at(-1)!.offset).toBeCloseTo(1, 9);
      expect(Math.max(...stops.map((s) => s.opacity))).toBe(0.45);
    }
  });

  test('numerals: at least 120 pt for two digits from box 288 to 420, and "188" fits the chord', () => {
    for (let B = 288; B <= 420; B += 1) {
      const g = haloGeometry(B);
      expect(haloNumeralPt(g.rc, 2, 20)).toBeGreaterThanOrEqual(120);
      const pt3 = haloNumeralPt(g.rc, 3, 20);
      expect(((3 * 0.535 * pt3) / 2) ** 2 + (0.357 * pt3) ** 2).toBeLessThanOrEqual((0.94 * g.rc) ** 2);
    }
    // a larger unit label (Dynamic Type 2x) leaves the numerals smaller
    const g = haloGeometry(328);
    expect(haloNumeralPt(g.rc, 2, 40)).toBe(126);
    expect(haloNumeralPt(g.rc, 2, 40)).toBeLessThan(haloNumeralPt(g.rc, 2, 20));
  });

  test('digits: unknown and one digit use the two-digit size; three digits their own', () => {
    expect([null, 0, 7, 42, 99, 100, 188].map(speedDigits)).toEqual([2, 2, 2, 2, 2, 3, 3]);
  });
});

test('every halo timing runs under the OS reduce-motion setting (the halo gates motion itself)', () => {
  for (const config of Object.values(HALO_TIMINGS)) expect(config.reduceMotion).toBe(ReduceMotion.Never);
  expect(HALO_TIMINGS.colorSpring).toMatchObject({ duration: 700, dampingRatio: 1 });
  expect([HALO_TIMINGS.intoBurst.duration, HALO_TIMINGS.outOfBurst.duration, HALO_TIMINGS.reduceColor.duration, HALO_TIMINGS.target.duration, HALO_TIMINGS.layer.duration]).toEqual([120, 400, 250, 400, 400]);
});
