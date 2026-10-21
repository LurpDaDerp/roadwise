import { MERIT_RULES, type MeritTier } from '@scoring';

import { contrastRatio } from '@/ui';
import { opaque, over } from '@/ui/sky/color';
import { plainBundle, skyBundle, type SkyMood } from '@/ui/sky/palette';
import type { SkyPhase } from '@/ui/sky/phase';
import type { WeatherKind } from '@/ui/sky/weather';
import { tokens } from '@/ui/tokens';

import { factInks } from '../MeritFacts';
import { MERIT_BASE, meritInk, meritWash } from '../merit';

const AA = 4.5;
const TIERS: MeritTier[] = [1, 2, 3, 4, 5];
const phases: SkyPhase[] = ['night', 'dawn', 'day', 'dusk'];
const kinds: WeatherKind[] = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'];
const moods: SkyMood[] = [
  ...phases.flatMap((phase) =>
    kinds.flatMap((kind) =>
      (['light', 'moderate', 'heavy'] as const).map((intensity) => ({ phase, glow: phase === 'dawn' || phase === 'dusk' ? 1 : 0, weather: { kind, intensity } }))
    )
  ),
];
/** Every share card sky: each adaptive phase × weather, and the two static looks. */
const scenes: [string, readonly string[]][] = [
  ...moods.map((m) => [`${m.phase}/${m.weather.kind}/${m.weather.intensity}`, skyBundle(m).sky.scene] as [string, readonly string[]]),
  ['static light', plainBundle('light').sky.scene],
  ['static dark', plainBundle('dark').sky.scene],
];

const ratio = (a: string, b: string) => contrastRatio(opaque(a), opaque(b));

test('every tier has its own base ink, grey to gold, and every rule names a tier', () => {
  expect(new Set(TIERS.map((t) => MERIT_BASE[t])).size).toBe(5);
  expect(MERIT_BASE[1]).toBe('#9AA3B2');
  expect(MERIT_BASE[2]).toBe(tokens.color.dark.signal.clean.text);
  expect(MERIT_BASE[5]).toBe(tokens.color.dark.gold);
  expect(MERIT_RULES.map((r) => r.tier)).toEqual([5, 4, 3, 2]);
});

describe.each(scenes)('the share card on the %s sky', (_name, scene) => {
  test('every tier ink reads at 4.5:1 on every scene stop', () => {
    for (const tier of TIERS) {
      const ink = meritInk(tier, scene);
      for (const stop of scene) expect(ratio(ink, stop)).toBeGreaterThanOrEqual(AA);
    }
  });

  test('the labels (70 % of the white ink) read at 4.5:1 on every stop too', () => {
    const { label } = factInks(3, scene, '#FFFFFF');
    for (const stop of scene) expect(ratio(label, stop)).toBeGreaterThanOrEqual(AA);
  });
});

describe.each(['light', 'dark'] as const)('the recap and history in the static %s look', (scheme) => {
  const c = tokens.color[scheme];
  test('every tier ink reads at 4.5:1 on the card, a pressed row and the hero wash', () => {
    for (const tier of TIERS) {
      const wash = over(c.surface, meritWash(tier, scheme));
      const hero = meritInk(tier, [c.surface, wash]);
      for (const g of [c.surface, wash]) expect(ratio(hero, g)).toBeGreaterThanOrEqual(AA);
      const row = meritInk(tier, [c.surface, c.surfaceRaised]);
      for (const g of [c.surface, c.surfaceRaised]) expect(ratio(row, g)).toBeGreaterThanOrEqual(AA);
    }
  });

  test('the wash is soft: the page ink still reads at 4.5:1 over it, and it is at most 12 % of the base', () => {
    for (const tier of TIERS) {
      const wash = meritWash(tier, scheme);
      expect(Number(/,\s*([\d.]+)\)$/.exec(wash)?.[1])).toBeLessThanOrEqual(0.12);
      const g = over(c.surface, wash);
      for (const ink of [c.text, c.textMuted]) expect(ratio(ink, g)).toBeGreaterThanOrEqual(AA);
      const { label } = factInks(tier, [c.surface, g], c.text);
      expect(ratio(label, g)).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe.each(moods.filter((m) => m.weather.intensity === 'moderate').map((m) => [`${m.phase}/${m.weather.kind}`, skyBundle(m)] as const))(
  'the recap in the adaptive %s look',
  (_name, b) => {
    test('every tier ink reads at 4.5:1 on its card and wash', () => {
      const c = b.colors;
      for (const tier of TIERS) {
        const wash = over(opaque(c.surface), meritWash(tier, b.scheme));
        const ink = meritInk(tier, [c.surface, wash]);
        for (const g of [c.surface, wash]) expect(ratio(ink, g)).toBeGreaterThanOrEqual(AA);
      }
    });
  }
);
