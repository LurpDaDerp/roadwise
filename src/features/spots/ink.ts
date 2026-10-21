/**
 * The spot ink: one magenta used only for problem spots (their road on the All trips map, their
 * pins and the card's discs), never a tier or health colour, and always with the kind's icon and
 * words. The All trips map's tiles follow the app's scheme, so the ink does too.
 *
 * Contrast (`__tests__/ink.test.ts`): the line is at least 3:1 on the light tiles (#F9F5ED 4.90,
 * white 5.33) and the dark ones (#242424 6.02, #2B2B2B 5.49); the icon on it at least 4.5:1 (white
 * on #C81E7D 5.33, #111113 on #FF6EB4 7.31); the disc at least 3:1 on the card (white 5.33, #161618
 * 7.01). Its hue (326° / 331°) sits well away from every phase, weather and static accent the
 * heat lines take.
 */
export const SPOT_INK = {
  light: { line: '#C81E7D', onLine: '#FFFFFF', casing: '#FFFFFF', pinEdge: '#FFFFFF' },
  dark: { line: '#FF6EB4', onLine: '#111113', casing: '#111113', pinEdge: '#FFFFFF' },
} as const;

export type SpotInk = (typeof SPOT_INK)[keyof typeof SPOT_INK];

export const spotInk = (scheme: 'light' | 'dark'): SpotInk => SPOT_INK[scheme];
