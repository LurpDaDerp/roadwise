/**
 * The monthly Wrapped's archetype (pure): ONE name, a style word and a pattern word
 * ("Spotless Commuter", "Lead-Footed Road Tripper"), worked out by the server from the month
 * (`private.wrapped_archetype`) and sent as ids. Each style has its own colours (the story's
 * gradient, Home's card wash, the archive's discs); each pattern has its own icon (`ArchetypeIcon`).
 * Warm, darker reds, ambers and greys for the styles that coach; cooler greens, blues and violets for
 * the ones that celebrate. White text reads at 4.5:1 or better on every stop, and so do the story's
 * softer white and the "Better than" chips (`src/features/wrapped/__tests__/archetypes.test.ts`).
 */
import type { Archetype, PatternId, StyleId } from '@/data/server/wrapped';

export interface StyleInfo {
  /** The style word. */
  word: string;
  /** One line about the month: warm when it went well, gentle and coaching when it didn't. */
  line: string;
  /** The gradient, top-left to bottom-right: three stops, darker each time. */
  stops: readonly [string, string, string];
}

export interface PatternInfo {
  word: string;
  line: string;
}

export const STYLES: Readonly<Record<StyleId, StyleInfo>> = {
  lead_footed: {
    word: 'Lead-Footed',
    line: 'A little heavy on the gas this month. Easing off near the limit is the quickest win.',
    stops: ['#A3231B', '#6E1420', '#3A0A13'],
  },
  jumpy: {
    word: 'Jumpy',
    line: 'Some sudden stops, starts and turns this month. A little more space ahead smooths them out.',
    stops: ['#8F4407', '#6B2A0F', '#3A1406'],
  },
  phone_happy: {
    word: 'Phone-Happy',
    line: 'Your phone came out a fair bit on the road. Setting it aside before you pull away makes it easy.',
    stops: ['#9C1A7A', '#66114F', '#330828'],
  },
  bumpy: {
    word: 'Bumpy',
    line: 'A bumpy month on the road. One calm, clean drive at a time adds up fast.',
    stops: ['#56524D', '#383431', '#1C1A18'],
  },
  rising: {
    word: 'Rising',
    line: "Your Safety Rating climbed this month. Whatever you changed, it's working.",
    stops: ['#6A26CC', '#47198A', '#23104C'],
  },
  spotless: {
    word: 'Spotless',
    line: "Clean drive after clean drive. It doesn't get much better than that.",
    stops: ['#17692A', '#105420', '#072A10'],
  },
  steady: {
    word: 'Steady',
    line: 'You kept to the limits all month. Calm and steady.',
    stops: ['#00639A', '#0A466E', '#04233A'],
  },
  smooth: {
    word: 'Smooth',
    line: 'Gentle stops, easy starts and smooth turns. Your passengers noticed.',
    stops: ['#00676A', '#04504F', '#022B2B'],
  },
  focused: {
    word: 'Focused',
    line: 'Your phone stayed put while you drove. Eyes on the road all month.',
    stops: ['#2E40C4', '#222D80', '#121845'],
  },
  easygoing: {
    word: 'Easygoing',
    line: 'A relaxed month of everyday driving.',
    stops: ['#665A00', '#4A4100', '#262100'],
  },
};

export const PATTERNS: Readonly<Record<PatternId, PatternInfo>> = {
  road_tripper: { word: 'Road Tripper', line: 'You went the distance, with long drives that covered real ground.' },
  commuter: { word: 'Commuter', line: 'Most of your drives fit around the rush hours.' },
  early_bird: { word: 'Early Bird', line: 'You were often on the road before 9 AM.' },
  weekend_cruiser: { word: 'Weekend Cruiser', line: 'Weekends were your time to drive.' },
  city_hopper: { word: 'City Hopper', line: 'Lots of short hops around town.' },
  cruiser: { word: 'Cruiser', line: 'A good mix of drives, whenever the day called for one.' },
};

export const STYLE_IDS = Object.keys(STYLES) as StyleId[];
export const PATTERN_IDS = Object.keys(PATTERNS) as PatternId[];

/** The story's softer white (labels, the line under a number): white at this opacity. */
export const SOFT_INK_ALPHA = 0.8;
/** A "Better than" chip's ground: white at this opacity over the gradient. */
export const CHIP_ALPHA = 0.14;
/** The minimum contrast of any text on the gradient. */
export const ARCHETYPE_MIN_CONTRAST = 4.5;

const styleOf = (a: Archetype): StyleInfo => STYLES[a.style] ?? STYLES.easygoing;
const patternOf = (a: Archetype): PatternInfo => PATTERNS[a.pattern] ?? PATTERNS.cruiser;

/** "Spotless Commuter". An id this build doesn't know reads as Easygoing or Cruiser. */
export function archetypeName(a: Archetype): string {
  return `${styleOf(a).word} ${patternOf(a).word}`;
}

/** The style's line, then the pattern's. */
export function archetypeDescription(a: Archetype): string {
  return `${styleOf(a).line} ${patternOf(a).line}`;
}

export function archetypeStops(a: Archetype): readonly [string, string, string] {
  return styleOf(a).stops;
}

/** The pattern id to draw (an unknown one draws the Cruiser's car). */
export function archetypePattern(a: Archetype): PatternId {
  return a.pattern in PATTERNS ? a.pattern : 'cruiser';
}
