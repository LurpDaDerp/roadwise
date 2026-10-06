import type { Tier } from '@scoring';

/**
 * The driving screen's palette (DESIGN.md "HUD exception"). True black in every light, lit
 * numerals, a round speed-limit sign, and one colour per event tier for the edge glow — yellow,
 * orange, red, as on the drive summary — read peripherally as colour, never as motion. `night` is
 * the same palette dimmed and warmed for eyes adapted to an unlit road, with no pure white.
 *
 * Every foreground/background pair holds at least 7:1 (`HUD_CONTRAST_PAIRS`, measured in
 * `__tests__/hudContrast.test.ts`). Literals only: the HUD's colours are its own.
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
  /** Event tiers: the edge glow, the alert chip, and the speed numerals while speeding. */
  minor: string;
  moderate: string;
  severe: string;
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
  gain: '#5EE08A',
  chrome: '#001D3D',
  chromeEdge: '#003566',
};

const night: HudPalette = {
  ground: '#000000',
  ink: '#E8CDBB',
  inkMuted: '#B79E8F',
  signFace: '#D4B8A6',
  signInk: '#000000',
  signRing: '#9E2433',
  minor: '#D99A30',
  moderate: '#E0884F',
  severe: '#EA7A7A',
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
];

/** The palette keys drawn lit on the ground, so the night set must dim each one. */
export const HUD_LIT_KEYS: readonly (keyof HudPalette)[] = [
  'ink',
  'inkMuted',
  'signFace',
  'minor',
  'moderate',
  'severe',
  'gain',
];

/** Speed numerals: fixed size (never Dynamic Type), sized to the screen's short side. */
export const SPEED_NUMERAL_MIN_PT = 96;
export const SPEED_NUMERAL_MAX_PT = 168;
/** The round limit sign. */
export const SIGN_DIAMETER_PT = 116;
export const SIGN_RING_PT = 11;
export const SIGN_NUMERAL_PT = 50;
/** The edge glow: a solid rim plus a soft inner glow. */
export const GLOW_RIM_PT = 8;
export const GLOW_BLUR_PT = 56;
/** HUD touch targets (DESIGN.md: 64 pt in the car). */
export const HUD_MIN_TARGET_PT = 64;
/** The End button and its fill ring. */
export const END_BUTTON_PT = 96;
export const END_RING_PT = 6;
/** Hold-to-end (spec: a 0.5 s ring). */
export const HOLD_TO_END_MS = 500;
/** The screen dims after this long without a touch… */
export const DIM_AFTER_MS = 10_000;
/** …under a black scrim this opaque. */
export const DIM_SCRIM_OPACITY = 0.7;

/** Speed numerals at a third of the screen's short side, within their bounds. */
export function speedNumeralPt(shortSide: number): number {
  if (!Number.isFinite(shortSide)) return SPEED_NUMERAL_MIN_PT;
  const pt = Math.round(shortSide * 0.34);
  return Math.min(SPEED_NUMERAL_MAX_PT, Math.max(SPEED_NUMERAL_MIN_PT, pt));
}

/** Small HUD labels follow Dynamic Type up to 2x and never shrink below their design size. */
export function hudLabelScale(fontScale: number): number {
  if (!Number.isFinite(fontScale)) return 1;
  return Math.min(Math.max(fontScale, 1), 2);
}
