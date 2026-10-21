// The halo's pure rules (drive-screen design §2, §4): severity per signal, the speeding tint, bursts,
// the shake, the visual, the colour ramps, the geometry and the compass.
import { interpolateColor, ReduceMotion } from 'react-native-reanimated';

import { contrastRatio } from '@/ui/contrast';

import {
  burstFor,
  COMPASS_LETTERS,
  compassGeometry,
  dashpalSeverity,
  deltaEOk,
  glowStops,
  glowWeight,
  HALO_CALM,
  HALO_TINT_FULL_RATIO,
  haloGeometry,
  haloNumeralPt,
  haloVisual,
  nextCompassAngle,
  numeralRamp,
  phoneSeverity,
  rampColor,
  ringRamp,
  shakeAmplitudePt,
  shakeOffsets,
  speedDigits,
  speedingTint,
  type HaloBurst,
  type HaloInput,
} from '../halo';
import { HALO_TIMINGS } from '../haloMotion';
import { HALO_BURST, HALO_MAX_SCALE, HALO_RAMP_STOPS, HUD, type HudPalette } from '../hudTokens';

const palettes: [string, HudPalette][] = [
  ['day', HUD.day],
  ['night', HUD.night],
];
const samples = Array.from({ length: 101 }, (_, i) => i / 100);

