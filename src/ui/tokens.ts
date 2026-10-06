import type { TextStyle } from 'react-native';

import { fontFamilies } from './fonts';

/**
 * RoadWise v3 tokens: navy and gold, played loud.
 *
 * The ground is the repo's navy (ink-black #000814, prussian #001D3D, regal #003566) and gold
 * (#FFC300 / #FFD60A) is the one colour that means "go": the primary action, the streak flame,
 * the gold league tier. Around it sit two families of signal colour that always arrive with a
 * glyph or a word, never alone:
 *
 * - `signal` — event severity and stat health: clean (green) · minor (yellow) · moderate (orange)
 *   · severe (red). Each has a `fill` for large areas with its own `onFill` ink, a `text` variant
 *   that clears 4.5:1 on `bg`, `surface` and `surfaceRaised` (use it for small marks too: dots,
 *   arrows, ring strokes), and a `faint` wash its `text` also reads on.
 * - `tier` — weekly league tiers Bronze → Silver → Gold → Platinum → Diamond: a two-stop `face`
 *   for the badge, `ink` for the glyph on that face, `text` for the tier name on a card.
 *
 * Every value is measured, not eyeballed: `src/ui/__tests__/tokens.test.ts` holds the floor.
 */

export type Signal = 'clean' | 'minor' | 'moderate' | 'severe';
export type LeagueTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
/** Stat health per the spec's threshold table; same strings as the scoring package's `statColor`. */
export type StatHealth = 'green' | 'yellow' | 'red';

export type SignalColors = {
  /** Large areas: chip fills, map segments, bar fills. Pair with `onFill`. */
  fill: string;
  onFill: string;
  /** Text and small marks on bg / surface / surfaceRaised / faint (≥ 4.5:1). */
  text: string;
  /** Tinted wash behind a pill or banner. */
  faint: string;
};

export type TierColors = {
  /** Badge gradient, top-left → bottom-right. */
  face: [string, string];
  /** Glyph drawn on the face. */
  ink: string;
  /** The tier's name on a card (≥ 4.5:1 on bg / surface). */
  text: string;
};

export type ColorSet = {
  bg: string;
  bgElevated: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  /** A rule that has to read as an edge on `bg` (≥ 3:1), not just a hint on a card face. */
  borderStrong: string;
  divider: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  textInverse: string;
  /** Interactive tint for links, icons, selected states: navy in light, gold in dark. */
  accent: string;
  /** Text on an `accent` fill. */
  accentText: string;
  accentFaint: string;
  /** The gold primary action, in both schemes. */
  primary: string;
  primaryPressed: string;
  onPrimary: string;
  /** Brand gold as a highlight (flame, gold tier, sparkle). Not for small text in light mode. */
  gold: string;
  danger: string;
  dangerFaint: string;
  warning: string;
  warningFaint: string;
  success: string;
  successFaint: string;
  info: string;
  infoFaint: string;
  scrim: string;
  signal: Record<Signal, SignalColors>;
  tier: Record<LeagueTier, TierColors>;
  /** Deterministic avatar backgrounds; all carry `avatarInk` at ≥ 4.5:1. */
  avatar: readonly string[];
  avatarInk: string;
  /** Ice blue for streak freezes. Text-safe on bg / surface. */
  freeze: string;
  /** @deprecated v2 licence stamp ink. Use `gold` / `accent`; kept so older screens compile. */
  stamp: string;
  /** @deprecated v2 licence stamp wash. */
  stampFaint: string;
  /** @deprecated v2 laminate sheen. Not used by v3 primitives. */
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

export type TypeStyle = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** Omitted when `fontFamily` already names a weighted face, so Android cannot synthesise a second bold. */
  fontWeight?: '400' | '500' | '600' | '700' | '800';
  letterSpacing?: number;
  fontVariant?: TextStyle['fontVariant'];
  textTransform?: TextStyle['textTransform'];
  /** Dynamic Type cap for this style (default 2×). Big numerals stop earlier so they fit a phone. */
  maxScale?: number;
};

export type TypeVariant =
  | 'hero'
  | 'display'
  | 'stat'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'body'
  | 'callout'
  | 'subhead'
  | 'footnote'
  | 'caption'
  | 'label';

export type TypeScale = Record<TypeVariant, TypeStyle>;

