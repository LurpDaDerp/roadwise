/**
 * The drive HUD's palette (the mounted in-drive screen). The HUD is dark in every light: an
 * ink-black ground (`#000814`, near enough to black that an OLED still spends nothing on it), lit
 * numerals, a white regulatory sign for the limit, and one halo colour for the driving status —
 * calm teal, attention yellow, critical soft red — read peripherally as colour, never as motion.
 * `night` is the same palette dimmed and warmed for eyes adapted to an unlit road, with no pure
 * white anywhere. Every foreground/background pair holds at least 7:1 —
 * `__tests__/hudContrast.test.ts` measures each one in `HUD_CONTRAST_PAIRS`.
 *
 * Literals only: the HUD's colours are its own, not the app's card palette.
 */

/** The halo's state, and with it the numerals' colour: calm, attention, critical. */
export type HaloLevel = 'calm' | 'attention' | 'critical';

export type HudPalette = {
  /** Screen ground: ink-black, both modes. */
  ground: string;
  /** Speed numerals, the hazard words, print on the chrome. */
  ink: string;
  /** Unit label, the trip timer, quiet chrome print. */
  inkMuted: string;
  /** The limit sign's face and its print (a white regulatory sign, dimmed at night). */
  signFace: string;
  signInk: string;
  /** The halo while all is well; never on text. */
  calm: string;
  /** The halo, the numerals and the banner when something needs a glance. */
  attention: string;
  /** Print on an attention banner. */
  attentionInk: string;
  /** The halo, the numerals and the banner for an urgent state. */
  critical: string;
  /** Print on a critical banner. */
  criticalInk: string;
  /** Secondary chrome: the hazard bar's face and the End button. */
  chrome: string;
  chromeEdge: string;
  /** The SOS button's face and print. */
  sos: string;
  sosInk: string;
};

const day: HudPalette = {
  ground: '#000814', // ink-black
  ink: '#F3F6FB', // 18.6:1
  inkMuted: '#A9BAD6', // 10.2:1
  signFace: '#FFFFFF',
  signInk: '#000814', // 20.1:1 on the face
  calm: '#2EC4B6', // teal, 9.3:1
  attention: '#FFC300', // school-bus yellow, 12.5:1
  attentionInk: '#000814',
  critical: '#FF7070', // soft red, 7.5:1
  criticalInk: '#000814',
  chrome: '#001D3D', // prussian blue
  chromeEdge: '#003566', // regal navy
  sos: '#FF7070',
  sosInk: '#000814',
};

const night: HudPalette = {
  ground: '#000814',
  ink: '#E8CDBB', // 13.3:1, warm
  inkMuted: '#B79E8F', // 7.9:1
  signFace: '#D4B8A6', // 10.7:1 against its print
  signInk: '#000814',
  calm: '#2BB3A6', // 7.8:1
  attention: '#D99A30', // 8.3:1
  attentionInk: '#000814',
  critical: '#EA7A7A', // 7.2:1
  criticalInk: '#000814',
  chrome: '#00142B',
  chromeEdge: '#002A52',
  sos: '#EA7A7A',
  sosInk: '#000814',
};

export const HUD = { day, night } as const;

export function hudPalette(night: boolean): HudPalette {
  return night ? HUD.night : HUD.day;
}

/** The halo's colour for a level; the numerals and the banner take the same one. */
export function haloColor(p: HudPalette, level: HaloLevel): string {
  return level === 'critical' ? p.critical : level === 'attention' ? p.attention : p.calm;
}

/** [foreground, background] pairs that must hold ≥ 7:1 in both palettes. */
export const HUD_CONTRAST_PAIRS: readonly (readonly [keyof HudPalette, keyof HudPalette])[] = [
  ['ink', 'ground'],
  ['inkMuted', 'ground'],
  ['signFace', 'ground'],
  ['signInk', 'signFace'],
  ['calm', 'ground'],
  ['attention', 'ground'],
  ['attentionInk', 'attention'],
  ['critical', 'ground'],
  ['criticalInk', 'critical'],
  ['sos', 'ground'],
  ['sosInk', 'sos'],
  ['ink', 'chrome'],
  ['ink', 'chromeEdge'],
  ['attention', 'chrome'],
];

/** The palette keys that are lit (drawn on the ground), so the night set must dim each one. */
export const HUD_LIT_KEYS: readonly (keyof HudPalette)[] = [
  'ink',
  'inkMuted',
  'signFace',
  'calm',
  'attention',
  'critical',
  'sos',
];

/**
 * Speed numerals. Fixed, never scaled by Dynamic Type — they are already far above any text size
 * the system offers. The halo sizes them to its own diameter (`speedNumeralPt`), between the two
 * bounds; `SPEED_NUMERAL_PT` is the readout's size on its own.
 */
export const SPEED_NUMERAL_PT = 104;
export const SPEED_NUMERAL_MIN_PT = 72;
export const SPEED_NUMERAL_MAX_PT = 120;
/** The limit sign's numeral: a sign graphic, so it holds its size like the speed does. */
export const SIGN_NUMERAL_PT = 52;
/** The limit sign's face: the US regulatory sign's 4:5 (MUTCD R2-1, 24 × 30 in). */
export const SIGN_WIDTH_PT = 96;
export const SIGN_HEIGHT_PT = 120;
/** The halo ring. */
export const HALO_STROKE_PT = 10;
export const HALO_MIN_PT = 180;
export const HALO_MAX_PT = 320;
/** HUD touch targets (spec 7.0). */
export const HUD_MIN_TARGET_PT = 64;
/** A hold this long acts (SOS, End): long enough that a knock or a grab never counts. */
export const HOLD_TO_ACT_MS = 2000;

/** Speed numerals at 40 % of the halo's diameter: "105" still sits inside the ring's chord. */
export function speedNumeralPt(haloSize: number): number {
  const pt = Math.round(haloSize * 0.4);
  return Math.min(SPEED_NUMERAL_MAX_PT, Math.max(SPEED_NUMERAL_MIN_PT, pt));
}

/**
 * The halo's diameter for the room the centre zone has: in portrait the sign sits under the ring,
 * in landscape beside it, and the ring takes what is left within its bounds.
 */
export function haloSize(availW: number, availH: number, landscape: boolean): number {
  const gap = 16;
  const fit = landscape
    ? Math.min(availW - SIGN_WIDTH_PT - gap, availH)
    : Math.min(availW, availH - SIGN_HEIGHT_PT - gap);
  if (!Number.isFinite(fit)) return HALO_MIN_PT;
  return Math.round(Math.min(HALO_MAX_PT, Math.max(HALO_MIN_PT, fit)));
}

/** Small HUD labels follow Dynamic Type up to 2x and never shrink below their design size. */
export function hudLabelScale(fontScale: number): number {
  if (!Number.isFinite(fontScale)) return 1;
  return Math.min(Math.max(fontScale, 1), 2);
}
