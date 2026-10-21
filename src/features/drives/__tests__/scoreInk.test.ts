import { contrastRatio, mix } from '@/ui';
import { parseColor } from '@/ui/sky/color';
import { plainBundle } from '@/ui/sky/palette';

import { SCORE_INK_MIN_CONTRAST, scoreInk } from '../scoreInk';

const SCHEMES = ['light', 'dark'] as const;
const scores = Array.from({ length: 101 }, (_, i) => i);

describe.each(SCHEMES)('%s', (scheme) => {
  const c = plainBundle(scheme).colors;
  const ink = (s: number) => scoreInk(s, c, c.surface);

  test('every score from 0 to 100 reads at 4.5:1 on the card', () => {
    expect(SCORE_INK_MIN_CONTRAST).toBe(4.5);
    for (const s of scores) expect(contrastRatio(ink(s), c.surface)).toBeGreaterThanOrEqual(4.5);
  });

  test("the theme's red at 60 and under, amber at 80, its green at 100", () => {
    for (const s of [0, 30, 60, -5, Number.NaN]) expect(ink(s)).toBe(c.signal.severe.text);
    expect(ink(100)).toBe(c.signal.clean.text);
    expect(ink(140)).toBe(c.signal.clean.text);
    expect(ink(80)).toBe(mix(c.signal.minor.text, c.signal.moderate.text, 0.5));
  });

  test('on the way it stays warm to green, never blue or grey', () => {
    for (const s of scores) {
      const { r, g, b } = parseColor(ink(s));
      expect(b).toBeLessThan(Math.max(r, g));
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(60);
    }
    // Red gives way to green as the score climbs.
    const red = (s: number) => parseColor(ink(s)).r - parseColor(ink(s)).g;
    for (let s = 61; s <= 100; s++) expect(red(s)).toBeLessThanOrEqual(red(s - 1));
  });
});
