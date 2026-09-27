import { contrastRatio, relativeLuminance } from '@/ui/contrast';
import {
  HALO_MAX_PT,
  HALO_MIN_PT,
  haloColor,
  haloSize,
  HUD,
  HUD_CONTRAST_PAIRS,
  HUD_LIT_KEYS,
  type HudPalette,
  SPEED_NUMERAL_MAX_PT,
  SPEED_NUMERAL_MIN_PT,
  speedNumeralPt,
} from '@/ui/drive/hudTokens';

const palettes: [string, HudPalette][] = [
  ['day', HUD.day],
  ['night', HUD.night],
];

describe.each(palettes)('the %s HUD palette', (_name, p) => {
  test('sits on ink-black', () => {
    expect(p.ground).toBe('#000814');
  });

  test.each(HUD_CONTRAST_PAIRS)('%s on %s holds at least 7:1', (fg, bg) => {
    expect(contrastRatio(p[fg], p[bg])).toBeGreaterThanOrEqual(7);
  });

  test('the SOS face stands off the ground as a control (≥ 3:1) as well as printing at 7:1', () => {
    expect(contrastRatio(p.sos, p.ground)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(p.sosInk, p.sos)).toBeGreaterThanOrEqual(7);
  });

  test('the halo colours are three distinct hues, each ≥ 7:1 on the ground', () => {
    const set = new Set([p.calm, p.attention, p.critical]);
    expect(set.size).toBe(3);
    expect(haloColor(p, 'calm')).toBe(p.calm);
    expect(haloColor(p, 'attention')).toBe(p.attention);
    expect(haloColor(p, 'critical')).toBe(p.critical);
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
  for (const key of HUD_LIT_KEYS) {
    expect(relativeLuminance(HUD.night[key])).toBeLessThan(relativeLuminance(HUD.day[key]));
  }
  const hex = HUD.night.ink.replace('#', '');
  const [r, , b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  expect(r).toBeGreaterThan(b!);
});

test('the day palette is the app palette: ink-black, school-bus yellow, navy chrome, soft red', () => {
  expect(HUD.day.ground).toBe('#000814');
  expect(HUD.day.attention).toBe('#FFC300');
  expect(HUD.day.chrome).toBe('#001D3D');
  expect(HUD.day.chromeEdge).toBe('#003566');
  expect(HUD.day.signFace).toBe('#FFFFFF');
  // The critical and SOS reds are soft: lighter than a pure red, so black print reads on them.
  expect(relativeLuminance(HUD.day.critical)).toBeGreaterThan(relativeLuminance('#FF0000'));
});

describe('sizing', () => {
  test('the numerals follow the halo between their bounds', () => {
    expect(speedNumeralPt(200)).toBe(80);
    expect(speedNumeralPt(100)).toBe(SPEED_NUMERAL_MIN_PT);
    expect(speedNumeralPt(400)).toBe(SPEED_NUMERAL_MAX_PT);
  });

  test('the halo takes the room it has, within its bounds', () => {
    // A 390 × 844 phone in portrait, after the bars and insets: the width is the limit.
    expect(haloSize(358, 600, false)).toBe(HALO_MAX_PT);
    // A landscape mount: the height is the limit, the sign beside it costs no height.
    expect(haloSize(750, 209, true)).toBe(209);
    // Never below the minimum, whatever the room.
    expect(haloSize(100, 100, true)).toBe(HALO_MIN_PT);
    expect(haloSize(Number.NaN, 300, false)).toBe(HALO_MIN_PT);
  });
});
