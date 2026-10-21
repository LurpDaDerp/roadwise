import { contrastRatio, relativeLuminance } from '@/ui/contrast';
import { ensureContrast, ensureGround, lerpDeep, mix, opaque, over, parseColor } from '@/ui/sky/color';
import { defaultMood, HUD_SHADE, hudSky, plainBundle, skyBundle, skyVeils, type SkyMood } from '@/ui/sky/palette';
import type { SkyPhase } from '@/ui/sky/phase';
import { CLEAR, type WeatherKind } from '@/ui/sky/weather';
import { HUD } from '@/ui/drive/hudTokens';
import { tokens } from '@/ui/tokens';

const AA = 4.5;
const phases: SkyPhase[] = ['night', 'dawn', 'day', 'dusk'];
const kinds: WeatherKind[] = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'];
const moods: SkyMood[] = phases.flatMap((phase) =>
  kinds.map((kind) => ({ phase, glow: phase === 'dawn' || phase === 'dusk' ? 1 : 0, weather: { kind, intensity: 'moderate' as const } }))
);
// Light cloud lets the sun's glow through (dimmed), so it is checked too.
const lightCloud: SkyMood[] = phases.map((phase) => ({ phase, glow: 1, weather: { kind: 'cloudy', intensity: 'light' } }));
const name = (m: SkyMood) => `${m.phase}/${m.weather.kind}/${m.weather.intensity}`;

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

  test('a wash laid over a ground lightens it by its alpha, and ensureGround reads through washes', () => {
    expect(over('#000000', 'rgba(255, 255, 255, 0.5)')).toBe('#808080');
    expect(over('#123456', 'rgba(255, 255, 255, 0)')).toBe('#123456');
    const veil = 'rgba(230, 236, 242, 0.3)';
    const g = ensureGround('#4C93DE', ['#FFFFFF'], AA, '#000000', [veil]);
    expect(contrastRatio('#FFFFFF', g)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio('#FFFFFF', over(g, veil))).toBeGreaterThanOrEqual(AA);
  });
});

