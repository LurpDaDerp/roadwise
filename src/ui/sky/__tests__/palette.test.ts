import { contrastRatio } from '@/ui/contrast';
import { ensureContrast, lerpDeep, mix, opaque, parseColor } from '@/ui/sky/color';
import { defaultMood, plainBundle, skyBundle, type SkyMood } from '@/ui/sky/palette';
import type { SkyPhase } from '@/ui/sky/phase';
import type { WeatherKind } from '@/ui/sky/weather';
import { tokens } from '@/ui/tokens';

const AA = 4.5;
const phases: SkyPhase[] = ['night', 'dawn', 'day', 'dusk'];
const kinds: WeatherKind[] = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'];
const moods: SkyMood[] = phases.flatMap((phase) =>
  kinds.map((kind) => ({ phase, glow: phase === 'dawn' || phase === 'dusk' ? 1 : 0, weather: { kind, intensity: 'moderate' as const } }))
);
const name = (m: SkyMood) => `${m.phase}/${m.weather.kind}`;

function expectContrast(fg: string, bg: string, min: number, what: string) {
  const r = contrastRatio(opaque(fg), opaque(bg));
  if (r < min) throw new Error(`${what}: ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${min}:1`);
}

describe('colour helpers', () => {
  test('mix, rgba and parse round-trip', () => {
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mix('rgba(0, 0, 0, 0)', '#FFFFFF', 0.5)).toBe('rgba(128, 128, 128, 0.5)');
    expect(parseColor('rgba(10, 20, 30, 0.4)')).toEqual({ r: 10, g: 20, b: 30, a: 0.4 });
  });

  test('ensureContrast keeps a passing colour and repairs a failing one', () => {
    expect(ensureContrast('#111113', ['#FFFFFF'], AA)).toBe('#111113');
    const fixed = ensureContrast('#7FB2FF', ['#FFFFFF', '#F4F4F2'], AA);
    expect(contrastRatio(fixed, '#FFFFFF')).toBeGreaterThanOrEqual(AA);
    const lifted = ensureContrast('#1F5AD6', ['#0B0B0D'], AA);
    expect(contrastRatio(lifted, '#0B0B0D')).toBeGreaterThanOrEqual(AA);
  });
});

describe.each(moods.map((m) => [name(m), m] as const))('%s', (_n, mood) => {
  const b = skyBundle(mood);
  const c = b.colors;
  const grounds = { bg: c.bg, surface: c.surface, surfaceRaised: c.surfaceRaised };

  test('black and white stay the base: paper / ink grounds and an ink primary', () => {
    const base = tokens.color[b.scheme];
    expect(c.surface).toBe(base.surface);
    expect(c.text).toBe(base.text);
    expect(c.primary).toBe(base.primary);
    expect(b.scheme).toBe(mood.phase === 'day' || mood.phase === 'dawn' ? 'light' : 'dark');
  });

  test('text, the accent and every signal read on every ground', () => {
    for (const [g, bg] of Object.entries(grounds)) {
      for (const ink of [c.text, c.textMuted, c.textSubtle, c.accent]) expectContrast(ink, bg, AA, `${ink} on ${g}`);
      for (const s of Object.values(c.signal)) expectContrast(s.text, bg, AA, `signal on ${g}`);
      expectContrast(c.freeze, bg, AA, `freeze on ${g}`);
    }
    expectContrast(c.accent, c.accentFaint, AA, 'accent on its wash');
    expectContrast(c.accentText, c.accent, AA, 'accentText on accent');
    for (const t of Object.values(c.tier)) expectContrast(t.text, c.bg, AA, 'tier name on bg');
  });

  test('text and links read on the backdrop sky and its horizon band', () => {
    for (const g of [b.sky.top, b.sky.horizon])
      for (const ink of [c.text, c.textMuted, c.textSubtle, c.accent]) expectContrast(ink, g, AA, `${ink} on sky ${g}`);
  });

  test('the scene card carries white text, its muted inks, its accent and signals at AA', () => {
    const s = b.onScene;
    for (const stop of b.sky.scene) {
      for (const ink of [s.text, s.textMuted, s.textSubtle, s.accent, s.warning, s.danger, s.success, s.freeze])
        expectContrast(ink, stop, AA, `scene ink ${ink}`);
      for (const sig of Object.values(s.signal)) expectContrast(sig.text, stop, AA, 'scene signal');
      expectContrast(s.onPrimary, s.primary, AA, 'scene primary label');
    }
    expect(s.text).toBe('#FFFFFF');
  });
});

test('every mood has its own accent: the weather and the hour both show', () => {
  const accents = new Set(moods.map((m) => skyBundle(m).colors.accent));
  expect(accents.size).toBe(moods.length);
});

test('the plain bundle is the token set untouched', () => {
  expect(plainBundle('light').colors).toBe(tokens.color.light);
  expect(plainBundle('dark').colors).toBe(tokens.color.dark);
  expect(defaultMood('dark').phase).toBe('night');
});

describe('blending', () => {
  test('lerpDeep blends colours, keeps shape, and switches non-colours at halfway', () => {
    const a = { c: '#000000', n: 0, s: 'light', arr: ['#000000', '#FFFFFF'], shadow: undefined as string | undefined };
    const b = { c: '#FFFFFF', n: 10, s: 'dark', arr: ['#FFFFFF', '#000000'], shadow: '0px 1px 2px rgba(0, 0, 0, 0.1)' as string | undefined };
    expect(lerpDeep(a, b, 0)).toBe(a);
    expect(lerpDeep(a, b, 1)).toBe(b);
    const mid = lerpDeep(a, b, 0.25);
    expect(mid).toMatchObject({ c: '#404040', n: 2.5, s: 'light', arr: ['#404040', '#BFBFBF'] });
    expect(mid.shadow).toBeUndefined();
    expect(lerpDeep(a, b, 0.75).s).toBe('dark');
  });

  test('a blend between two moods of the same scheme keeps text and links at AA all the way', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const same = moods.filter((m) => skyBundle(m).scheme === scheme);
      for (let i = 0; i < same.length; i++) {
        const from = skyBundle(same[i]!);
        const to = skyBundle(same[(i + 7) % same.length]!);
        for (const t of [0.25, 0.5, 0.75]) {
          const m = lerpDeep(from, to, t);
          for (const g of [m.colors.bg, m.colors.surface, m.colors.surfaceRaised, m.sky.top])
            for (const ink of [m.colors.text, m.colors.textMuted, m.colors.accent]) expectContrast(ink, g, AA, `blend ${t}`);
          for (const stop of m.sky.scene) expectContrast(m.onScene.textMuted, stop, AA, 'blended scene');
        }
      }
    }
  });

  test('a blend from day to night ends exactly on the night palette', () => {
    const day = skyBundle(defaultMood('light'));
    const night = skyBundle(defaultMood('dark'));
    expect(lerpDeep(day, night, 1)).toBe(night);
    expect(lerpDeep(day, night, 0.4).scheme).toBe('light');
    expect(lerpDeep(day, night, 0.6).scheme).toBe('dark');
  });
});
