import type { TextStyle } from 'react-native';

import { fontFamilies } from './fonts';

/**
 * Navy and gold: ink-black and prussian-blue grounds with regal-navy raised faces, school-bus
 * yellow on every control and gold for stamps and highlights. Light mode is the same palette on a
 * pale navy-tinted ground, with navy controls and a darkened gold wherever gold has to be read.
 *
 * Every value here is measured, not eyeballed — `src/ui/__tests__/tokens.test.ts` holds the floor.
 */

export type ColorSet = {
  bg: string;
  bgElevated: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  /** A rule that has to read as an edge on `bg`, not just a hint on a card face. */
  borderStrong: string;
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
  /** Laminate sheen, navy to yellow to gold. Card faces only. */
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
  /** Omitted when `fontFamily` already names a weighted face, so Android cannot synthesise a second bold. */
  fontWeight?: '400' | '500' | '600' | '700' | '800';
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
  bg: '#EEF3F9',
  bgElevated: '#F6F9FC',
  surface: '#FFFFFF',
  surfaceRaised: '#EDF2F8',
  border: '#C6D3E2',
  borderStrong: '#5E7690',
  divider: '#DCE5EF',
  text: '#001D3D',
  textMuted: '#3D5470',
  textSubtle: '#566B84',
  textInverse: '#FFFFFF',
  accent: '#003566',
  accentText: '#FFD60A',
  accentFaint: '#E3ECF6',
  danger: '#B3202F',
  dangerFaint: '#FBE8EA',
  warning: '#A34E00',
  warningFaint: '#FCEEDC',
  success: '#0B6E5A',
  successFaint: '#E0F2EE',
  info: '#1B5E8C',
  infoFaint: '#E2EEF7',
  scrim: 'rgba(0, 8, 20, 0.55)',
  stamp: '#7A5C00',
  stampFaint: '#FFF4CC',
  sheen: ['#CFDCEB', '#FFD60A', '#FFC300'],
};

const dark: ColorSet = {
  bg: '#000814',
  bgElevated: '#001D3D',
  surface: '#001D3D',
  surfaceRaised: '#003566',
  border: '#1C4370',
  borderStrong: '#6F88A5',
  divider: '#0E2F55',
  text: '#E8EFF7',
  textMuted: '#9DB0C6',
  textSubtle: '#7F93AC',
  textInverse: '#000814',
  accent: '#FFC300',
  accentText: '#000814',
  accentFaint: '#2A2608',
  danger: '#FF8A8A',
  dangerFaint: '#3A1522',
  warning: '#FF9F43',
  warningFaint: '#3A2410',
  success: '#4FD1B0',
  successFaint: '#08332F',
  info: '#7CC0F5',
  infoFaint: '#0A2E4F',
  scrim: 'rgba(0, 4, 10, 0.7)',
  stamp: '#FFD60A',
  stampFaint: '#332B05',
  sheen: ['#003566', '#FFC300', '#FFD60A'],
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
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
  },
  title1: { fontFamily: fontFamilies.fieldBold, fontSize: 28, lineHeight: 34 },
  title2: { fontFamily: fontFamilies.fieldBold, fontSize: 22, lineHeight: 28 },
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