describe.each([...moods, ...lightCloud].map((m) => [name(m), m] as const))('%s', (_n, mood) => {
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

  test('the white sky inks, the sky accent and signals read on every backdrop stop, bare and under the cover, the sun glow, cloud, haze and a storm wash', () => {
    const s = b.onSky;
    expect(s.text).toBe('#FFFFFF');
    const veils = skyVeils(b.sky);
    expect(veils).toEqual([b.sky.cover, b.sky.halo, b.sky.cloud, b.sky.wash]);
    for (const stop of b.sky.backdrop) {
      // Every partial stack too: the glow alone, the glow under cloud, and so on.
      const stacks = veils.map((_v, i) => veils.slice(0, i + 1).reduce(over, stop));
      for (const g of [stop, over(stop, b.sky.halo), ...stacks]) {
        for (const ink of [s.text, s.textMuted, s.textSubtle]) expectContrast(ink, g, AA, `sky ink ${ink} on ${g}`);
        for (const ink of [s.accent, s.warning, s.danger, s.success, s.info, s.freeze]) expectContrast(ink, g, AA, `sky mark ${ink} on ${g}`);
        for (const sig of Object.values(s.signal)) expectContrast(sig.text, g, AA, `sky signal on ${g}`);
      }
    }
  });

  test('the sky is dark enough at the top for a light status bar', () => {
    expect(relativeLuminance(b.sky.backdrop[0])).toBeLessThan(0.18);
  });

  test('clear skies show the sun or moon and no cover; weather covers them', () => {
    const alpha = (c: string) => parseColor(c).a;
    if (mood.weather.kind === 'clear') {
      expect(alpha(b.sky.cover)).toBe(0);
      expect(alpha(b.sky.halo)).toBeGreaterThan(0);
      expect(alpha(b.sky.disc) > 0).toBe(mood.phase === 'night');
    } else {
      expect(alpha(b.sky.cover)).toBeGreaterThan(0);
      expect(alpha(b.sky.cloud)).toBeGreaterThan(0);
      // Light cloud lets a dimmed sun or moon glow through; anything heavier hides it.
      const clearHalo = alpha(skyBundle({ ...mood, weather: { kind: 'clear', intensity: 'moderate' } }).sky.halo);
      if (mood.weather.kind === 'cloudy' && mood.weather.intensity === 'light') expect(alpha(b.sky.halo)).toBeLessThan(clearHalo);
      else expect(alpha(b.sky.halo)).toBe(0);
    }
    expect(alpha(b.sky.wash) > 0).toBe(mood.weather.kind === 'storm');
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

test('every mood paints the same number of stops, so any two skies blend stop by stop', () => {
  for (const m of moods) {
    const sky = skyBundle(m).sky;
    expect(sky.backdrop).toHaveLength(3);
    expect(sky.scene).toHaveLength(3);
  }
  const from = skyBundle(moods[0]!).sky;
  const to = skyBundle(moods[moods.length - 1]!).sky;
  const mid = lerpDeep(from, to, 0.5);
  mid.backdrop.forEach((s, i) => expect(s).toBe(mix(from.backdrop[i]!, to.backdrop[i]!, 0.5)));
});

test('the painted sky looks like its hour: blue by day, near-black navy at night, warm horizons at dawn and dusk', () => {
  const clear = (phase: SkyPhase) => skyBundle({ phase, glow: 1, weather: { kind: 'clear', intensity: 'moderate' } }).sky;
  const rgb = (c: string) => parseColor(c);
  const day = rgb(clear('day').backdrop[0]);
  expect(day.b).toBeGreaterThan(day.r + 100);
  expect(relativeLuminance(clear('night').backdrop[0])).toBeLessThan(0.01);
  for (const p of ['dawn', 'dusk'] as const) {
    const h = rgb(clear(p).horizon);
    expect(h.r).toBeGreaterThan(h.b);
  }
  // Overcast greys the hour away: little difference between the channels.
  const grey = rgb(skyBundle({ phase: 'day', glow: 0, weather: { kind: 'cloudy', intensity: 'moderate' } }).sky.backdrop[0]);
  expect(grey.b - grey.r).toBeLessThan(day.b - day.r);
});

test("the driving screen's sky, in both HUD palettes: its print at 7:1, its alert colours at AA and the halo's red end at 3:1 on every stop and panel", () => {
  for (const m of [...moods, ...lightCloud]) {
    const hud = skyBundle(m).sky.hud;
    for (const [which, p] of [['day', HUD.day], ['night', HUD.night]] as const) {
      const sky = hud[which];
      expect(sky.stops).toHaveLength(3);
      for (const g of [...sky.stops, sky.chrome]) {
        for (const ink of [p.ink, p.inkMuted, p.haloInk, p.haloInkMuted]) expectContrast(ink, g, 7, `${name(m)} ${which} ink`);
        for (const t of [p.minor, p.moderate, p.severe]) expectContrast(t, g, AA, `${name(m)} ${which} tier`);
        expectContrast(p.haloSevere, g, 3, `${name(m)} ${which} halo red`);
      }
      expectContrast(p.ink, sky.chromeEdge, 7, `${name(m)} ${which} ink on chrome edge`);
    }
  }
});

test("the driving screen's night sky is a step darker than its day shade, its contrast kept", () => {
  for (let i = 0; i < 3; i++) expect(HUD_SHADE.night[i]).toBeGreaterThan(HUD_SHADE.day[i]!);
  const L = (s: readonly string[]) => s.map((c) => relativeLuminance(c));
  // The brightest ground the night print reads on at 7:1: a sky the contrast repair holds down
  // lands at about this, whatever the shade.
  const p = HUD.night;
  const dimmest = Math.min(...[p.ink, p.inkMuted, p.haloInk, p.haloInkMuted].map((c) => relativeLuminance(c)));
  const floor = (dimmest + 0.05) / 7 - 0.05;
  // Any sky: the night shade never lifts a stop above the day shade's (or that floor).
  for (const m of [...moods, ...lightCloud]) {
    const stops = skyBundle(m).sky.backdrop;
    const night = L(hudSky(stops, HUD.night, HUD_SHADE.night).stops);
    const dayShade = L(hudSky(stops, HUD.night, HUD_SHADE.day).stops);
    night.forEach((l, i) => expect(l).toBeLessThanOrEqual(Math.max(dayShade[i]!, floor) + 1e-9));
  }
  for (const kind of kinds) {
    const night = skyBundle({ phase: 'night', glow: 0, weather: { kind, intensity: 'moderate' } }).sky.hud.night;
    const day = skyBundle({ phase: 'night', glow: 0, weather: { kind, intensity: 'moderate' } }).sky.hud.day;
    // The ground the driving screen's print sits on (the middle stop) is darker than the day set's.
    expect(relativeLuminance(night.stops[1])).toBeLessThan(relativeLuminance(day.stops[1]));
  }
  // A clear night: the ground sits well under the old day shade's (0.0053).
  const clearNight = skyBundle({ phase: 'night', glow: 0, weather: CLEAR }).sky.hud.night.stops;
  expect(relativeLuminance(clearNight[1])).toBeLessThan(0.004);
});

test("the driving screen's sky follows the hour and the weather", () => {
  const tops = new Set(moods.map((m) => skyBundle(m).sky.hud.day.stops[0]));
  expect(tops.size).toBe(moods.length);
  const day = parseColor(skyBundle({ phase: 'day', glow: 0, weather: { kind: 'clear', intensity: 'moderate' } }).sky.hud.day.stops[2]);
  expect(day.b).toBeGreaterThan(day.r + 40);
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

  test('a blend between any two moods keeps the white sky inks at AA on the backdrop all the way, bare and under its veils', () => {
    const all = [...moods, ...lightCloud].map((m) => skyBundle(m));
    for (const from of all)
      for (const to of all) {
        if (from === to) continue;
        for (const t of [0.25, 0.5, 0.75]) {
          const sky = lerpDeep(from.sky, to.sky, t);
          const ink = lerpDeep(from.onSky, to.onSky, t);
          for (const stop of sky.backdrop)
            for (const g of [stop, skyVeils(sky).reduce(over, stop)])
              for (const i of [ink.text, ink.textMuted, ink.textSubtle]) expectContrast(i, g, AA, `blended sky ${t}`);
        }
      }
  });

  test('a blend between two moods of the same scheme keeps text and links at AA all the way', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const same = moods.filter((m) => skyBundle(m).scheme === scheme);
      for (let i = 0; i < same.length; i++) {
        const from = skyBundle(same[i]!);
        const to = skyBundle(same[(i + 7) % same.length]!);
        for (const t of [0.25, 0.5, 0.75]) {
          const m = lerpDeep(from, to, t);
          for (const g of [m.colors.bg, m.colors.surface, m.colors.surfaceRaised])
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
