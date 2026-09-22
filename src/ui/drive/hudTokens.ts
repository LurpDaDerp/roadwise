import { tokens } from '../tokens';

/**
 * The drive HUD's palette. The HUD is dark in every light: true black ground, lit numerals, a
 * sign-shaped limit badge (spec C3, §13.2, design §5.4). `day` is the M0 HUD set; `night` is the
 * same layout dimmed and red-shifted for the dark adaptation of eyes on an unlit road, with no pure
 * white anywhere. Every foreground/background pair holds at least 7:1 —
 * `__tests__/hudContrast.test.ts` measures each one in `HUD_CONTRAST_PAIRS`.
 */
export type HudPalette = {
  /** Screen ground. True black in both modes (OLED off, no glow in the cabin). */
  ground: '#000000';
  /** Speed numerals, overlay words on the ground. */
  ink: string;
  /** Unit label, indicators, the calm status strip. */
  inkMuted: string;
  /** The limit sign's face and its print (a white regulatory sign, dimmed at night). */
  signFace: string;
  signInk: string;
  /** Speeding numerals and the thick speeding border. */
  speeding: string;
  /** L1 frame, L2 band, the attention status strip. */
  attention: string;
  /** Print on an attention band. */
  attentionInk: string;
  /** L3 panel and the critical status strip. */
  critical: string;
  /** Print on the critical panel. */
  criticalInk: string;
  /** Rubber-stamp ink for the PASSENGER state (the direction contract's stamp, HUD-lit). */
  stamp: string;
};

const day: HudPalette = {
  ground: tokens.color.hud.bg,
  ink: tokens.color.hud.text,
  inkMuted: tokens.color.hud.textMuted,
  signFace: tokens.color.hud.limitFace,
  signInk: tokens.color.hud.limitInk,
  speeding: tokens.color.hud.speedingBorder,
  attention: tokens.color.hud.warnBand,
  attentionInk: '#000000',
  critical: tokens.color.hud.criticalBand,
  criticalInk: '#000000',
  stamp: tokens.color.hud.speedingBorder,
};

const night: HudPalette = {
  ground: '#000000',
  ink: '#E8CDBB', // 13.9:1, 64 % of white's luminance, warm
  inkMuted: '#B79E8F', // 8.3:1
  signFace: '#D4B8A6', // 11.2:1 against its black print
  signInk: '#000000',
  speeding: '#F06AA8', // 7.3:1
  attention: '#D99A30', // 8.6:1
  attentionInk: '#000000',
  critical: '#F06AA8', // 7.3:1, and 7.3:1 for its black print
  criticalInk: '#000000',
  stamp: '#F06AA8',
};

export const HUD = { day, night } as const;

export function hudPalette(night: boolean): HudPalette {
  return night ? HUD.night : HUD.day;
}

/** [foreground, background] pairs that must hold ≥ 7:1 in both palettes. */
export const HUD_CONTRAST_PAIRS: readonly (readonly [keyof HudPalette, keyof HudPalette])[] = [
  ['ink', 'ground'],
  ['inkMuted', 'ground'],
  ['signFace', 'ground'],
  ['signInk', 'signFace'],
  ['speeding', 'ground'],
  ['attention', 'ground'],
  ['attentionInk', 'attention'],
  ['critical', 'ground'],
  ['criticalInk', 'critical'],
  ['stamp', 'ground'],
];

/**
 * Speed numerals. Fixed, never scaled by Dynamic Type — they are already far above any text size
 * the system offers, and a scaled 3-digit speed would clip in portrait. 104 pt keeps "105" plus
 * the limit sign side by side on a 390 pt-wide phone.
 */
export const SPEED_NUMERAL_PT = 104;
/** The limit sign's numeral: a sign graphic, so it holds its size like the speed does. */
export const SIGN_NUMERAL_PT = 52;
/** Overlay words: body text at the 200 % Dynamic Type cap (17 × 2), so they never need to scale. */
export const OVERLAY_WORDS_PT = 34;
export const OVERLAY_WORDS_CRITICAL_PT = 44;
/** HUD touch targets (spec 7.0). */
export const HUD_MIN_TARGET_PT = 64;

/** Small HUD labels follow Dynamic Type up to 2x and never shrink below their design size. */
export function hudLabelScale(fontScale: number): number {
  if (!Number.isFinite(fontScale)) return 1;
  return Math.min(Math.max(fontScale, 1), 2);
}
