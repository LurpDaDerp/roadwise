import type { Tier } from '@scoring';

/**
 * The driving screen's palette (DESIGN.md "HUD exception"). True black in every light, lit
 * numerals, a speed-limit sign, one colour per event tier — yellow, orange, red, as on the drive
 * summary — for the alert chips, and the halo's own colours: a light blue-white calm ring, a
 * saturated red end, and a white speed inside it. `night` is the same palette dimmed for eyes adapted
 * to an unlit road: neutral greys and a near-white sign, no pure white, nothing warmed. Yellow is
 * the minor tier's, and the dangerous-weather banner's outline and glyph (always with its title and
 * a warning glyph, so colour never carries it alone); no other mark on the screen wears it.
 *
 * Every foreground/background pair holds at least 7:1 (`HUD_CONTRAST_PAIRS`) and every graphic at
 * least 4.5:1 (`HUD_GRAPHIC_PAIRS`), measured in `__tests__/hudContrast.test.ts`. Literals only:
 * the HUD's colours are its own.
 */
export type HudPalette = {
  /** Screen ground: true black. */
  ground: string;
  /** Speed numerals and other print. */
  ink: string;
  /** Unit labels and quiet print. */
  inkMuted: string;
  /** The limit sign: face, print, and its red ring (a graphic, ≥ 3:1 on the face). */
  signFace: string;
  signInk: string;
  signRing: string;
  /** Event tiers: the alert chips, and the halo's ramp stops (yellow 0.30, orange 0.55). */
  minor: string;
  moderate: string;
  severe: string;
  /** The halo: its calm ring (light blue-white), its red end (a graphic), and the speed inside it. */
  haloCalm: string;
  haloSevere: string;
  /** The speed numerals while the halo is calm (white by day, a dimmed neutral white at night). */
  haloInk: string;
  /** The unit label inside the halo. */
  haloInkMuted: string;
  /** Points gained since the last stop. */
  gain: string;
  /** The End button's face and its ring track. */
  chrome: string;
  chromeEdge: string;
};

const day: HudPalette = {
  ground: '#000000',
  ink: '#F3F6FB',
  inkMuted: '#A9BAD6',
  signFace: '#FFFFFF',
  signInk: '#000000',
  signRing: '#D7263D',
  minor: '#FFC300', // school-bus yellow
  moderate: '#FF9A45',
  severe: '#FF7070', // soft red, so black print reads on it
  haloCalm: '#CFE6FF',
  haloSevere: '#FF3B3B',
  haloInk: '#F3F6FB',
  haloInkMuted: '#A9BAD6',
  gain: '#5EE08A',
  chrome: '#001D3D',
  chromeEdge: '#003566',
};

const night: HudPalette = {
  ground: '#000000',
  ink: '#E0E3E8',
  inkMuted: '#A9AEB6',
  signFace: '#E6E6E6', // a near-white, dimmer than day's
  signInk: '#000000',
  signRing: '#9E2433',
  minor: '#D99A30',
  moderate: '#E0884F',
  severe: '#EA7A7A',
  haloCalm: '#A9BCD4',
  haloSevere: '#D63A3A',
  haloInk: '#D3D9E2',
  haloInkMuted: '#9AA3B0',
  gain: '#4FBF78',
  chrome: '#00142B',
  chromeEdge: '#002A52',
};

export const HUD = { day, night } as const;

export function hudPalette(isNight: boolean): HudPalette {
  return isNight ? HUD.night : HUD.day;
}

/** The colour of an event tier (minor yellow, moderate orange, severe red). */
export function tierColor(p: HudPalette, tier: Tier): string {
  return p[tier];
}

/** [foreground, background] pairs that must hold ≥ 7:1 in both palettes. */
export const HUD_CONTRAST_PAIRS: readonly (readonly [keyof HudPalette, keyof HudPalette])[] = [
  ['ink', 'ground'],
  ['inkMuted', 'ground'],
  ['signFace', 'ground'],
  ['signInk', 'signFace'],
  ['minor', 'ground'],
  ['moderate', 'ground'],
  ['severe', 'ground'],
  ['gain', 'ground'],
  ['ink', 'chrome'],
  ['ink', 'chromeEdge'],
  ['haloCalm', 'ground'],
  ['haloInk', 'ground'],
  ['haloInkMuted', 'ground'],
];

/** [graphic, background] pairs that must hold ≥ 4.5:1 in both palettes (the halo's red end). */
export const HUD_GRAPHIC_PAIRS: readonly (readonly [keyof HudPalette, keyof HudPalette])[] = [['haloSevere', 'ground']];

/** The palette keys drawn lit on the ground, so the night set must dim each one. */
export const HUD_LIT_KEYS: readonly (keyof HudPalette)[] = [
  'ink',
  'inkMuted',
  'signFace',
  'minor',
  'moderate',
  'severe',
  'gain',
  'haloCalm',
  'haloSevere',
  'haloInk',
  'haloInkMuted',
];

/** HUD touch targets (DESIGN.md: 64 pt in the car). */
export const HUD_MIN_TARGET_PT = 64;
/** The End button and its fill ring (the largest that leaves a 280 pt window two 64 pt side slots). */
export const END_BUTTON_PT = 112;
export const END_RING_PT = 6;
/** Hold-to-end (spec: a 0.5 s ring). */
export const HOLD_TO_END_MS = 500;
/** The screen dims after this long without a touch… */
export const DIM_AFTER_MS = 10_000;
/** …under a black scrim this opaque. */
export const DIM_SCRIM_OPACITY = 0.7;

/** The halo's square box at most, and the smallest box that still draws a ring (else bare numerals). */
export const HALO_MAX_BOX_PT = 420;
export const HALO_MIN_RING_BOX_PT = 220;
/** The largest pulse scale (the burst): the glow is sized so that it still fits its box. */
export const HALO_MAX_SCALE = 1.04;
/** Calm: light goes once around the ring in this long. */
export const HALO_FLOW_MS = 18_000;
/** Dimmed and calm, the halo and the speed show at this strength (above the scrim). */
export const HALO_DIM_OPACITY = 0.45;
/** The speeding display hold lets go this many rows after the engine last reported a tier. */
export const HALO_SPEED_HOLD_MAX_ROWS = 10;
/** The halo's colour ramp: calm, yellow, orange, red at these severities. */
export const HALO_RAMP_STOPS = [0, 0.3, 0.55, 1] as const;
/** A burst: each pulse 400 ms (2.5 a second), opacity down to 0.25, scale up to 1.04. */
export const HALO_BURST = { periodMs: 400, depth: 0.75, scale: 0.04 } as const;

/** Small HUD labels follow Dynamic Type up to 2x and never shrink below their design size. */
export function hudLabelScale(fontScale: number): number {
  if (!Number.isFinite(fontScale)) return 1;
  return Math.min(Math.max(fontScale, 1), 2);
}
