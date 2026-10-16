// The driving screen's halo, as pure functions (drive-screen design §2, §4): the drive's signals in,
// one `HaloVisual` out, plus the ring's geometry, its colour ramps and the numerals' size. Nothing
// here animates; `Halo.tsx` feeds the visual into shared values.
//
// Severity is one number `s` in [0, 1], never rounded:
// - Speeding: 0.30 + 0.035 per mph over the limit plus tolerance, kept inside the engine tier's band
//   (minor 0.30–0.475, moderate 0.475–0.65, severe 0.65–1), held through a speed hovering at the line
//   (`nextSpeedingHold`).
// - Phone use: 0.65 once the pickup counts, rising to 1 at 30 s of use, until the episode closes.
// - DashPal: a critical 0.80 + 0.07 per level + 0.02 per second (≤ 1); a warning 0.50 + 0.03 per
//   second (≤ 0.80); driver-not-visible a steady 0.35; a continuous advisory 0.30.
// The strongest wins. Colour: calm blue-white → yellow (0.30) → orange (0.55) → red (1), in OKLab.
// Calm flows (light moving round the ring) and never pulses; any pulse means a warning, faster the
// higher `s`. Sudden events burst: a few quick pulses (2.5 a second), then back.
import type { EventType, Tier } from '@scoring';
import { SPEEDING_END_BUFFER_MPH, SPEEDING_END_S, speedTolerance } from '@scoring';
import { interpolateColor } from 'react-native-reanimated';

import { HALO_BURST, HALO_MAX_SCALE, HALO_RAMP_STOPS, HALO_SPEED_HOLD_MAX_ROWS, type HudPalette } from './hudTokens';

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

const BAND: Readonly<Record<Tier, readonly [number, number]>> = { minor: [0.3, 0.475], moderate: [0.475, 0.65], severe: [0.65, 1] };

/**
 * The speeding severity of a row the engine put in `tier`: 0.30 + 0.035 per mph over L + T, kept in
 * the tier's band (so a tenths-rounded speed across a tier edge never contradicts the engine); the
 * band's low end with the speed or limit unknown.
 */
export function speedingSeverity(tier: Tier, speedMph: number | null, limitMph: number | null): number {
  const [lo, hi] = BAND[tier];
  if (speedMph === null || limitMph === null || !Number.isFinite(speedMph) || !Number.isFinite(limitMph)) return lo;
  const over = speedMph - (limitMph + speedTolerance(limitMph));
  return Math.min(hi, Math.max(lo, 0.3 + 0.035 * over));
}

/** The halo's speeding display hold, advanced once per new row. */
export interface SpeedingHold {
  s: number;
  /** consecutive rows without a tier and under L + T − 2 (or with the speed or limit unknown) */
  quietRows: number;
  /** rows since the engine last reported a tier */
  rowsSinceTier: number;
  rowTs: number | null;
}

export const SPEEDING_HOLD_NONE: SpeedingHold = Object.freeze({ s: 0, quietRows: 0, rowsSinceTier: 0, rowTs: null });

/** A row gap longer than this (back from the background) restarts the hold from the new row alone. */
export const HALO_ROW_GAP_MS = 3000;

export interface HoldRow {
  recording: boolean;
  rowTs: number | null;
  tier: Tier | null;
  speedMph: number | null;
  limitMph: number | null;
}

/**
 * The display hold, so a speed hovering at the line never flickers the halo: it enters on the first
 * row the engine calls over, decays 0.10 a row (never below 0.30) on a row without a tier, and ends
 * by the engine's own rule (5 rows under L + T − 2) or 10 rows after the last tier. Pure; a repeated
 * row changes nothing.
 */
export function nextSpeedingHold(prev: SpeedingHold, row: HoldRow): SpeedingHold {
  if (!row.recording || row.rowTs === null) return SPEEDING_HOLD_NONE;
  if (prev.rowTs !== null && row.rowTs === prev.rowTs) return prev;
  const fresh = prev.rowTs === null || row.rowTs < prev.rowTs || row.rowTs - prev.rowTs > HALO_ROW_GAP_MS;
  const base = fresh ? SPEEDING_HOLD_NONE : prev;
  if (row.tier !== null) return { s: speedingSeverity(row.tier, row.speedMph, row.limitMph), quietRows: 0, rowsSinceTier: 0, rowTs: row.rowTs };
  if (base.s <= 0) return { ...SPEEDING_HOLD_NONE, rowTs: row.rowTs };
  const near = row.speedMph !== null && row.limitMph !== null && row.speedMph >= row.limitMph + speedTolerance(row.limitMph) - SPEEDING_END_BUFFER_MPH;
  const quietRows = near ? 0 : base.quietRows + 1;
  const rowsSinceTier = base.rowsSinceTier + 1;
  if (quietRows >= SPEEDING_END_S || rowsSinceTier >= HALO_SPEED_HOLD_MAX_ROWS) return { ...SPEEDING_HOLD_NONE, rowTs: row.rowTs };
  return { s: Math.max(0.3, base.s - 0.1), quietRows, rowsSinceTier, rowTs: row.rowTs };
}

// ——— distraction ———

