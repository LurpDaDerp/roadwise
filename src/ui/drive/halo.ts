// The driving screen's halo, as pure functions (drive-screen design §2, §4): the drive's signals in,
// one `HaloVisual` out, plus the ring's geometry, its colour ramps and the numerals' size. Nothing
// here animates; `Halo.tsx` feeds the visual into shared values.
//
// Severity is one number `s` in [0, 1], never rounded:
// - Speeding: a tint from the speed shown over the limit the sign shows (`speedingTint`: 0 at the
//   limit, 0.5 at that limit's speeding line, rising ever faster to 1), from the first moment the
//   speed passes the sign; it pulses only while the row is over the speeding line (`speedingLine`).
// - DashPal: a critical 0.80 + 0.07 per level + 0.02 per second (≤ 1); a warning, driver-not-visible
//   among them, 0.50 + 0.03 per second (≤ 0.80); a continuous advisory 0.30 + 0.01 per second (≤ 0.45,
//   below a warning's start).
// The strongest wins. Colour: calm blue-white → yellow (0.30) → orange (0.55) → red (1), in OKLab.
// A tint under the speeding line still flows (light moving round the ring) and never pulses; any
// pulse means a warning, faster the higher `s`. Sudden events burst: a few quick pulses (2.5 a
// second), then back. Each event shakes the ring sideways once, more for a more serious one.
// Around the ring, outside everything that pulses, a compass turns with the car (`compassGeometry`).
import { speedTolerance, type EventType, type Tier } from '@scoring';
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

/** The tint at the speeding line: half way to red. */
export const HALO_TINT_AT_LINE = 0.5;
/** How fast the tint's rise steepens: each tolerance more past the limit multiplies its rise by 3. */
export const HALO_TINT_BASE = 3;
/** The tint is full red this many tolerances past the limit: log₃ 5 ≈ 1.465 (42 mph on a 35, 79 on a 65). */
export const HALO_TINT_FULL_D = Math.log(1 + (HALO_TINT_BASE - 1) / HALO_TINT_AT_LINE) / Math.log(HALO_TINT_BASE);

/**
 * The halo's speeding tint from the speed shown over the limit the sign shows (`speedingRatio`) and
 * that limit (mph): with d the speed's way from the limit (0) to its speeding line (1), the tint is
 * 0.5 × (3^d − 1) / 2: 0 at or under the limit, all but calm just over it, 0.5 at the line and
 * rising ever faster to full red at d = log₃ 5, held there. 0 with no ratio or limit (the sign
 * shows "-").
 */
