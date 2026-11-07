import type { PatternId, StyleId } from '@/data/server/wrapped';
import { contrastRatio } from '@/ui';
import { mix, parseColor } from '@/ui/sky/color';

import {
  ARCHETYPE_MIN_CONTRAST,
  archetypeDescription,
  archetypeName,
  archetypePattern,
  archetypeStops,
  CHIP_ALPHA,
  PATTERN_IDS,
  PATTERNS,
  SOFT_INK_ALPHA,
  STYLE_IDS,
  STYLES,
} from '../archetypes';
import { ARCHETYPE_GLYPH } from '../ArchetypeIcon';

const WHITE = '#FFFFFF';

/** CIE L*a*b* of an sRGB colour (D65). */
function lab(hex: string): [number, number, number] {
  const { r, g, b } = parseColor(hex);
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
/** How far apart two colours look (CIE76 ΔE). */
function deltaE(a: string, b: string): number {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

test('every style and pattern the server sends has its words', () => {
  expect(STYLE_IDS.sort()).toEqual(['bumpy', 'easygoing', 'focused', 'jumpy', 'lead_footed', 'phone_happy', 'rising', 'smooth', 'spotless', 'steady']);
  expect(PATTERN_IDS.sort()).toEqual(['city_hopper', 'commuter', 'cruiser', 'early_bird', 'road_tripper', 'weekend_cruiser']);
  expect(Object.keys(ARCHETYPE_GLYPH).sort()).toEqual(PATTERN_IDS.sort());
});

test('one name: the style word, then the pattern word', () => {
  expect(archetypeName({ style: 'spotless', pattern: 'commuter' })).toBe('Spotless Commuter');
  expect(archetypeName({ style: 'lead_footed', pattern: 'road_tripper' })).toBe('Lead-Footed Road Tripper');
  expect(archetypeName({ style: 'phone_happy', pattern: 'weekend_cruiser' })).toBe('Phone-Happy Weekend Cruiser');
  expect(archetypeName({ style: 'easygoing', pattern: 'city_hopper' })).toBe('Easygoing City Hopper');
  expect(archetypeName({ style: 'rising', pattern: 'early_bird' })).toBe('Rising Early Bird');
});

test('the description is the style line, then the pattern line; the coaching ones never scold', () => {
  expect(archetypeDescription({ style: 'lead_footed', pattern: 'commuter' })).toBe(
    'A little heavy on the gas this month. Easing off near the limit is the quickest win. Most of your drives fit around the rush hours.'
  );
  for (const id of STYLE_IDS) {
    expect(STYLES[id].line).not.toMatch(/\b(points?|streak|level|estimate|scoring|bad|fail|terrible|dangerous)\b/i);
    expect(STYLES[id].line).not.toMatch(/’/);
  }
  for (const id of PATTERN_IDS) expect(PATTERNS[id].line.length).toBeGreaterThan(0);
});

test('an id this build does not know reads as Easygoing Cruiser, drawn as the car', () => {
  const odd = { style: 'zany' as StyleId, pattern: 'pilot' as PatternId };
  expect(archetypeName(odd)).toBe('Easygoing Cruiser');
  expect(archetypeStops(odd)).toEqual(STYLES.easygoing.stops);
  expect(archetypePattern(odd)).toBe('cruiser');
});

describe('the colours', () => {
  test('ten distinct gradients, three stops each, darker toward the end', () => {
    // Every pair of first stops (the colour Home's card and the archive show) at least ΔE 20 apart.
    for (const a of STYLE_IDS) {
      for (const b of STYLE_IDS) {
        if (a < b) expect([a, b, deltaE(STYLES[a].stops[0], STYLES[b].stops[0]) >= 20]).toEqual([a, b, true]);
      }
    }
    for (const id of STYLE_IDS) {
      const [a, b, c] = STYLES[id].stops;
      expect(contrastRatio(WHITE, a)).toBeLessThan(contrastRatio(WHITE, b));
      expect(contrastRatio(WHITE, b)).toBeLessThan(contrastRatio(WHITE, c));
    }
  });

  test.each(STYLE_IDS)('%s: white, the softer white and a chip all read at 4.5:1 on every stop', (id) => {
    for (const stop of STYLES[id].stops) {
      expect(contrastRatio(WHITE, stop)).toBeGreaterThanOrEqual(ARCHETYPE_MIN_CONTRAST);
      // White at 80 % over the stop, against the stop.
      expect(contrastRatio(mix(stop, WHITE, SOFT_INK_ALPHA), stop)).toBeGreaterThanOrEqual(ARCHETYPE_MIN_CONTRAST);
      // White text on the chip's ground (white at 14 % over the stop).
      expect(contrastRatio(WHITE, mix(stop, WHITE, CHIP_ALPHA))).toBeGreaterThanOrEqual(ARCHETYPE_MIN_CONTRAST);
    }
  });
});
