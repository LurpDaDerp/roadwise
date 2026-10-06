import { contrastRatio, relativeLuminance } from '@/ui/contrast';
import {
  HUD,
  HUD_CONTRAST_PAIRS,
  HUD_LIT_KEYS,
  type HudPalette,
  hudLabelScale,
  SPEED_NUMERAL_MAX_PT,
  SPEED_NUMERAL_MIN_PT,
  speedNumeralPt,
  tierColor,
} from '@/ui/drive/hudTokens';

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

  test('black print on every tier colour holds 7:1 (the alert chip)', () => {
    for (const tier of ['minor', 'moderate', 'severe'] as const) {
      expect(contrastRatio(p.ground, tierColor(p, tier))).toBeGreaterThanOrEqual(7);
    }
  });

  test('the sign ring stands off the sign face as a graphic (≥ 3:1)', () => {
    expect(contrastRatio(p.signRing, p.signFace)).toBeGreaterThanOrEqual(3);
  });

  test('the three tiers are distinct and get darker-warmer from minor to severe', () => {
    expect(new Set([p.minor, p.moderate, p.severe]).size).toBe(3);
    expect(relativeLuminance(p.minor)).toBeGreaterThan(relativeLuminance(p.moderate));
    expect(relativeLuminance(p.moderate)).toBeGreaterThan(relativeLuminance(p.severe));
  });
});

test('every colour in both palettes is covered by at least one check', () => {
  const checked = new Set<string>([...HUD_CONTRAST_PAIRS.flat(), 'signRing']);
  for (const key of Object.keys(HUD.day)) expect(checked).toContain(key);
});

test('night mode has no pure white and dims every lit colour', () => {
  for (const value of Object.values(HUD.night)) expect(value.toUpperCase()).not.toBe('#FFFFFF');
  for (const key of HUD_LIT_KEYS) {
    expect(relativeLuminance(HUD.night[key])).toBeLessThan(relativeLuminance(HUD.day[key]));
  }
});

test('the speed numerals follow the short side within their bounds', () => {
  expect(speedNumeralPt(390)).toBe(133);
  expect(speedNumeralPt(100)).toBe(SPEED_NUMERAL_MIN_PT);
  expect(speedNumeralPt(1000)).toBe(SPEED_NUMERAL_MAX_PT);
  expect(speedNumeralPt(Number.NaN)).toBe(SPEED_NUMERAL_MIN_PT);
});

test('small HUD labels follow Dynamic Type between 1x and 2x', () => {
  expect(hudLabelScale(0.8)).toBe(1);
  expect(hudLabelScale(1.5)).toBe(1.5);
  expect(hudLabelScale(3)).toBe(2);
  expect(hudLabelScale(Number.NaN)).toBe(1);
});
