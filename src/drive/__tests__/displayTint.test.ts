import { speedTintOf } from '@/drive/displayTint';
import { numeralRamp, rampColor, speedingTint } from '@/ui/drive/halo';
import { hudPalette } from '@/ui/drive/hudTokens';

test('the Live Activity speed wears the halo numeral’s own colour: none at or under the limit, the ramp over it, red at 1.7 ×', () => {
  expect(speedTintOf(null, false)).toBeNull();
  expect(speedTintOf(0.9, false)).toBeNull();
  expect(speedTintOf(1, true)).toBeNull();
  for (const night of [false, true]) {
    for (const ratio of [1.05, 1.2, 1.4, 1.7, 2.5]) {
      expect(speedTintOf(ratio, night)).toBe(rampColor(numeralRamp(hudPalette(night)), speedingTint(ratio)));
    }
    expect(speedTintOf(1.7, night)).toBe(rampColor(numeralRamp(hudPalette(night)), 1));
    expect(speedTintOf(1.3, night)).toMatch(/^#[0-9A-F]{6}$/);
  }
  // Day and night palettes differ.
  expect(speedTintOf(1.5, false)).not.toBe(speedTintOf(1.5, true));
});