export type Elevation = {
  /** Resting card. `undefined` in dark, where depth comes from the raised surface and a border. */
  card: string | undefined;
  /** Something lifted above the page: a pressed-up tile, a toast. */
  raised: string | undefined;
  /** Sheets and overlays. */
  overlay: string | undefined;
};

const light: ColorSet = {
  bg: '#EEF3F9',
  bgElevated: '#F6F9FC',
  surface: '#FFFFFF',
  surfaceRaised: '#E4ECF5',
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
  primary: '#FFC300',
  primaryPressed: '#F0B400',
  onPrimary: '#001D3D',
  gold: '#FFC300',
  danger: '#C21F33',
  dangerFaint: '#FDE4E7',
  warning: '#B04A00',
  warningFaint: '#FFEBDB',
  success: '#0A7A43',
  successFaint: '#E3F6EC',
  info: '#1B5E8C',
  infoFaint: '#E2EEF7',
  scrim: 'rgba(0, 8, 20, 0.55)',
  signal: {
    clean: { fill: '#14A35A', onFill: '#001D3D', text: '#0A7A43', faint: '#E3F6EC' },
    minor: { fill: '#F5CF00', onFill: '#001D3D', text: '#7A6300', faint: '#FFF6CC' },
    moderate: { fill: '#F07400', onFill: '#001D3D', text: '#B04A00', faint: '#FFEBDB' },
    severe: { fill: '#E0283F', onFill: '#FFFFFF', text: '#C21F33', faint: '#FDE4E7' },
  },
  tier: {
    bronze: { face: ['#D9844A', '#A85A24'], ink: '#2B1400', text: '#9A4F1C' },
    silver: { face: ['#D5DDE6', '#97A5B6'], ink: '#1B2735', text: '#56657A' },
    gold: { face: ['#FFCB1F', '#D99A00'], ink: '#2E2100', text: '#7A5A00' },
    platinum: { face: ['#5FE3D2', '#1FA595'], ink: '#00302B', text: '#0B7366' },
    diamond: { face: ['#A9C6FF', '#7B86FF'], ink: '#0B1550', text: '#4A4BD0' },
  },
  avatar: ['#FFC300', '#4FD1C5', '#7FB2FF', '#B79CFF', '#FF8FA3', '#FF9F43', '#5EE08A', '#A9BCD2'],
  avatarInk: '#001D3D',
  freeze: '#1B6FB0',
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
  text: '#F2F6FB',
  textMuted: '#A9BCD2',
  textSubtle: '#8FA4BD',
  textInverse: '#000814',
  accent: '#FFC300',
  accentText: '#000814',
  accentFaint: '#2A2608',
  primary: '#FFC300',
  primaryPressed: '#E6AF00',
  onPrimary: '#000814',
  gold: '#FFC300',
  danger: '#FF7A8A',
  dangerFaint: '#3A1222',
  warning: '#FF9A45',
  warningFaint: '#3A2210',
  success: '#4BE08F',
  successFaint: '#0B3326',
  info: '#7CC0F5',
  infoFaint: '#0A2E4F',
  scrim: 'rgba(0, 4, 10, 0.7)',
  signal: {
    clean: { fill: '#2FD67B', onFill: '#000814', text: '#4BE08F', faint: '#0B3326' },
    minor: { fill: '#FFE14A', onFill: '#000814', text: '#FFE14A', faint: '#332E08' },
    moderate: { fill: '#FF8C2E', onFill: '#000814', text: '#FF9A45', faint: '#3A2210' },
    severe: { fill: '#FF5468', onFill: '#000814', text: '#FF7A8A', faint: '#3A1222' },
  },
  tier: {
    bronze: { face: ['#D9844A', '#A85A24'], ink: '#2B1400', text: '#F0A06A' },
    silver: { face: ['#D5DDE6', '#97A5B6'], ink: '#1B2735', text: '#C9D3DE' },
    gold: { face: ['#FFCB1F', '#D99A00'], ink: '#2E2100', text: '#FFC300' },
    platinum: { face: ['#5FE3D2', '#1FA595'], ink: '#00302B', text: '#6FE6D6' },
    diamond: { face: ['#A9C6FF', '#7B86FF'], ink: '#0B1550', text: '#A9C2FF' },
  },
  avatar: ['#FFC300', '#4FD1C5', '#7FB2FF', '#B79CFF', '#FF8FA3', '#FF9F43', '#5EE08A', '#A9BCD2'],
  avatarInk: '#001D3D',
  freeze: '#8FD3FF',
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

const TAB: TextStyle['fontVariant'] = ['tabular-nums'];

/**
 * Two voices. Barlow Semi Condensed (drawn from US highway signage) carries every number and every
 * headline: heavy, a little narrow, sporty. The platform face carries reading text and controls.
 * `hero` is the one italic: the big earned number on the summary and the Safety Rating on Home.
 */
const type: TypeScale = {
  hero: {
    fontFamily: fontFamilies.displayItalic,
    fontSize: 64,
    lineHeight: 68,
    letterSpacing: -1,
    fontVariant: TAB,
    maxScale: 1.3,
  },
  display: {
    fontFamily: fontFamilies.display,
    fontSize: 44,
    lineHeight: 48,
    letterSpacing: -0.5,
    fontVariant: TAB,
    maxScale: 1.3,
  },
  stat: {
    fontFamily: fontFamilies.display,
    fontSize: 28,
    lineHeight: 32,
    fontVariant: TAB,
    maxScale: 1.5,
  },
  title1: { fontFamily: fontFamilies.headline, fontSize: 30, lineHeight: 34 },
  title2: { fontFamily: fontFamilies.headline, fontSize: 24, lineHeight: 28 },
  title3: { fontFamily: fontFamilies.headline, fontSize: 20, lineHeight: 24 },
  headline: { fontFamily: fontFamilies.ui, fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontFamily: fontFamilies.ui, fontSize: 17, lineHeight: 22, fontWeight: '400' },
  callout: { fontFamily: fontFamilies.ui, fontSize: 16, lineHeight: 21, fontWeight: '400' },
  subhead: { fontFamily: fontFamilies.ui, fontSize: 15, lineHeight: 20, fontWeight: '400' },
  footnote: { fontFamily: fontFamilies.ui, fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontFamily: fontFamilies.ui, fontSize: 12, lineHeight: 16, fontWeight: '400' },
  /** Stat and chip labels: condensed caps, under or beside a number. Never an eyebrow over a heading. */
  label: {
    fontFamily: fontFamilies.label,
    fontSize: 14,
    lineHeight: 18,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
};

const elevation: Record<'light' | 'dark', Elevation> = {
  light: {
    card: '0px 1px 2px rgba(0, 29, 61, 0.06), 0px 4px 14px rgba(0, 29, 61, 0.07)',
    raised: '0px 6px 20px rgba(0, 29, 61, 0.14)',
    overlay: '0px -6px 28px rgba(0, 8, 20, 0.18)',
  },
  dark: { card: undefined, raised: '0px 6px 20px rgba(0, 0, 0, 0.45)', overlay: undefined },
};

export const tokens = {
  color: { light, dark, hud },
  type,
  elevation,
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 },
  radius: { sm: 8, md: 12, lg: 16, card: 20, xl: 24, pill: 999 },
  /** Hit targets and icon sizes. 44 is the floor for anything tappable. */
  size: { touch: 44, touchLg: 56, hud: 64, iconSm: 16, icon: 20, iconLg: 28 },
  motion: {
    /** Press feedback. */
    fast: 150,
    /** Routine state change: chip toggle, segment slide. */
    base: 250,
    /** Layout and overlays: sheet rise, breakdown expand. */
    slow: 400,
    /** A count-up from zero to the earned number. */
    countUp: 900,
    /** The green "gained" pulse. */
    pulse: 320,
    /** The single red "lost" shake: total duration and peak offset in pt. */
    shake: 360,
    shakeDistance: 8,
    /** @deprecated use `spring.snappy`. */
    springDamping: 18,
    /** @deprecated use `spring.snappy`. */
    springStiffness: 180,
    spring: {
      /** Controls: segment indicator, toggles. No overshoot you'd notice. */
      snappy: { damping: 20, stiffness: 260, mass: 1 },
      /** Rewards: a badge or flame popping in. One small overshoot. */
      bouncy: { damping: 12, stiffness: 200, mass: 1 },
      /** Sheets and large surfaces. */
      gentle: { damping: 24, stiffness: 160, mass: 1 },
    },
  },
} as const;
