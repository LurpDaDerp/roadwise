import type { TextStyle } from 'react-native';

import { fontFamilies } from './fonts';

/**
 * "The License Card": the app is the licence a new driver is proud of. Card-white faces on a cool
 * desk grey, ink navy print, ID blue on every control, rubber-stamp magenta for states, and a
 * laminate sheen that only ever sits on a card face. Dark mode is the same card under blacklight.
 *
 * Every value here is measured, not eyeballed — `src/ui/__tests__/tokens.test.ts` holds the floor.
 */

export type ColorSet = {
  bg: string;
  bgElevated: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  divider: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  textInverse: string;
  accent: string;
  accentText: string;
  accentFaint: string;
  danger: string;
  dangerFaint: string;
  warning: string;
  warningFaint: string;
  success: string;
  successFaint: string;
  info: string;
  infoFaint: string;
  scrim: string;
  /** Rubber-stamp ink for states: PROVISIONAL, SAFE DAY, PASSENGER, DISPUTED. */
  stamp: string;
  stampFaint: string;
  /** Laminate sheen, teal to lilac to pink. Card faces only. */
  sheen: [string, string, string];
};

export type HudSet = {
  bg: '#000000';
  text: string;
  textMuted: string;
  limitFace: string;
  limitInk: string;
  speedingBorder: string;
  warnBand: string;
  criticalBand: string;
};

type TypeStyle = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: '400' | '500' | '600' | '700' | '800';
  letterSpacing?: number;
  fontVariant?: TextStyle['fontVariant'];
};

export type TypeScale = Record<
  | 'display'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'body'
  | 'callout'
  | 'subhead'
  | 'footnote'
  | 'caption',
  TypeStyle
>;

const light: ColorSet = {
  bg: '#EEF1F5',
  bgElevated: '#F7F9FC',
  surface: '#FFFFFF',
  surfaceRaised: '#F2F5FA',
  border: '#C9D3E2',
  divider: '#DFE6F0',
  text: '#14213D',
  textMuted: '#4A5878',
  textSubtle: '#5A6684',
  textInverse: '#FFFFFF',
  accent: '#1C3F94',
  accentText: '#FFFFFF',
  accentFaint: '#E7ECF8',
  danger: '#B01B2E',
  dangerFaint: '#FBE9EB',
  warning: '#9A6400',
  warningFaint: '#FBF1DF',
  success: '#0F6B47',
  successFaint: '#E4F2EB',
  info: '#10707A',
  infoFaint: '#E2F1F2',
  scrim: 'rgba(20, 33, 61, 0.55)',
  stamp: '#C81870',
  stampFaint: '#FAE7F0',
  sheen: ['#58C7C0', '#C9B8F0', '#F6C1E7'],
};

const dark: ColorSet = {
  bg: '#0B1230',
  bgElevated: '#101740',
  surface: '#141C40',
  surfaceRaised: '#1D2757',
  border: '#2C3768',
  divider: '#222C58',
  text: '#E8EEFF',
  textMuted: '#A9B8E0',
  textSubtle: '#8494C2',
  textInverse: '#0B1230',
  accent: '#8FB4FF',
  accentText: '#0B1230',
  accentFaint: '#182253',
  danger: '#FF8A9E',
  dangerFaint: '#3B1526',
  warning: '#FFC24D',
  warningFaint: '#3A2A10',
  success: '#5FD6A4',
  successFaint: '#10331F',
  info: '#6FD8D2',
  infoFaint: '#0F3136',
  scrim: 'rgba(3, 6, 20, 0.65)',
  stamp: '#FF4FA3',
  stampFaint: '#3A132B',
  sheen: ['#58C7C0', '#C9B8F0', '#F6C1E7'],
};

const hud: HudSet = {
  bg: '#000000',
  text: '#FFFFFF',
  textMuted: '#B8C4E6',
  limitFace: '#FFFFFF',
  limitInk: '#000000',
  speedingBorder: '#FF6BB3',
  warnBand: '#FFC24D',
  criticalBand: '#FF6BB3',
};

const type: TypeScale = {
  display: {
    fontFamily: fontFamilies.numeralsBold,
    fontSize: 40,
    lineHeight: 46,
    fontWeight: '700',
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
  },
  title1: { fontFamily: fontFamilies.fieldBold, fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title2: { fontFamily: fontFamilies.fieldBold, fontSize: 22, lineHeight: 28, fontWeight: '700' },
  title3: { fontFamily: fontFamilies.ui, fontSize: 20, lineHeight: 25, fontWeight: '600' },
  headline: { fontFamily: fontFamilies.ui, fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontFamily: fontFamilies.ui, fontSize: 17, lineHeight: 22, fontWeight: '400' },
  callout: { fontFamily: fontFamilies.ui, fontSize: 16, lineHeight: 21, fontWeight: '400' },
  subhead: { fontFamily: fontFamilies.ui, fontSize: 15, lineHeight: 20, fontWeight: '400' },
  footnote: { fontFamily: fontFamilies.ui, fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontFamily: fontFamilies.ui, fontSize: 12, lineHeight: 16, fontWeight: '400' },
};

export const tokens = {
  color: { light, dark, hud },
  type,
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 },
  radius: { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 },
  motion: { fast: 150, base: 250, slow: 300, springDamping: 18, springStiffness: 180 },
} as const;
