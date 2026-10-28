import { speedTintOf } from '@/drive/displayTint';
import { numeralRamp, rampColor, speedingTint } from '@/ui/drive/halo';
import { hudPalette } from '@/ui/drive/hudTokens';

test('the Live Activity speed wears the halo numeral’s own colour: none at or under the limit, the ramp over it, red past the line', () => {
  expect(speedTintOf(null, 35, false)).toBeNull();
  expect(speedTintOf(1.2, null, false)).toBeNull();
  expect(speedTintOf(0.9, 35, false)).toBeNull();
  expect(speedTintOf(1, 35, true)).toBeNull();
  for (const night of [false, true]) {
    for (const ratio of [1.05, 1.1, 1.15, 1.2, 1.5]) {
      expect(speedTintOf(ratio, 35, night)).toBe(rampColor(numeralRamp(hudPalette(night)), speedingTint(ratio, 35)));
    }
    // 39.8 on a 35 is its speeding line (half way); 42.1 is past full red.
    expect(speedTintOf(39.8 / 35, 35, night)).toBe(rampColor(numeralRamp(hudPalette(night)), 0.5));
    expect(speedTintOf(42.1 / 35, 35, night)).toBe(rampColor(numeralRamp(hudPalette(night)), 1));
    expect(speedTintOf(1.1, 35, night)).toMatch(/^#[0-9A-F]{6}$/);
  }
  // Day and night palettes differ.
  expect(speedTintOf(1.1, 35, false)).not.toBe(speedTintOf(1.1, 35, true));
});