describe('the speeding tint, from the posted limit', () => {
  test('0 at or under the limit, rising straight to full red at 1.7 × it; just over is all but calm', () => {
    expect(HALO_TINT_FULL_RATIO).toBe(1.7);
    expect(speedingTint(0.8)).toBe(0);
    expect(speedingTint(1)).toBe(0);
    expect(speedingTint(1.035)).toBeCloseTo(0.05, 9);
    expect(speedingTint(1.21)).toBeCloseTo(0.3, 9);
    expect(speedingTint(1.385)).toBeCloseTo(0.55, 9);
    expect(speedingTint(1.7)).toBe(1);
    expect(speedingTint(2.5)).toBe(1);
  });

  test('no ratio (no usable limit or speed) is no tint', () => {
    expect(speedingTint(null)).toBe(0);
    expect(speedingTint(Number.NaN)).toBe(0);
    expect(speedingTint(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test.each([
    [25, 3],
    [35, 4],
    [45, 5],
    [65, 9],
  ])('on a %i (T %i): 1 mph over is all but calm (ΔE_OK under 5); the points line is under a fifth of the way to red', (limit, t) => {
    const near = speedingTint((limit + 1) / limit);
    expect(deltaEOk(rampColor(ringRamp(HUD.day), near), HUD.day.haloCalm)).toBeLessThan(5);
    const line = speedingTint((limit + t) / limit);
    expect(line).toBeGreaterThan(0);
    expect(line).toBeLessThan(0.2);
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
  test('warning: 0.50 + 0.03 per second, up to 0.80; advisory continuous 0.30 + 0.01 per second, up to 0.45 (below a warning); none 0; a future since counts 0 s', () => {
    expect([0, 5000, 10_000, 60_000].map((d) => dashpalSeverity(held(1, 2), T + d))).toEqual([0.5, expect.closeTo(0.65, 6), expect.closeTo(0.8, 6), 0.8]);
    expect([0, 9000, 15_000, 600_000].map((d) => dashpalSeverity(held(5, 1), T + d))).toEqual([0.3, expect.closeTo(0.39, 6), expect.closeTo(0.45, 6), 0.45]);
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
  test('DashPal: every start or step red × 3, whatever its tier (driver-not-visible and a phone-in-hand advisory too); never for a resend', () => {
    const d = (tier: number, sound: number, resend = false) => burstFor({ kind: 'dashpal', key: 'k', sound, tier, resend, until: 99 });
    const red = { key: 'dashpal:k', severity: 1, pulses: 3, until: 99 };
    expect(d(3, 3)).toEqual(red);
    expect(d(2, 1)).toEqual(red);
    expect(d(1, 4)).toEqual(red);
    expect(d(1, 5)).toEqual(red);
    expect(d(2, 6)).toEqual(red);
    expect(d(3, 3, true)).toBeNull();
    expect(d(1, 4, true)).toBeNull();
  });
});

describe('the visual (§4.4, §4.5)', () => {
  const T = 1_790_000_000_000;
  const input = (over: Partial<HaloInput> = {}): HaloInput => ({
    reduceMotion: false,
    status: 'recording',
    speeding: 0,
    speedingOver: false,
    deduction: null,
    phoneUseSince: null,
    rowTs: T,
    held: null,
    now: T,
    burst: null,
    ...over,
  });
  const burst: HaloBurst = { key: 'phone:hard_brake:1', severity: 1, pulses: 3, until: T + 1500 };

  test('calm: no pulse, flowing, no warning, no shake', () => {
    expect(haloVisual(input())).toEqual(HALO_CALM);
    expect(HALO_CALM).toMatchObject({ mode: 'calm', pulsePeriodMs: 0, pulseDepth: 0, pulseScale: 0, flow: true, warning: false, shake: null });
  });

  test('over the points line: pulsing by the formulas, the flow stopped, a warning; every period at least 800 ms', () => {
    for (const s of [0.17, 0.3, 0.5, 0.825, 1]) {
      const v = haloVisual(input({ speeding: s, speedingOver: true }));
      expect(v).toMatchObject({ mode: 'speeding', severity: s, colorSeverity: s, flow: false, warning: true });
      expect(v.pulsePeriodMs).toBeCloseTo(2200 - 1400 * s, 6);
      expect(v.pulseDepth).toBeCloseTo(0.3 + 0.4 * s, 6);
      expect(v.pulseScale).toBeCloseTo(0.015 + 0.02 * s, 6);
    }
    for (const s of samples) expect(haloVisual(input({ speeding: s, speedingOver: true })).pulsePeriodMs).toBeGreaterThanOrEqual(800);
  });

  test('tinted but under the points line: the colour only; no pulse, still flowing, not a warning', () => {
    for (const s of [0.05, 0.15, 0.6]) {
      const v = haloVisual(input({ speeding: s }));
      expect(v).toMatchObject({ mode: 'speeding', severity: s, colorSeverity: s, pulsePeriodMs: 0, pulseDepth: 0, pulseScale: 0, flow: true, warning: false });
    }
  });

  test('the pulse stops on the first row back under the line; the tint follows the row', () => {
    const over = haloVisual(input({ speeding: 0.4, speedingOver: true }));
    const under = haloVisual(input({ speeding: 0.1 }));
    expect(over.pulsePeriodMs).toBeGreaterThan(0);
    expect(under).toMatchObject({ pulsePeriodMs: 0, colorSeverity: 0.1, flow: true });
  });

  test('a non-finite tint reads as none', () => {
    expect(haloVisual(input({ speeding: Number.NaN }))).toEqual(HALO_CALM);
  });

  test('the strongest signal wins; distraction on a tie; distraction pulses whatever the tint', () => {
    const v = haloVisual(input({ speeding: 0.5, phoneUseSince: T - 2000 }));
    expect(v).toMatchObject({ mode: 'distraction', severity: 0.65, warning: true, flow: false });
    expect(v.pulsePeriodMs).toBeCloseTo(2200 - 1400 * 0.65, 6);
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

  test('a burst: its mode and colour while it lasts (a warning), then the sustained state again', () => {
    expect(haloVisual(input({ burst }))).toMatchObject({ mode: 'burst', severity: 0, colorSeverity: 1, burst, flow: false, pulsePeriodMs: 0, warning: true });
    expect(haloVisual(input({ burst, now: T + 1500 }))).toEqual(HALO_CALM);
    const sustained = haloVisual(input({ burst, phoneUseSince: T - 2000 }));
    expect(sustained).toMatchObject({ mode: 'burst', severity: 0.65, colorSeverity: 1 });
    expect(haloVisual(input({ burst, phoneUseSince: T - 2000, now: T + 2000 }))).toMatchObject({ mode: 'distraction', colorSeverity: 0.65, burst: null });
    // a weaker burst never lowers the colour
    expect(haloVisual(input({ speeding: 0.9, burst: { ...burst, severity: 0.45 } })).colorSeverity).toBe(0.9);
  });

  test('points coming off: the shake carries their key and points, whatever else shows; none under Reduce Motion', () => {
    const deduction = { key: 'hard_brake:1@5', points: 20 };
    expect(haloVisual(input({ deduction })).shake).toEqual(deduction);
    expect(haloVisual(input({ deduction, speeding: 0.5, speedingOver: true })).shake).toEqual(deduction);
    // a shake alone is not a warning: the colour and the flow stay as they are
    expect(haloVisual(input({ deduction }))).toMatchObject({ mode: 'calm', flow: true, warning: false });
    expect(haloVisual(input({ deduction, reduceMotion: true })).shake).toBeNull();
    expect(haloVisual(input({ deduction, status: 'finalizing' })).shake).toBeNull();
  });

  test('not recording: calm whatever the inputs', () => {
    for (const status of ['idle', 'finalizing'] as const) {
      expect(
        haloVisual(input({ status, speeding: 1, speedingOver: true, phoneUseSince: T, held: { sound: 3, tier: 3, level: 3, since: T }, burst }))
      ).toEqual(HALO_CALM);
    }
  });

  test('Reduce Motion: no pulse, no flow, the burst as colour only; colours unchanged', () => {
    const still = haloVisual(input({ reduceMotion: true, speeding: 0.8, speedingOver: true }));
    expect(still).toMatchObject({ severity: 0.8, colorSeverity: 0.8, pulsePeriodMs: 0, pulseDepth: 0, pulseScale: 0, flow: false, burst: null, warning: true });
    expect(haloVisual(input({ reduceMotion: true, burst }))).toMatchObject({ mode: 'burst', colorSeverity: 1, burst: null, flow: false });
    expect(haloVisual(input({ reduceMotion: true }))).toMatchObject({ mode: 'calm', flow: false, pulsePeriodMs: 0 });
    expect(haloVisual(input({ reduceMotion: true, status: 'idle' })).flow).toBe(false);
  });

  test('flash safety: a burst is 2.5 pulses a second (under three), opacity never below 0.25', () => {
    expect(1000 / HALO_BURST.periodMs).toBeLessThan(3);
    expect(HALO_TIMINGS.burstHalf.duration * 2).toBe(HALO_BURST.periodMs);
    expect(1 - HALO_BURST.depth).toBeGreaterThanOrEqual(0.25);
    expect(1 - haloVisual(input({ speeding: 1, speedingOver: true })).pulseDepth).toBeGreaterThanOrEqual(0.25);
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

  test.each(palettes)('%s: the yellow stop is an unmistakable change (ΔE_OK ≥ 15 from calm)', (_n, p) => {
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

describe('the shake', () => {
  test('grows with the points: 4.5 pt for 8, 6.5 for 20, 10.6 for 80 in a large box', () => {
    expect(shakeAmplitudePt(8, 420)).toBeCloseTo(4.5, 6);
    expect(shakeAmplitudePt(20, 420)).toBeCloseTo(2 + 2.5 * Math.log2(3.5), 6);
    expect(shakeAmplitudePt(80, 420)).toBeCloseTo(2 + 2.5 * Math.log2(11), 6);
    const pts = [1, 8, 12, 20, 32, 40, 80];
    for (let k = 1; k < pts.length; k += 1) expect(shakeAmplitudePt(pts[k]!, 420)).toBeGreaterThanOrEqual(shakeAmplitudePt(pts[k - 1]!, 420));
    // a nonsense count shakes as one point would
    expect(shakeAmplitudePt(Number.NaN, 420)).toBe(shakeAmplitudePt(1, 420));
  });

  test('never past what keeps the ring inside the compass at its largest pulse, in every box', () => {
    for (let B = 220; B <= 420; B += 1) {
      const g = haloGeometry(B);
      const c = compassGeometry(B);
      for (const points of [8, 80, 300, 10_000]) {
        const a = shakeAmplitudePt(points, B);
        expect(a).toBeLessThanOrEqual(c.shakeMax);
        expect((g.r + g.W / 2) * HALO_MAX_SCALE + a).toBeLessThan(c.inner);
      }
      expect(c.shakeMax).toBeGreaterThanOrEqual(2.5);
    }
  });

  test('swings side to side, fading out, back to rest; two more swings from 40 points', () => {
    expect(shakeOffsets(8, 20)).toEqual([8, -6, 4, -2, 0]);
    const big = shakeOffsets(12, 40);
    expect(big).toHaveLength(7);
    expect(big.at(-1)).toBe(0);
    for (let k = 1; k < big.length - 1; k += 1) {
      expect(Math.sign(big[k]!)).toBe(-Math.sign(big[k - 1]!));
      expect(Math.abs(big[k]!)).toBeLessThan(Math.abs(big[k - 1]!));
    }
  });
});

describe('the compass', () => {
  test('turns the short way round: 350° to 10° is 20° on, never 340° back; an unwrapped angle keeps counting', () => {
    expect(nextCompassAngle(-350, -10)).toBe(-370);
    expect(nextCompassAngle(0, -90)).toBe(-90);
    expect(nextCompassAngle(0, -270)).toBe(90);
    expect(nextCompassAngle(720, 5)).toBe(725);
    expect(nextCompassAngle(10, 190)).toBe(-170);
    for (let prev = -720; prev <= 720; prev += 37) {
      for (let target = -360; target <= 360; target += 23) {
        const next = nextCompassAngle(prev, target);
        expect(Math.abs(next - prev)).toBeLessThanOrEqual(180);
        expect((((next - target) % 360) + 360) % 360).toBeCloseTo(0, 9);
      }
    }
  });

  test('N, E, S and W at their bearings', () => {
    expect(COMPASS_LETTERS.map((l) => [l.label, l.bearing])).toEqual([
      ['N', 0],
      ['E', 90],
      ['S', 180],
      ['W', 270],
    ]);
  });

  test('in every ring box: inside the box, outside the ring at its largest pulse, letters 10 to 14 pt, ticks 4 to 7', () => {
    for (let B = 220; B <= 420; B += 1) {
      const c = compassGeometry(B);
      const g = haloGeometry(B);
      expect(c.outer).toBeLessThanOrEqual(B / 2);
      expect(c.inner).toBeGreaterThan((g.r + g.W / 2) * HALO_MAX_SCALE);
      expect(c.letterPt).toBeGreaterThanOrEqual(10);
      expect(c.letterPt).toBeLessThanOrEqual(14);
      expect(c.tick).toBeGreaterThanOrEqual(4);
      expect(c.tick).toBeLessThanOrEqual(7);
      expect(c.minorTick).toBeLessThan(c.tick);
      // the letters sit inside the ticks; the fixed mark reaches past the ticks, never into a letter
      expect(c.letterR).toBeLessThan(c.outer - c.tick);
      expect(c.outer - c.markH).toBeGreaterThan(c.letterR + 0.42 * c.letterPt);
    }
  });

  test('worked boxes: 260 (Android 360 × 640) and 361 (iPhone 15)', () => {
    expect(compassGeometry(260)).toMatchObject({ outer: 129, tick: 4, letterPt: 10, shakeMax: 6.4 });
    expect(compassGeometry(361)).toMatchObject({ outer: 179.5, tick: 6, letterPt: 12 });
    expect(compassGeometry(361).shakeMax).toBeGreaterThan(12);
  });
});

test('every halo timing runs under the OS reduce-motion setting (the halo gates motion itself)', () => {
  for (const config of Object.values(HALO_TIMINGS)) expect(config.reduceMotion).toBe(ReduceMotion.Never);
  expect(HALO_TIMINGS.colorSpring).toMatchObject({ duration: 700, dampingRatio: 1 });
  expect([HALO_TIMINGS.intoBurst.duration, HALO_TIMINGS.outOfBurst.duration, HALO_TIMINGS.reduceColor.duration, HALO_TIMINGS.target.duration, HALO_TIMINGS.layer.duration]).toEqual([120, 400, 250, 400, 400]);
  expect([HALO_TIMINGS.shakeSwing.duration, HALO_TIMINGS.compass.duration]).toEqual([70, 700]);
});