export function speedingTint(ratio: number | null, limitMph: number | null): number {
  if (ratio === null || limitMph === null || !Number.isFinite(ratio) || !(limitMph > 0) || !Number.isFinite(limitMph)) return 0;
  const d = ((ratio - 1) * limitMph) / speedTolerance(limitMph);
  if (!(d > 0)) return 0;
  return Math.min(1, (HALO_TINT_AT_LINE * (HALO_TINT_BASE ** d - 1)) / (HALO_TINT_BASE - 1));
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
  /** the row is over the speeding line (`speedingLine`): the only time speeding pulses */
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
/** A tick every this many degrees (none at N, E, S and W: the letters stand there). */
export const COMPASS_TICK_DEG = 15;
/**
 * The letters' ink in Barlow Semi Condensed ExtraBold (fontTools), of their type size: half the
 * widest one's width (W, 0.765 em) and half the tallest one's height (S, 0.716 em with its overshoot).
 */
export const COMPASS_LETTER_INK_EM = { halfW: 0.383, halfH: 0.358 } as const;
/** The farthest a letter's ink reaches from its centre at any angle on the card: its ink box's half-diagonal, rounded up. */
export const COMPASS_LETTER_REACH_EM = 0.53;
/** The letters are as large as the card's room allows, between these (never larger than the speed's unit). */
export const COMPASS_LETTER_MIN_PT = 12;
export const COMPASS_LETTER_MAX_PT = 20;
/**
 * In a line 1.2 em tall (ascender 1, descender 0.2) the caps (0.7 em) sit 0.05 em under the line's
 * middle; each letter is raised this much so its ink is centred on its point of the card.
 */
export const COMPASS_LETTER_RISE_EM = 0.05;
/** The type's line height, of its size (the face's ascender and descender, so no platform adds room). */
export const COMPASS_LETTER_LINE_EM = 1.2;
/** The ticks' strokes: the four between the letters (NE, SE, SW, NW), and the rest. */
export const COMPASS_TICK_STROKE = { major: 2.5, minor: 1.5 } as const;
/**
 * The card's inner edge sits this far outside the ring at its largest pulse wherever the box allows:
 * a severe event's full shake (7 pt) and 2 pt to spare, so the compass rings every halo at the same gap.
 */
export const COMPASS_RING_GAP_PT = SHAKE_PT.severe + 2;
/** Kept clear between the shaken ring at its largest pulse and anything the compass draws. */
const COMPASS_CLEAR_PT = 1;
/** Between the fixed mark's tip and a letter passing over it. */
const COMPASS_MARK_GAP_PT = 2;

export interface CompassGeometry {
  /** the compass's bound, just inside the box: nothing it draws reaches past it (the portrait band clears it) */
  outer: number;
  /** the ring's outer edge at its largest pulse, which nothing the compass draws comes inside */
  ring: number;
  /** the card's inner edge: the nearest a letter's ink or a tick comes to the centre, at any rotation */
  inner: number;
  /** the letters' type size, and the circle their ink is centred on (the ticks' middles sit on it too) */
  letterPt: number;
  letterR: number;
  /** a tick's length between the letters (NE, SE, SW, NW), and the others' */
  tick: number;
  minorTick: number;
  /**
   * The fixed mark at 12 o'clock, between the ring and the card: a triangle pointing out at the
   * course, its tip `markTip` from the centre, `markH` tall on a base `markW` wide.
   */
  markTip: number;
  markH: number;
  markW: number;
  /** the farthest the ring may shake sideways and stay clear of the compass at its largest pulse */
  shakeMax: number;
}

/**
 * The compass in a halo box of side `B`: one card around the ring, concentric with it, its inner
 * edge `COMPASS_RING_GAP_PT` outside the ring at its largest pulse; the letters as large as fit
 * between that and the box's edge (12–20 pt) with the ticks centred on their circle, and the fixed
 * mark in the gap at the top. A box too small for that gap and 12 pt letters puts the card against
 * its edge and narrows the gap (and the shake) instead. It never scales with the pulse.
 */
export function compassGeometry(B: number): CompassGeometry {
  const g = haloGeometry(B);
  const ring = (g.r + g.W / 2) * HALO_MAX_SCALE;
  const outer = B / 2 - 1;
  const reach = COMPASS_LETTER_REACH_EM;
  const fit = Math.floor((outer - ring - COMPASS_RING_GAP_PT) / (2 * reach));
  const letterPt = Math.min(COMPASS_LETTER_MAX_PT, Math.max(COMPASS_LETTER_MIN_PT, fit));
  const inner = Math.min(ring + COMPASS_RING_GAP_PT, outer - 2 * reach * letterPt);
  const letterR = inner + reach * letterPt;
  // The mark's tip a gap under a letter at the top; as tall as fits above the ring at its largest
  // pulse (a sideways shake never lifts the ring's top).
  const markTip = letterR - COMPASS_LETTER_INK_EM.halfH * letterPt - COMPASS_MARK_GAP_PT;
  const markH = Math.max(0, Math.min(Math.round(0.45 * letterPt), Math.floor(markTip - ring - COMPASS_CLEAR_PT)));
  return {
    outer,
    ring,
    inner,
    letterPt,
    letterR,
    tick: Math.round(0.5 * letterPt),
    minorTick: Math.round(0.3 * letterPt),
    markTip,
    markH,
    markW: Math.round(1.6 * markH),
    shakeMax: Math.max(0, Math.floor((inner - ring - COMPASS_CLEAR_PT) * 10 + 1e-6) / 10),
  };
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
