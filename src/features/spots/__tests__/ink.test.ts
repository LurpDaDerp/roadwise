/** @jest-environment node */
import { contrastRatio } from '@/ui';
import { parseColor } from '@/ui/sky/color';
import { plainBundle, skyBundle } from '@/ui/sky/palette';
import type { SkyPhase } from '@/ui/sky/phase';
import type { WeatherKind } from '@/ui/sky/weather';
import { tokens } from '@/ui/tokens';

import { SPOT_INK, spotInk } from '../ink';

/** The map tiles the All trips map shows: light (cream, white) and dark (the night greys). */
const TILES = { light: ['#F9F5ED', '#FFFFFF'], dark: ['#242424', '#2B2B2B'] } as const;

/** Hue (degrees) and saturation (0..1, HSL) of a colour. */
function hueSat(c: string): { h: number; s: number } {
  const { r, g, b } = parseColor(c);
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s };
}
const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

describe('the spot ink', () => {
  test.each(['light', 'dark'] as const)('%s: the line reads at 3:1 on the map tiles, its icon at 4.5:1, the disc at 3:1 on the card', (scheme) => {
    const ink = spotInk(scheme);
    for (const tile of TILES[scheme]) expect(contrastRatio(ink.line, tile)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(ink.onLine, ink.line)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ink.line, tokens.color[scheme].surface)).toBeGreaterThanOrEqual(3);
    // The casing sets the line off the heat lines and the tiles beneath it.
    expect(contrastRatio(ink.line, ink.casing)).toBeGreaterThanOrEqual(3);
  });

  test('the measured ratios', () => {
    expect(contrastRatio(SPOT_INK.light.line, '#F9F5ED')).toBeCloseTo(4.9, 1);
    expect(contrastRatio(SPOT_INK.dark.line, '#242424')).toBeCloseTo(6.02, 1);
    expect(contrastRatio(SPOT_INK.dark.onLine, SPOT_INK.dark.line)).toBeCloseTo(7.31, 1);
  });

  test("is never a tier or health colour", () => {
    const used = new Set<string>();
    for (const scheme of ['light', 'dark'] as const) for (const s of Object.values(tokens.color[scheme].signal)) used.add(s.fill.toUpperCase());
    for (const scheme of ['light', 'dark'] as const) expect(used.has(SPOT_INK[scheme].line.toUpperCase())).toBe(false);
  });

  test('stays apart from the heat lines in every sky: every accent is grey or at least 35° of hue away', () => {
    const phases: SkyPhase[] = ['day', 'dawn', 'dusk', 'night'];
    const kinds: WeatherKind[] = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'];
    const accents: { scheme: 'light' | 'dark'; accent: string; what: string }[] = [];
    for (const phase of phases)
      for (const kind of kinds)
        for (const glow of [0, 1]) {
          const b = skyBundle({ phase, glow, weather: { kind, intensity: 'heavy' } });
          accents.push({ scheme: b.scheme, accent: b.colors.accent, what: `${phase}/${kind}/${glow}` });
        }
    for (const scheme of ['light', 'dark'] as const) accents.push({ scheme, accent: plainBundle(scheme).colors.accent, what: `static ${scheme}` });
    for (const { scheme, accent, what } of accents) {
      const a = hueSat(accent);
      const line = hueSat(SPOT_INK[scheme].line);
      const ok = a.s < 0.25 || hueGap(a.h, line.h) >= 35;
      if (!ok) throw new Error(`${what}: accent ${accent} is too close to the spot ink ${SPOT_INK[scheme].line}`);
    }
  });
});
