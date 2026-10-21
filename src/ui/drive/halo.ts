// The driving screen's halo, as pure functions (drive-screen design §2, §4): the drive's signals in,
// one `HaloVisual` out, plus the ring's geometry, its colour ramps and the numerals' size. Nothing
// here animates; `Halo.tsx` feeds the visual into shared values.
//
// Severity is one number `s` in [0, 1], never rounded:
// - Speeding: a tint from the row speed over the posted limit (`speedingTint`: 0 at the limit, 1 at
//   1.7 × it), following each row; it pulses only while the row is over the speeding line (L + T).
// - DashPal: a critical 0.80 + 0.07 per level + 0.02 per second (≤ 1); a warning, driver-not-visible
//   among them, 0.50 + 0.03 per second (≤ 0.80); a continuous advisory 0.30 + 0.01 per second (≤ 0.45,
//   below a warning's start).
// The strongest wins. Colour: calm blue-white → yellow (0.30) → orange (0.55) → red (1), in OKLab.
// A tint under the speeding line still flows (light moving round the ring) and never pulses; any
// pulse means a warning, faster the higher `s`. Sudden events burst: a few quick pulses (2.5 a
// second), then back. Each event shakes the ring sideways once, more for a more serious one.
// Around the ring, outside everything that pulses, a compass turns with the car (`compassGeometry`).
import type { EventType, Tier } from '@scoring';
import { interpolateColor } from 'react-native-reanimated';

import { HALO_BURST, HALO_MAX_SCALE, HALO_RAMP_STOPS, type HudPalette } from './hudTokens';

// ——— colour ———

export type Ramp = readonly [string, string, string, string];

/** The ring's colours at the ramp stops: calm, yellow, orange, the red end. */
export const ringRamp = (p: HudPalette): Ramp => [p.haloCalm, p.minor, p.moderate, p.haloSevere];
/** The speed numerals' colours at the ramp stops: white, yellow, orange, red (text-safe). */
export const numeralRamp = (p: HudPalette): Ramp => [p.haloInk, p.minor, p.moderate, p.severe];

type Lab = { l: number; a: number; b: number };

const toLinear = (c: number): number => (Math.abs(c) <= 0.04045 ? c / 12.92 : (Math.sign(c) || 1) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4);

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

/** OKLab of a `#rrggbb` colour (the same matrices as Reanimated's `'LAB'` interpolation). */
export function oklabOf(hex: string): Lab {
  const [r, g, b] = hexRgb(hex).map(toLinear) as [number, number, number];
  const L = Math.cbrt(0.41222147079999993 * r + 0.5363325363 * g + 0.0514459929 * b);
  const M = Math.cbrt(0.2119034981999999 * r + 0.6806995450999999 * g + 0.1073969566 * b);
  const S = Math.cbrt(0.08830246189999998 * r + 0.2817188376 * g + 0.6299787005000002 * b);
  return {
    l: 0.2104542553 * L + 0.793617785 * M - 0.0040720468 * S,
    a: 1.9779984951 * L - 2.428592205 * M + 0.4505937099 * S,
    b: 0.0259040371 * L + 0.7827717662 * M - 0.808675766 * S,
  };
}

/** 100 × the OKLab distance between two colours (ΔE_OK). */
export function deltaEOk(x: string, y: string): number {
  const p = oklabOf(x);
  const q = oklabOf(y);
  return 100 * Math.hypot(p.l - q.l, p.a - q.a, p.b - q.b);
}

/**
 * The ramp's colour at severity `s` (clamped to [0, 1]) as `#RRGGBB`: Reanimated's own OKLab
 * interpolation between the stops, the very colour the ring and the numerals are drawn in.
 */
