import { contrastRatio, relativeLuminance } from '@/ui/contrast';
import {
  HUD,
  HUD_CONTRAST_PAIRS,
  HUD_GRAPHIC_PAIRS,
  HUD_LIT_KEYS,
  type HudPalette,
  hudLabelScale,
  tierColor,
} from '@/ui/drive/hudTokens';
import { opaque, over } from '@/ui/sky/color';
import { plainBundle, skyBundle } from '@/ui/sky/palette';

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

  test.each(HUD_GRAPHIC_PAIRS)('the graphic %s on %s holds at least 4.5:1', (fg, bg) => {
    expect(contrastRatio(p[fg], p[bg])).toBeGreaterThanOrEqual(4.5);
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
  const checked = new Set<string>([...HUD_CONTRAST_PAIRS.flat(), ...HUD_GRAPHIC_PAIRS.flat(), 'signRing']);
  for (const key of Object.keys(HUD.day)) expect(checked).toContain(key);
});

test('night mode has no pure white and dims every lit colour', () => {
  for (const value of Object.values(HUD.night)) expect(value.toUpperCase()).not.toBe('#FFFFFF');
  for (const key of HUD_LIT_KEYS) {
    expect(relativeLuminance(HUD.night[key])).toBeLessThan(relativeLuminance(HUD.day[key]));
  }
});

test('the night print and sign are neutral greys (no warm cast), the sign a near-white', () => {
  const spread = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return Math.max(...c) - Math.min(...c);
  };
  for (const key of ['ink', 'inkMuted', 'signFace'] as const) expect(spread(HUD.night[key])).toBeLessThanOrEqual(16);
  expect(relativeLuminance(HUD.night.signFace)).toBeGreaterThan(0.7);
  expect(HUD.day.signFace).toBe('#FFFFFF');
});

test('small HUD labels follow Dynamic Type between 1x and 2x', () => {
  expect(hudLabelScale(0.8)).toBe(1);
  expect(hudLabelScale(1.5)).toBe(1.5);
  expect(hudLabelScale(3)).toBe(2);
  expect(hudLabelScale(Number.NaN)).toBe(1);
});

// The Live Activity draws the unit, the weather line and "Not driving?" in white at 0.7 over the
// driving screen's deepened sky (`DisplayLook`): it must read at 4.5:1 on every stop of every sky.
describe('white at 0.7 on the driving screen’s sky (the lock screen’s quiet print)', () => {
  const phases = ['night', 'dawn', 'day', 'dusk'] as const;
  const kinds = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'] as const;
  const bundles = [
    ...phases.flatMap((phase) =>
      kinds.flatMap((kind) =>
        ([0, 1] as const).map((glow) => ({ name: `${phase}/${kind}/${glow}`, b: skyBundle({ phase, glow, weather: { kind, intensity: 'moderate' } }) }))
      )
    ),
    ...phases.map((phase) => ({ name: `${phase}/light cloud`, b: skyBundle({ phase, glow: 1, weather: { kind: 'cloudy', intensity: 'light' } }) })),
    { name: 'plain light', b: plainBundle('light') },
    { name: 'plain dark', b: plainBundle('dark') },
  ];

  test.each(bundles.map((x) => [x.name, x.b] as const))('%s: every stop of both HUD skies', (_name, b) => {
    for (const set of ['day', 'night'] as const) {
      for (const stop of b.sky.hud[set].stops) {
        const ink = over(opaque(stop), 'rgba(255, 255, 255, 0.7)');
        expect(contrastRatio(ink, opaque(stop))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
