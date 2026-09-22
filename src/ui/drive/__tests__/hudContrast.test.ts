import { contrastRatio, relativeLuminance } from '@/ui/contrast';
import { HUD, HUD_CONTRAST_PAIRS, type HudPalette } from '@/ui/drive/hudTokens';

const palettes: [string, HudPalette][] = [
  ['day', HUD.day],
  ['night', HUD.night],
];

describe.each(palettes)('the %s HUD palette', (_name, p) => {
  test('sits on true black', () => {
    expect(p.ground).toBe('#000000');
  });

  test.each(HUD_CONTRAST_PAIRS)('%s on %s holds at least 7:1', (fg, bg) => {
    expect(contrastRatio(p[fg], p[bg])).toBeGreaterThanOrEqual(7);
  });
});

test('every colour in both palettes is covered by at least one checked pair', () => {
  const checked = new Set(HUD_CONTRAST_PAIRS.flat());
  for (const key of Object.keys(HUD.day)) expect(checked).toContain(key);
});

test('night mode has no pure white anywhere (§13.2)', () => {
  for (const value of Object.values(HUD.night)) expect(value.toUpperCase()).not.toBe('#FFFFFF');
});

test('night mode reduces luminance on every lit colour and red-shifts the numerals', () => {
  for (const key of Object.keys(HUD.day) as (keyof HudPalette)[]) {
    if (HUD.day[key] === '#000000') continue;
    expect(relativeLuminance(HUD.night[key])).toBeLessThan(relativeLuminance(HUD.day[key]));
  }
  const hex = HUD.night.ink.replace('#', '');
  const [r, , b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  expect(r).toBeGreaterThan(b!);
});

test('the day palette is the M0 HUD set, so the design system has one HUD white and one speeding ink', () => {
  expect(HUD.day.ink).toBe('#FFFFFF');
  expect(HUD.day.speeding).toBe('#FF6BB3');
  expect(HUD.day.attention).toBe('#FFC24D');
});
