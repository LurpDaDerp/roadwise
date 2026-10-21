import { render, screen } from '@testing-library/react-native';
import type { MeritTier } from '@scoring';

import { MERIT_GLYPH, MeritIcon } from '@/ui';

const TIERS: MeritTier[] = [1, 2, 3, 4, 5];

test('five glyphs, each its own shape (pebble, sprout, star, gem, crown)', () => {
  const shapes = TIERS.map((t) => MERIT_GLYPH[t].fill);
  expect(new Set(shapes).size).toBe(5);
  for (const d of shapes) expect(d).toMatch(/^M[\d .,LCHVZMlchvzm-]+$/);
});

test.each(TIERS)('tier %i draws in the colour it is given, at its size, hidden from screen readers', async (tier) => {
  await render(<MeritIcon tier={tier} size={22} color="#9B6DFF" testID="icon" />);
  const icon = screen.getByTestId('icon', { includeHiddenElements: true });
  expect(icon).toHaveProp('width', 22);
  expect(icon).toHaveProp('accessibilityElementsHidden', true);
  // react-native-svg packs a colour as ARGB: 0xFF9B6DFF.
  expect(JSON.stringify(screen.toJSON())).toContain(`"payload":${parseInt('FF9B6DFF', 16)}`);
});
