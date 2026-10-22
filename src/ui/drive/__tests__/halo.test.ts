// The halo's pure rules (drive-screen design §2, §4): severity per signal, the speeding tint, bursts,
// the shake, the visual, the colour ramps, the geometry and the compass.
import { interpolateColor, ReduceMotion } from 'react-native-reanimated';

import { contrastRatio } from '@/ui/contrast';

import {
  burstFor,
  COMPASS_LETTER_INK_EM,
  COMPASS_LETTER_MAX_PT,
  COMPASS_LETTER_MIN_PT,
  COMPASS_LETTER_REACH_EM,
  COMPASS_LETTERS,
  COMPASS_RING_GAP_PT,
  COMPASS_TICK_DEG,
  COMPASS_TICK_STROKE,
  compassGeometry,
  type CompassGeometry,
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
  rampColor,
  ringRamp,
  shakeAmplitudePt,
  SHAKE_PT,
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

describe('DashPal severities (§4.3)', () => {
  const T = 1_790_000_000_000;

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
  test.each(['hard_brake', 'hard_accel', 'hard_corner', 'eyes_off', 'drowsy'] as const)('event %s: red × 3, keyed by type and time', (type) => {
    expect(burstFor({ kind: 'event', type, at: 5, until: 99 })).toEqual({ key: `event:${type}:5`, severity: 1, pulses: 3, until: 99 });
  });
  test('a speeding alert never bursts', () => {
    expect(burstFor({ kind: 'event', type: 'speeding', at: 5, until: 99 })).toBeNull();
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
    shake: null,
    rowTs: T,
    held: null,
    now: T,
    burst: null,
    ...over,
  });
  const burst: HaloBurst = { key: 'event:hard_brake:1', severity: 1, pulses: 3, until: T + 1500 };

  test('calm: no pulse, flowing, no warning, no shake', () => {
    expect(haloVisual(input())).toEqual(HALO_CALM);
    expect(HALO_CALM).toMatchObject({ mode: 'calm', pulsePeriodMs: 0, pulseDepth: 0, pulseScale: 0, flow: true, warning: false, shake: null });
  });

  test('over the speeding line: pulsing by the formulas, the flow stopped, a warning; every period at least 800 ms', () => {
    for (const s of [0.17, 0.3, 0.5, 0.825, 1]) {
      const v = haloVisual(input({ speeding: s, speedingOver: true }));
      expect(v).toMatchObject({ mode: 'speeding', severity: s, colorSeverity: s, flow: false, warning: true });
      expect(v.pulsePeriodMs).toBeCloseTo(2200 - 1400 * s, 6);
      expect(v.pulseDepth).toBeCloseTo(0.3 + 0.4 * s, 6);
      expect(v.pulseScale).toBeCloseTo(0.015 + 0.02 * s, 6);
    }
    for (const s of samples) expect(haloVisual(input({ speeding: s, speedingOver: true })).pulsePeriodMs).toBeGreaterThanOrEqual(800);
  });

  test('tinted but under the speeding line: the colour only; no pulse, still flowing, not a warning', () => {
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
    const warn = { sound: 1, tier: 2, level: 0, since: T };
    const v = haloVisual(input({ speeding: 0.3, held: warn }));
    expect(v).toMatchObject({ mode: 'distraction', severity: 0.5, warning: true, flow: false });
    expect(v.pulsePeriodMs).toBeCloseTo(2200 - 1400 * 0.5, 6);
    expect(haloVisual(input({ speeding: 0.9, held: warn }))).toMatchObject({ mode: 'speeding', severity: 0.9 });
    expect(haloVisual(input({ speeding: 0.5, held: warn })).mode).toBe('distraction');
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
    const warn = { sound: 1, tier: 2, level: 0, since: T + 2000 };
    const sustained = haloVisual(input({ burst, held: warn }));
    expect(sustained).toMatchObject({ mode: 'burst', severity: 0.5, colorSeverity: 1 });
    expect(haloVisual(input({ burst, held: warn, now: T + 2000 }))).toMatchObject({ mode: 'distraction', colorSeverity: 0.5, burst: null });
    // a weaker burst never lowers the colour
    expect(haloVisual(input({ speeding: 0.9, burst: { ...burst, severity: 0.45 } })).colorSeverity).toBe(0.9);
  });

  test('an event: the shake carries its key and tier, whatever else shows; none under Reduce Motion', () => {
    const shake = { key: 'hard_brake:1@5', tier: 'severe' as const };
    expect(haloVisual(input({ shake })).shake).toEqual(shake);
    expect(haloVisual(input({ shake, speeding: 0.5, speedingOver: true })).shake).toEqual(shake);
    // a shake alone is not a warning: the colour and the flow stay as they are
    expect(haloVisual(input({ shake }))).toMatchObject({ mode: 'calm', flow: true, warning: false });
    expect(haloVisual(input({ shake, reduceMotion: true })).shake).toBeNull();
    expect(haloVisual(input({ shake, status: 'finalizing' })).shake).toBeNull();
  });

  test('not recording: calm whatever the inputs', () => {
    for (const status of ['idle', 'finalizing'] as const) {
      expect(
        haloVisual(input({ status, speeding: 1, speedingOver: true, shake: { key: 'k', tier: 'severe' }, held: { sound: 3, tier: 3, level: 3, since: T }, burst }))
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
  test('by tier: 3 pt for a minor event, 5 for moderate, 7 for severe, in a large box', () => {
    expect(SHAKE_PT).toEqual({ minor: 3, moderate: 5, severe: 7 });
    expect(shakeAmplitudePt('minor', 420)).toBe(3);
    expect(shakeAmplitudePt('moderate', 420)).toBe(5);
    expect(shakeAmplitudePt('severe', 420)).toBe(7);
  });

  test('never past what keeps the ring inside the compass at its largest pulse, in every box', () => {
    for (let B = 220; B <= 420; B += 1) {
      const g = haloGeometry(B);
      const c = compassGeometry(B);
      for (const tier of ['minor', 'moderate', 'severe'] as const) {
        const a = shakeAmplitudePt(tier, B);
        expect(a).toBeLessThanOrEqual(c.shakeMax);
        expect((g.r + g.W / 2) * HALO_MAX_SCALE + a).toBeLessThan(c.inner);
      }
      expect(c.shakeMax).toBeGreaterThanOrEqual(5);
    }
    // a severe shake in full from a 260 pt box up; the smallest boxes cap it at their gap
    expect(shakeAmplitudePt('severe', 260)).toBe(7);
    expect(shakeAmplitudePt('severe', 220)).toBe(compassGeometry(220).shakeMax);
    expect(compassGeometry(220).shakeMax).toBe(5);
  });

  test('swings side to side, fading out, back to rest: four swings, six for a severe event', () => {
    expect(shakeOffsets(8, 'moderate')).toEqual([8, -6, 4, -2, 0]);
    expect(shakeOffsets(8, 'minor')).toHaveLength(5);
    const big = shakeOffsets(12, 'severe');
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

  // A letter's ink box on the card turned `rot` degrees, from the halo's centre (y down): every letter
  // as wide as a W and as tall as an S.
  const inkBox = (c: CompassGeometry, bearing: number, rot: number) => {
    const a = ((bearing + rot) * Math.PI) / 180;
    return { x: c.letterR * Math.sin(a), y: -c.letterR * Math.cos(a), w: COMPASS_LETTER_INK_EM.halfW * c.letterPt, h: COMPASS_LETTER_INK_EM.halfH * c.letterPt };
  };
  type Box = ReturnType<typeof inkBox>;
  const farthest = (b: Box) => Math.hypot(Math.abs(b.x) + b.w, Math.abs(b.y) + b.h);
  /** The nearest the box comes to a ring centre moved `dx` sideways (the shake). */
  const nearestFrom = (b: Box, dx: number) => Math.hypot(Math.max(0, Math.abs(b.x - dx) - b.w), Math.max(0, Math.abs(b.y) - b.h));
  const rotations = Array.from({ length: 720 }, (_, i) => i / 2);
  const tickBearings = Array.from({ length: 24 }, (_, i) => i * COMPASS_TICK_DEG).filter((b) => b % 90 !== 0);

  test('every letter, at every rotation of the card, in every ring box: its ink inside the compass’s bound, clear of the ring at its largest pulse shaken either way', () => {
    for (let B = 220; B <= 420; B += 1) {
      const c = compassGeometry(B);
      const g = haloGeometry(B);
      expect(c.outer).toBe(B / 2 - 1);
      expect(c.ring).toBeCloseTo((g.r + g.W / 2) * HALO_MAX_SCALE, 9);
      let far = 0;
      let near = Infinity;
      for (const rot of rotations) {
        for (const l of COMPASS_LETTERS) {
          const b = inkBox(c, l.bearing, rot);
          far = Math.max(far, farthest(b));
          near = Math.min(near, nearestFrom(b, c.shakeMax), nearestFrom(b, -c.shakeMax));
        }
      }
      expect(far).toBeLessThanOrEqual(c.outer);
      expect(near).toBeGreaterThanOrEqual(c.ring + 1 - 1e-9);
      // the card's inner edge is the letters' nearest reach
      expect(c.inner).toBeCloseTo(c.letterR - COMPASS_LETTER_REACH_EM * c.letterPt, 9);
      expect(c.shakeMax).toBeLessThanOrEqual(c.inner - c.ring - 1 + 1e-9);
    }
  });

  test('the ticks: none at N, E, S and W, the ones between them longer, all centred on the letters’ circle inside the card', () => {
    expect(tickBearings).toHaveLength(20);
    expect(tickBearings.filter((b) => b % 45 === 0)).toEqual([45, 135, 225, 315]);
    expect(COMPASS_TICK_STROKE).toEqual({ major: 2.5, minor: 1.5 });
    for (let B = 220; B <= 420; B += 1) {
      const c = compassGeometry(B);
      expect(c.minorTick).toBeLessThan(c.tick);
      // a round cap reaches half the stroke past each end
      expect(c.letterR + c.tick / 2 + COMPASS_TICK_STROKE.major / 2).toBeLessThanOrEqual(c.outer);
      expect(c.letterR - c.tick / 2 - COMPASS_TICK_STROKE.major / 2).toBeGreaterThanOrEqual(c.inner);
      // the ticks clear the mark when they pass over it
      expect(c.letterR - c.tick / 2 - COMPASS_TICK_STROKE.major / 2).toBeGreaterThan(c.markTip + 1);
    }
  });

  test('the fixed mark: in the gap at the top, clear of the ring at its largest pulse, its tip under any letter passing over it', () => {
    for (let B = 220; B <= 420; B += 1) {
      const c = compassGeometry(B);
      const base = c.markTip - c.markH;
      // a sideways shake never lifts the ring's top, so the base only clears the largest pulse
      expect(base).toBeGreaterThanOrEqual(c.ring + 1);
      expect(c.markH).toBeGreaterThanOrEqual(5);
      expect(c.markW).toBe(Math.round(1.6 * c.markH));
      let gap = Infinity;
      for (const rot of rotations) {
        for (const l of COMPASS_LETTERS) {
          const b = inkBox(c, l.bearing, rot);
          if (Math.abs(b.x) >= b.w + c.markW / 2 || b.y > 0) continue;
          gap = Math.min(gap, -b.y - b.h - c.markTip);
        }
      }
      expect(gap).toBeGreaterThanOrEqual(1);
    }
  });

  test('one gap round every ring: the card 9 pt outside the ring at its largest pulse from a 253 pt box up (room for a severe shake), the letters 12 to 20 pt', () => {
    expect(COMPASS_RING_GAP_PT).toBe(9);
    for (let B = 220; B <= 420; B += 1) {
      const c = compassGeometry(B);
      expect(c.letterPt).toBeGreaterThanOrEqual(COMPASS_LETTER_MIN_PT);
      expect(c.letterPt).toBeLessThanOrEqual(COMPASS_LETTER_MAX_PT);
      if (B >= 253) {
        expect(c.inner - c.ring).toBeCloseTo(COMPASS_RING_GAP_PT, 9);
        expect(c.shakeMax).toBe(8);
      } else {
        // too small for the gap and 12 pt letters: the card against the bound, the gap narrower
        expect(c.letterPt).toBe(COMPASS_LETTER_MIN_PT);
        expect(c.letterR + COMPASS_LETTER_REACH_EM * c.letterPt).toBeCloseTo(c.outer, 9);
        expect(c.inner - c.ring).toBeLessThan(COMPASS_RING_GAP_PT);
      }
    }
    expect(COMPASS_LETTER_MIN_PT).toBe(12);
    expect(COMPASS_LETTER_MAX_PT).toBe(20);
  });

  test('worked boxes: 240 (320 × 568), 260 (Android 360 × 640), 295 (iPhone SE), 343 (13 mini), 361 (iPhone 15), 398 (15 Pro Max), 420', () => {
    const pick = (B: number) => {
      const c = compassGeometry(B);
      return [c.letterPt, c.tick, c.minorTick, c.markH, c.markW, c.shakeMax];
    };
    expect(pick(240)).toEqual([12, 6, 4, 5, 8, 6]);
    expect(pick(260)).toEqual([12, 6, 4, 5, 8, 8]);
    expect(pick(295)).toEqual([15, 8, 5, 7, 11, 8]);
    expect(pick(343)).toEqual([19, 10, 6, 9, 14, 8]);
    expect(pick(361)).toEqual([20, 10, 6, 9, 14, 8]);
    expect(pick(398)).toEqual([20, 10, 6, 9, 14, 8]);
    expect(pick(420)).toEqual([20, 10, 6, 9, 14, 8]);
    const c = compassGeometry(361);
    expect(c.outer).toBe(179.5);
    expect(c.inner).toBeCloseTo(157.26, 2);
    expect(c.letterR).toBeCloseTo(167.86, 2);
  });
});

test('every halo timing runs under the OS reduce-motion setting (the halo gates motion itself)', () => {
  for (const config of Object.values(HALO_TIMINGS)) expect(config.reduceMotion).toBe(ReduceMotion.Never);
  expect(HALO_TIMINGS.colorSpring).toMatchObject({ duration: 700, dampingRatio: 1 });
  expect([HALO_TIMINGS.intoBurst.duration, HALO_TIMINGS.outOfBurst.duration, HALO_TIMINGS.reduceColor.duration, HALO_TIMINGS.target.duration, HALO_TIMINGS.layer.duration]).toEqual([120, 400, 250, 400, 400]);
  expect([HALO_TIMINGS.shakeSwing.duration, HALO_TIMINGS.compass.duration]).toEqual([70, 700]);
});