export function rampColor(ramp: Ramp, s: number): string {
  const v = Math.min(1, Math.max(0, Number.isFinite(s) ? s : 0));
  const out = String(interpolateColor(v, [...HALO_RAMP_STOPS], [...ramp], 'LAB'));
  const ch = (out.match(/-?[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map((x) => Math.round(Math.min(255, Math.max(0, Number(x)))));
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/**
 * The view opacity of glow layer `layer` (0 calm, 1 yellow, 2 orange, 3 red) at severity `s`: the
 * two layers around `s` cross-fade, the rest are 0, and they always sum to 1. A worklet.
 */
export function glowWeight(layer: number, s: number): number {
  'worklet';
  const v = Math.min(1, Math.max(0, s));
  const stops = HALO_RAMP_STOPS;
  let i = 0;
  while (i < stops.length - 2 && v > stops[i + 1]!) i += 1;
  const t = (v - stops[i]!) / (stops[i + 1]! - stops[i]!);
  if (layer === i) return 1 - t;
  if (layer === i + 1) return t;
  return 0;
}

// ——— speeding ———

/** The tint is full red at this many times the posted limit (1.7 ×). */
export const HALO_TINT_FULL_RATIO = 1.7;

/**
 * The halo's speeding tint from the row speed over the posted limit speeding is judged on
 * (`speedingRatio`): 0 at or under the limit, rising straight to 1 at 1.7 × it, so just over the
 * limit is all but the calm colour. 0 with no ratio (no usable limit or speed).
 */
export function speedingTint(ratio: number | null): number {
  if (ratio === null || !Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, (ratio - 1) / (HALO_TINT_FULL_RATIO - 1)));
}

// ——— distraction ———

/** A DashPal alert the halo shows for as long as it lasts (`since`: JS clock). */
export interface HeldDashpal {
  sound: number;
  tier: number;
  level: number;
  since: number;
}

/**
 * The held DashPal alert's severity, by its tier: the longer it lasts the redder (and the faster it
 * pulses). Driver-not-visible (sound 6) is a warning (tier 2) like any other.
 */
export function dashpalSeverity(held: HeldDashpal | null, now: number): number {
  if (held === null) return 0;
  const d = Math.max(0, now - held.since) / 1000;
  const level = Math.max(0, held.level);
  if (held.tier >= 3) return Math.min(1, Math.max(0.8, 0.8 + 0.07 * level + 0.02 * d));
  if (held.tier === 2) return Math.min(0.8, 0.5 + 0.03 * d);
  return Math.min(0.45, 0.3 + 0.01 * d);
}

// ——— bursts ———

export interface HaloBurst {
  key: string;
  severity: number;
  pulses: 1 | 2 | 3;
  /** JS time the burst's flash ends; its colour holds until then */
  until: number;
}

/** A flash that may burst the halo: the phone's own event chip, or a DashPal alert. */
export type BurstSource =
  | { kind: 'event'; type: EventType; at: number; until: number }
  | { kind: 'dashpal'; key: string; sound: number; tier: number; resend: boolean; until: number };

/**
 * What a flash bursts, or null: every event chip except speeding (a hard brake, start or turn, and
 * DashPal's own events), and every DashPal alert start or level change (a distraction or drowsiness
 * warning of any tier, driver-not-visible included), is red × 3; never a reconnect's re-send.
 */
export function burstFor(src: BurstSource): { key: string; severity: number; pulses: 1 | 2 | 3; until: number } | null {
  if (src.kind === 'event') {
    if (src.type === 'speeding') return null;
    return { key: `event:${src.type}:${src.at}`, severity: 1, pulses: 3, until: src.until };
  }
  if (src.resend) return null;
  return { key: `dashpal:${src.key}`, severity: 1, pulses: 3, until: src.until };
}

// ——— the visual ———

/** An event just happened (`DriveLive.lastShake`, fresh on the row clock): the ring shakes once per key, sized by its tier. */
export interface HaloShake {
  key: string;
  tier: Tier;
}

export interface HaloInput {
  reduceMotion: boolean;
  status: 'idle' | 'recording' | 'finalizing';
  /** the speeding tint (`speedingTint`), 0 = none */
  speeding: number;
  /** the row is over the speeding line (L + T): the only time speeding pulses */
  speedingOver: boolean;
  /** an event that just happened, or null */
  shake: HaloShake | null;
  /** the engine's newest row (row clock) */
  rowTs: number | null;
  held: HeldDashpal | null;
  /** JS clock at render */
  now: number;
  burst: HaloBurst | null;
}

export type HaloMode = 'calm' | 'speeding' | 'distraction' | 'burst';

export interface HaloVisual {
  mode: HaloMode;
  /** sustained, 0..1 */
  severity: number;
  /** what the colour shows: the burst's severity while it lasts, if higher */
  colorSeverity: number;
  /** 0 = no pulse */
  pulsePeriodMs: number;
  pulseDepth: number;
  pulseScale: number;
  /** light moving round the ring (no warning showing) */
  flow: boolean;
  /** null under Reduce Motion (the burst is then its colour only) */
  burst: HaloBurst | null;
  /**
   * A warning shows (over the speeding line, a DashPal alert, a burst): the dimmed screen's halo
   * comes back to full strength. A tint under the line alone is not one.
   */
  warning: boolean;
  /** the ring's sideways shake for an event, once per key, sized by its tier; null under Reduce Motion */
  shake: HaloShake | null;
}

export const HALO_CALM: HaloVisual = Object.freeze({
  mode: 'calm',
  severity: 0,
  colorSeverity: 0,
  pulsePeriodMs: 0,
  pulseDepth: 0,
  pulseScale: 0,
  flow: true,
  burst: null,
  warning: false,
  shake: null,
});

/** The sustained pulse at severity `s` > 0: about every 1.8 s at 0.30 down to every 0.8 s at 1. */
export const pulsePeriodMs = (s: number): number => 2200 - 1400 * s;

/**
 * The drive's signals → the halo. Calm unless the drive is recording. The speeding tint colours the
 * ring from the limit up; it pulses only while the row is over the speeding line, and DashPal
 * alerts pulse while they last.
 */
export function haloVisual(i: HaloInput): HaloVisual {
  if (i.status !== 'recording') return i.reduceMotion ? { ...HALO_CALM, flow: false } : HALO_CALM;
  const sSpeed = Number.isFinite(i.speeding) ? Math.min(1, Math.max(0, i.speeding)) : 0;
  const over = i.speedingOver;
  const distraction = dashpalSeverity(i.held, i.now);
  const s = Math.max(sSpeed, distraction);
  const bursting = i.burst !== null && i.now < i.burst.until;
  const mode: HaloMode = bursting
    ? 'burst'
    : distraction > 0 && distraction >= sSpeed
      ? 'distraction'
      : sSpeed > 0 || over
        ? 'speeding'
        : 'calm';
  const colorSeverity = bursting ? Math.max(s, i.burst!.severity) : s;
  const warning = bursting || distraction > 0 || over;
  const pulsing = (over || distraction > 0) && !i.reduceMotion;
  return {
    mode,
    severity: s,
    colorSeverity,
    pulsePeriodMs: pulsing ? pulsePeriodMs(s) : 0,
    pulseDepth: pulsing ? 0.3 + 0.4 * s : 0,
    pulseScale: pulsing ? 0.015 + 0.02 * s : 0,
    flow: !warning && !i.reduceMotion,
    burst: bursting && !i.reduceMotion ? i.burst : null,
    warning,
    shake: i.reduceMotion || i.shake === null ? null : i.shake,
  };
}

// ——— the shake ———

/** The shake's reach (pt) for each tier, before the compass's cap. */
export const SHAKE_PT: Readonly<Record<Tier, number>> = { minor: 3, moderate: 5, severe: 7 };

/**
 * How far (pt) the ring shakes for an event of `tier` in a box of side `B`: 3 for minor, 5 for
 * moderate, 7 for severe, never past what keeps the ring inside the compass
 * (`compassGeometry(B).shakeMax`). An unknown tier shakes as a moderate one.
 */
export function shakeAmplitudePt(tier: Tier, B: number): number {
  return Math.min(compassGeometry(B).shakeMax, SHAKE_PT[tier] ?? SHAKE_PT.moderate);
}

/** The shake's swings, as offsets (pt): alternating sides, fading out, then back to 0. Four swings, six for a severe event. */
export function shakeOffsets(amplitude: number, tier: Tier): number[] {
  const n = tier === 'severe' ? 6 : 4;
  const out: number[] = [];
  for (let k = 0; k < n; k += 1) out.push((k % 2 === 0 ? 1 : -1) * amplitude * (1 - k / n));
  out.push(0);
  return out;
}

// ——— the compass ———

/**
 * The compass card's next rotation (degrees, unwrapped): `target` reached from `prev` the short way
 * round, so 350° → 10° turns 20°, never 340° back.
 */
export function nextCompassAngle(prev: number, target: number): number {
  const d = ((((target - prev) % 360) + 540) % 360) - 180;
  return prev + d;
}

/** The compass's letters, their bearings (clockwise from north). */
export const COMPASS_LETTERS = [
  { label: 'N', bearing: 0 },
  { label: 'E', bearing: 90 },
  { label: 'S', bearing: 180 },
  { label: 'W', bearing: 270 },
] as const;
/** A tick every this many degrees. */
export const COMPASS_TICK_DEG = 15;
/** Half a letter's extent from its centre, of its type size (a wide W). */
const COMPASS_LETTER_HALF_EM = 0.42;
/** Between the ticks and the letters. */
const COMPASS_GAP_PT = 2;

export interface CompassGeometry {
  /** the outer edge: where the ticks end and the fixed mark sits */
  outer: number;
  /** a cardinal tick's length, and the others' */
  tick: number;
  minorTick: number;
  /** the letters' type size and the radius their centres sit on */
  letterPt: number;
  letterR: number;
  /** the innermost reach of anything the compass draws */
  inner: number;
  /** the fixed mark at the top: a triangle pointing in */
  markH: number;
  markW: number;
  /** the farthest the ring may shake sideways and stay clear of the compass at its largest pulse */
  shakeMax: number;
}

/**
 * The compass in a halo box of side `B`: ticks just inside the box's edge, the letters inside them,
 * all of it outside the ring at its largest pulse with room for the shake. It never scales.
 */
export function compassGeometry(B: number): CompassGeometry {
  const g = haloGeometry(B);
  const outer = B / 2 - 1;
  const tick = Math.min(7, Math.max(4, Math.round(0.016 * B)));
  const minorTick = Math.max(2, Math.round(0.55 * tick));
  const letterPt = Math.min(14, Math.max(10, Math.round(0.034 * B)));
  const half = COMPASS_LETTER_HALF_EM * letterPt;
  const letterR = outer - tick - COMPASS_GAP_PT - half;
  const inner = letterR - half;
  const ringMax = (g.r + g.W / 2) * HALO_MAX_SCALE;
  const shakeMax = Math.max(0, Math.floor((inner - ringMax - 1) * 10) / 10);
  return { outer, tick, minorTick, letterPt, letterR, inner, markH: tick + 1, markW: Math.round(1.4 * (tick + 1)), shakeMax };
}

// ——— geometry ———

export interface HaloGeometry {
  /** the square box */
  box: number;
  /** the glow's outer radius at rest */
  Ro: number;
  /** ring thickness */
  W: number;
  /** glow reach outward and inward */
  Go: number;
  Gi: number;
  /** the ring's centre-line radius */
  r: number;
  /** nothing is lit inside this radius */
  rc: number;
}

/** The ring in a box of side `B`; it fits even at the largest pulse scale. */
export function haloGeometry(B: number): HaloGeometry {
  const Ro = B / (2 * HALO_MAX_SCALE);
  const W = Math.min(24, Math.max(14, Math.round(0.06 * B)));
  const Go = Math.round(0.085 * B);
  const Gi = Math.round(0.25 * Go);
  const r = Ro - Go - W / 2;
  return { box: B, Ro, W, Go, Gi, r, rc: r - W / 2 - Gi };
}

/** The soft glow's radial gradient: offsets (of `Ro`) and opacities, a gaussian-like falloff. */
export function glowStops(g: HaloGeometry): { offset: number; opacity: number }[] {
  const at = (x: number) => Math.min(1, Math.max(0, x / g.Ro));
  const out = [
    { offset: at(g.rc), opacity: 0 },
    { offset: at(g.r - g.W / 2), opacity: 0.3 },
    { offset: at(g.r), opacity: 0.45 },
    { offset: at(g.r + g.W / 2), opacity: 0.32 },
  ];
  for (let k = 1; k <= 8; k += 1) {
    out.push({ offset: at(g.r + g.W / 2 + (k * g.Go) / 8), opacity: k === 8 ? 0 : 0.32 * Math.exp(-3 * (k / 8) ** 2) });
  }
  return out;
}

/** Numeral metrics of BarlowSemiCondensed ExtraBold (fontTools): tabular digit advance, digit height. */
export const DIGIT_ADVANCE_EM = 0.535;
export const DIGIT_HEIGHT_EM = 0.714;
/** The numerals never exceed this. */
export const HALO_NUMERAL_MAX_PT = 168;
/** Below the ring outside compact windows the numerals never go under this. */
export const HALO_NUMERAL_MIN_PT = 96;

/**
 * The largest whole pt (≤ 168) at which `digits` numerals, optically centred, and the unit label
 * under them (`unitPt` tall and half as wide as `unitPt` ×2) fit inside 0.94 of the clear radius.
 */
export function haloNumeralPt(rc: number, digits: number, unitPt: number): number {
  const lim = (0.94 * rc) ** 2;
  const n = Math.max(1, digits);
  for (let pt = HALO_NUMERAL_MAX_PT; pt > 1; pt -= 1) {
    const half = (n * DIGIT_ADVANCE_EM * pt) / 2;
    const top = (DIGIT_HEIGHT_EM / 2) * pt;
    if (half ** 2 + top ** 2 > lim) continue;
    const unitBottom = top + 6 + 0.92 * unitPt;
    if (unitPt ** 2 + unitBottom ** 2 > lim) continue;
    return pt;
  }
  return 1;
}

/** How many numerals a shown speed has ("-" counts as two). */
export const speedDigits = (speed: number | null): number => (speed === null ? 2 : Math.max(2, String(Math.abs(Math.round(speed))).length));

/** The burst's own rhythm (every pulse 400 ms: 2.5 a second, under three flashes a second). */
export const BURST_PERIOD_MS = HALO_BURST.periodMs;