/** Phone use: 0.65 at confirmation, rising to 1 at 30 s of use (row clock on both sides). */
export function phoneSeverity(phoneUseSince: number | null, rowTs: number | null): number {
  if (phoneUseSince === null) return 0;
  const d = rowTs === null ? 0 : Math.max(0, rowTs - phoneUseSince) / 1000;
  return 0.65 + 0.35 * Math.min(1, Math.max(0, (d - 3) / 27));
}

/** A DashPal alert the halo shows for as long as it lasts (`since`: JS clock). */
export interface HeldDashpal {
  sound: number;
  tier: number;
  level: number;
  since: number;
}

/** DashPal's sound for "Driver not visible" (protocol sound 6). */
export const NO_FACE_SOUND = 6;

/** The held DashPal alert's severity; `steady` for driver-not-visible (colour, never a pulse). */
export function dashpalSeverity(held: HeldDashpal | null, now: number): { s: number; steady: boolean } {
  if (held === null) return { s: 0, steady: false };
  if (held.sound === NO_FACE_SOUND) return { s: 0.35, steady: true };
  const d = Math.max(0, now - held.since) / 1000;
  const level = Math.max(0, held.level);
  if (held.tier >= 3) return { s: Math.min(1, Math.max(0.8, 0.8 + 0.07 * level + 0.02 * d)), steady: false };
  if (held.tier === 2) return { s: Math.min(0.8, 0.5 + 0.03 * d), steady: false };
  return { s: 0.3, steady: false };
}

// ——— bursts ———

export interface HaloBurst {
  key: string;
  severity: number;
  pulses: 1 | 2 | 3;
  /** JS time the burst's flash ends; its colour holds until then */
  until: number;
}

/** A flash that may burst the halo. */
export type BurstSource =
  | { kind: 'phone'; type: EventType; at: number; until: number }
  | { kind: 'dashpal'; key: string; sound: number; tier: number; resend: boolean; until: number };

/**
 * What a flash bursts, or null: every phone alert except speeding is red × 3; a DashPal start or
 * level change is red × 3 (critical), orange-red × 3 (warning) or one amber pulse (advisory), never
 * for driver-not-visible or a reconnect's re-send.
 */
export function burstFor(src: BurstSource): { key: string; severity: number; pulses: 1 | 2 | 3; until: number } | null {
  if (src.kind === 'phone') {
    if (src.type === 'speeding') return null;
    return { key: `phone:${src.type}:${src.at}`, severity: 1, pulses: 3, until: src.until };
  }
  if (src.sound === NO_FACE_SOUND || src.resend) return null;
  const key = `dashpal:${src.key}`;
  if (src.tier >= 3) return { key, severity: 1, pulses: 3, until: src.until };
  if (src.tier === 2) return { key, severity: 0.75, pulses: 3, until: src.until };
  return { key, severity: 0.45, pulses: 1, until: src.until };
}

// ——— the visual ———

export interface HaloInput {
  reduceMotion: boolean;
  status: 'idle' | 'recording' | 'finalizing';
  /** the held speeding severity (`nextSpeedingHold`), 0 = none */
  speeding: number;
  /** the engine's confirmed phone episode's first use row (row clock) */
  phoneUseSince: number | null;
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
  /** light moving round the ring (calm only) */
  flow: boolean;
  /** null under Reduce Motion (the burst is then its colour only) */
  burst: HaloBurst | null;
  /** driver-not-visible: colour without a pulse */
  steady: boolean;
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
  steady: false,
});

/** The sustained pulse at severity `s` > 0: about every 1.8 s at 0.30 down to every 0.8 s at 1. */
export const pulsePeriodMs = (s: number): number => 2200 - 1400 * s;

/** The drive's signals → the halo. Calm unless the drive is recording. */
export function haloVisual(i: HaloInput): HaloVisual {
  if (i.status !== 'recording') return i.reduceMotion ? { ...HALO_CALM, flow: false } : HALO_CALM;
  const sSpeed = Math.min(1, Math.max(0, i.speeding));
  const sPhone = phoneSeverity(i.phoneUseSince, i.rowTs);
  const dp = dashpalSeverity(i.held, i.now);
  const distraction = Math.max(sPhone, dp.s);
  const s = Math.max(sSpeed, distraction);
  const steady = dp.steady && sSpeed === 0 && sPhone === 0;
  const bursting = i.burst !== null && i.now < i.burst.until;
  const mode: HaloMode = bursting ? 'burst' : distraction > 0 && distraction >= sSpeed ? 'distraction' : sSpeed > 0 ? 'speeding' : 'calm';
  const colorSeverity = bursting ? Math.max(s, i.burst!.severity) : s;
  const pulsing = s > 0 && !steady && !i.reduceMotion;
  return {
    mode,
    severity: s,
    colorSeverity,
    pulsePeriodMs: pulsing ? pulsePeriodMs(s) : 0,
    pulseDepth: pulsing ? 0.3 + 0.4 * s : 0,
    pulseScale: pulsing ? 0.015 + 0.02 * s : 0,
    flow: s === 0 && !bursting && !i.reduceMotion,
    burst: bursting && !i.reduceMotion ? i.burst : null,
    steady,
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

/** How many numerals a shown speed has ("—" counts as two). */
export const speedDigits = (speed: number | null): number => (speed === null ? 2 : Math.max(2, String(Math.abs(Math.round(speed))).length));

/** The burst's own rhythm (every pulse 400 ms: 2.5 a second, under three flashes a second). */
export const BURST_PERIOD_MS = HALO_BURST.periodMs;
