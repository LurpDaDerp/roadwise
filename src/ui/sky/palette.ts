import { contrastRatio } from '../contrast';
import { HUD, type HudPalette } from '../drive/hudTokens';
import { tokens, type ColorSet, type Signal } from '../tokens';
import { ensureContrast, ensureGround, formatColor, mix, opaque, over, parseColor, withAlpha } from './color';
import { PHASE_SCHEME, type Scheme, type SkyPhase } from './phase';
import { CLEAR, type SkyWeather, type WeatherKind } from './weather';

/**
 * The sky theme: the neutral paper / ink grounds, with the hour's sky painted behind the top of
 * the tab screens the way the iOS Weather app paints its backgrounds.
 *
 * The phase picks the scheme (cards and chrome) and a sky (deep azure by day, indigo to rose at
 * dawn, deep blue to magenta at dusk, navy at night); the weather pulls that sky toward its own
 * (slate for cloud, pale haze for fog, steel for rain, cold blue-grey for snow, violet-slate for a
 * storm). Text drawn straight on the sky uses the white `onSky` inks, and every backdrop stop is
 * repaired until those inks read at AA through everything the backdrop can lay over it (the cover,
 * the sun's glow, cloud and haze, a storm's wash: see {@link skyVeils}). Every
 * other colour that carries text or a mark is repaired to AA against the grounds it sits on, so
 * any mix, and any blend between two of them, stays readable. Pure functions: the provider calls
 * `skyBundle(mood)` and interpolates bundles.
 */

export type SkyMood = {
  phase: SkyPhase;
  /** Twilight warmth 0..1 (0 outside dawn and dusk). */
  glow: number;
  weather: SkyWeather;
};

/** The backdrop's text-safe stops, top to bottom. Every mood has the same count, so blends lerp. */
export type SkyStops = [string, string, string];

export type SkyColors = {
  /** The page sky, top to bottom; the white `onSky` inks read on every stop at AA. */
  backdrop: SkyStops;
  /** The bright band low in the backdrop (peach at dawn, orange at dusk) before it fades into `bg`. No text sits on it. */
  horizon: string;
  /** The sun's or moon's glow (translucent) at its core, in the top-right corner. */
  halo: string;
  /** The moon's disc (translucent); fully transparent by day and under cloud. */
  disc: string;
  /** A soft grey cover across the top under overcast, rain, snow and storms (transparent when clear). */
  cover: string;
  /**
   * The cloud layer at its densest (translucent): every puff, or every fog band, is drawn inside one
   * group faded to this alpha, so where they overlap the layer is still no denser than this.
   */
  cloud: string;
  /** Rain streaks, snowflakes and stars (translucent). */
  particle: string;
  /** A storm's slow lightning wash at its peak (transparent unless a storm). */
  wash: string;
  /** The scene card gradient (top-left → bottom-right); white text reads on every stop at AA. */
  scene: [string, string, string];
  /** The driving screen's sky, for its day and its night palette ({@link HudSky}). */
  hud: { day: HudSky; night: HudSky };
};

/**
 * The driving screen's sky: the hour's sky deepened until the HUD's print reads on every stop at
 * 7:1, its alert colours at AA and the halo's red end at 3:1. Still: no weather layer moves on it.
 */
export type HudSky = {
  /** Top to bottom. */
  stops: SkyStops;
  /** Panels and chips on it (the weather banner, the DashPal chip): a deeper shade of the sky. */
  chrome: string;
  /** Their quiet edges. */
  chromeEdge: string;
};

export type SkyBundle = {
  scheme: Scheme;
  colors: ColorSet;
  /** The palette for anything drawn on a scene card (always dark). */
  onScene: ColorSet;
  /** The palette for text drawn straight on the page sky (titles, the greeting): white inks. */
  onSky: ColorSet;
  sky: SkyColors;
};

const AA = 4.5;
/**
 * The backdrop's repair target: AA plus a little headroom, because a blend between two skies also
 * fades their veils in and out, and that mix can sit a hair brighter than either end.
 */
const SKY_AA = AA + 0.1;

/** The phase's own accent. Light phases carry a deep hue, dark phases a luminous one. */
const PHASE_ACCENT: Readonly<Record<SkyPhase, string>> = {
  day: '#1F5AD6',
  dawn: '#C4441B',
  dusk: '#FF955C',
  night: '#93A9FF',
};

/** The hue the weather pulls the accent toward, per scheme. Clear pulls nowhere. */
const WEATHER_ACCENT: Readonly<Record<Scheme, Record<Exclude<WeatherKind, 'clear'>, string>>> = {
  light: { cloudy: '#4F5F78', fog: '#4E6B64', rain: '#0B6F8C', snow: '#2B6DAE', storm: '#6440CF' },
  dark: { cloudy: '#AAB8CE', fog: '#A6C3B9', rain: '#62C9E3', snow: '#B6DCFF', storm: '#B9A1FF' },
};

/** How far the weather pulls the accent and the page tint (0 keeps the phase hue). */
export const WEATHER_WEIGHT: Readonly<Record<WeatherKind, number>> = {
  clear: 0,
  cloudy: 0.6,
  fog: 0.65,
  rain: 0.7,
  snow: 0.65,
  storm: 0.75,
};

/** How far the weather pulls the painted sky: overcast greys most of the hour's colour away. */
const SKY_WEIGHT: Readonly<Record<WeatherKind, number>> = {
  clear: 0,
  cloudy: 0.85,
  fog: 0.85,
  rain: 0.85,
  snow: 0.8,
  storm: 0.9,
};

/** The page ground's whisper of the hour, per phase. */
const PHASE_TINT: Readonly<Record<SkyPhase, string>> = {
  day: '#C9DDFF',
  dawn: '#FFD2B6',
  dusk: '#4A2236',
  night: '#10162F',
};

const WEATHER_TINT: Readonly<Record<Scheme, Record<Exclude<WeatherKind, 'clear'>, string>>> = {
  light: { cloudy: '#D5D8DC', fog: '#DDE2DE', rain: '#BCD1DB', snow: '#E4EDF7', storm: '#C9C0E3' },
  dark: { cloudy: '#26292E', fog: '#27302F', rain: '#11303B', snow: '#24324A', storm: '#22183E' },
};

/** A painted sky: three stops top to bottom and the band near the horizon. */
type Paint = { stops: SkyStops; horizon: string };

/** The clear sky per phase, modelled on the iOS Weather backgrounds (before the AA repair). */
const PHASE_PAINT: Readonly<Record<SkyPhase, Paint>> = {
  day: { stops: ['#2F78DC', '#3F8BE3', '#58A2EC'], horizon: '#A8D0F5' },
  dawn: { stops: ['#2B4489', '#5E4F8E', '#9A5A80'], horizon: '#F0A36E' },
  dusk: { stops: ['#1C2660', '#4A2F6E', '#8E3F6C'], horizon: '#E8875A' },
  night: { stops: ['#060A1C', '#0E1534', '#1B2452'], horizon: '#2A3566' },
};

/** The weather's sky, by the light of day (day, dawn) and in the dark (dusk, night). */
const WEATHER_PAINT: Readonly<Record<Scheme, Record<Exclude<WeatherKind, 'clear'>, Paint>>> = {
  light: {
    cloudy: { stops: ['#57616D', '#67717C', '#7D8691'], horizon: '#A9B0B8' },
    fog: { stops: ['#6F7A82', '#7E888E', '#8E979C'], horizon: '#BCC2C5' },
    rain: { stops: ['#33404F', '#3E4B5A', '#56626F'], horizon: '#7E8995' },
    snow: { stops: ['#5B7189', '#6B8199', '#8397AD'], horizon: '#BCCAD8' },
    storm: { stops: ['#25263A', '#2E3046', '#3E4158'], horizon: '#5C5E7A' },
  },
  dark: {
    cloudy: { stops: ['#1D2026', '#272B32', '#363A42'], horizon: '#43474F' },
    fog: { stops: ['#22272B', '#2D3338', '#3A4045'], horizon: '#4C5257' },
    rain: { stops: ['#0F141B', '#161D26', '#232B35'], horizon: '#2E3742' },
    snow: { stops: ['#1C2533', '#263142', '#344157'], horizon: '#48556C' },
    storm: { stops: ['#141522', '#1C1E2E', '#2A2C40'], horizon: '#3B3D56' },
  },
};

/** Ink used on scene cards. */
const SCENE_INK = { text: '#FFFFFF', textMuted: '#D8D8DE', textSubtle: '#C6C6CE' } as const;

/** Ink used straight on the page sky: white, with cool near-whites for secondary text. */
const SKY_INK = { text: '#FFFFFF', textMuted: '#F3F6FA', textSubtle: '#EDF1F6' } as const;

const SIGNALS: readonly Signal[] = ['clean', 'minor', 'moderate', 'severe'];

/**
 * Everything the backdrop can lay over a stop, at its densest and in the order it is drawn: the
 * cover, the sun's or moon's glow, the cloud layer, then a storm's wash. Stars, rain and snow are
 * specks that pass; they are left out.
 */
export function skyVeils(s: Pick<SkyColors, 'cover' | 'halo' | 'cloud' | 'wash'>): string[] {
  return [s.cover, s.halo, s.cloud, s.wash];
}

/** The accent before repair: the phase hue pulled toward the weather's. */
function rawAccent(phase: SkyPhase, scheme: Scheme, w: SkyWeather): string {
  const base = PHASE_ACCENT[phase];
  if (w.kind === 'clear') return base;
  return mix(base, WEATHER_ACCENT[scheme][w.kind], WEATHER_WEIGHT[w.kind]);
}

/** The painted sky for a mood before repair: the phase's sky pulled toward the weather's. */
function rawPaint(mood: SkyMood, scheme: Scheme): Paint {
  const base = PHASE_PAINT[mood.phase];
  const kind = mood.weather.kind;
  let paint = base;
  if (kind !== 'clear') {
    const pull = WEATHER_PAINT[scheme][kind];
    paint = {
      stops: base.stops.map((s, i) => mix(s, pull.stops[i] ?? s, SKY_WEIGHT[kind])) as SkyStops,
      horizon: mix(base.horizon, pull.horizon, SKY_WEIGHT[kind]),
    };
  }
  // Night sits a step nearer black than the painted navy, whatever the weather.
  if (mood.phase === 'night')
    paint = { stops: paint.stops.map((s) => mix(s, '#000000', 0.2)) as SkyStops, horizon: mix(paint.horizon, '#000000', 0.15) };
  // The warm band is strongest at sunrise and sunset and never quite leaves the twilight hour.
  if (mood.phase !== 'dawn' && mood.phase !== 'dusk') return paint;
  return { ...paint, horizon: mix(paint.stops[2], paint.horizon, Math.max(0.4, mood.glow)) };
}

/** The weather layer's translucent colours: what can drift over the sky, per kind and scheme. */
function layers(phase: SkyPhase, scheme: Scheme, w: SkyWeather) {
  const light = scheme === 'light';
  // Transparent black, not white: a blend toward a veil that is absent must not whiten the veil.
  const none = 'rgba(0, 0, 0, 0)';
  switch (w.kind) {
    case 'clear':
      return {
        cover: none,
        cloud: none,
        particle: phase === 'night' ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.5)',
        wash: none,
      };
    case 'cloudy':
      return {
        cover: light ? 'rgba(196, 205, 216, 0.08)' : 'rgba(150, 160, 175, 0.08)',
        cloud: light ? 'rgba(158, 170, 186, 0.2)' : 'rgba(140, 150, 166, 0.16)',
        particle: none,
        wash: none,
      };
    case 'fog':
      return {
        cover: light ? 'rgba(200, 206, 210, 0.08)' : 'rgba(160, 168, 172, 0.08)',
        cloud: light ? 'rgba(168, 176, 182, 0.22)' : 'rgba(150, 158, 163, 0.16)',
        particle: none,
        wash: none,
      };
    case 'rain':
      return {
        cover: light ? 'rgba(150, 162, 176, 0.08)' : 'rgba(110, 122, 138, 0.08)',
        cloud: light ? 'rgba(136, 148, 164, 0.16)' : 'rgba(115, 127, 144, 0.14)',
        particle: light ? 'rgba(214, 228, 244, 0.42)' : 'rgba(170, 196, 225, 0.34)',
        wash: none,
      };
    case 'snow':
      return {
        cover: light ? 'rgba(200, 210, 224, 0.08)' : 'rgba(165, 178, 198, 0.08)',
        cloud: light ? 'rgba(166, 180, 198, 0.18)' : 'rgba(160, 172, 192, 0.14)',
        particle: 'rgba(255, 255, 255, 0.85)',
        wash: none,
      };
    case 'storm':
      return {
        cover: light ? 'rgba(16, 16, 28, 0.24)' : 'rgba(8, 8, 16, 0.26)',
        cloud: light ? 'rgba(110, 110, 140, 0.2)' : 'rgba(100, 100, 132, 0.14)',
        particle: light ? 'rgba(205, 214, 235, 0.38)' : 'rgba(170, 176, 215, 0.3)',
        wash: light ? 'rgba(214, 208, 255, 0.12)' : 'rgba(200, 192, 255, 0.1)',
      };
  }
}

/**
 * A colour's chroma pushed away from (k > 0) or toward (k < 0) its own grey, its luminance kept
 * about where it was. Clamped to the gamut.
 */
function vivid(c: string, k: number): string {
  const { r, g, b, a } = parseColor(c);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(y + (v - y) * (1 + k))));
  return formatColor({ r: ch(r), g: ch(g), b: ch(b), a });
}

/**
 * A ground pulled toward a deep shade of its own hue until `inks` read on it (through `layers`),
 * so a repaired sky stays a clear blue instead of greying toward black; black finishes the job
 * should the deep shade not be enough.
 */
function deepen(g: string, inks: readonly string[], min: number, layers: readonly string[] = []): string {
  return ensureGround(ensureGround(g, inks, min, mix(g, '#000000', 0.7), layers), inks, min, '#000000', layers);
}

/**
 * How far the driving screen's sky is taken toward black, top to bottom, under each HUD palette.
 * The night set sits deeper than the day set, so the screen is calmer on an unlit road.
 */
export const HUD_SHADE: Readonly<Record<'day' | 'night', readonly [number, number, number]>> = {
  day: [0.12, 0.2, 0.3],
  night: [0.3, 0.4, 0.5],
};

/**
 * The driving screen's sky for one HUD palette (see {@link HudSky}): the hour's sky a little more
 * vivid, deepened in its own hue to the HUD's contrast, settling darker toward the foot so End and
 * the navigation button sit on the calmest part.
 */
export function hudSky(stops: SkyStops, p: HudPalette, shade: readonly [number, number, number]): HudSky {
  const text = [p.ink, p.inkMuted, p.haloInk, p.haloInkMuted];
  const fix = (g: string) => deepen(deepen(deepen(g, text, 7), [p.minor, p.moderate, p.severe], AA), [p.haloSevere], 3);
  const deep = stops.map((st, i) => fix(mix(vivid(st, 0.55), '#000000', shade[i]!))) as SkyStops;
  return { stops: deep, chrome: fix(mix(deep[1], '#000000', 0.4)), chromeEdge: ensureGround(mix(deep[1], '#FFFFFF', 0.14), [p.ink], 7, '#000000') };
}

/** The weather layer's colours: what can drift over the painted sky (all transparent when nothing can). */
type Veils = Pick<SkyColors, 'cover' | 'cloud' | 'particle' | 'wash'>;

function skyColors(mood: SkyMood, scheme: Scheme): SkyColors {
  const { phase, weather } = mood;
  const clear = weather.kind === 'clear';
  const haloBase = { day: '#FFF6DC', dawn: '#FFD9B0', dusk: '#FFB07A', night: '#C8D6FF' }[phase];
  // The glow's core sits beside the title row, so it stays faint enough for white text to read
  // through it without darkening the sky much (the repair below counts it).
  const haloAlpha = { day: 0.09, dawn: 0.14, dusk: 0.18, night: 0.14 }[phase];
  const covered = clear ? 1 : weather.kind === 'cloudy' && weather.intensity === 'light' ? 0.35 : 0;
  const halo = withAlpha(haloBase, haloAlpha * covered);
  const moon = phase === 'night' ? (clear ? 0.9 : weather.kind === 'cloudy' ? 0.22 : 0) : 0;
  return paintedSky(rawPaint(mood, scheme), layers(phase, scheme, weather), halo, withAlpha('#F2F4FF', moon));
}

/**
 * Every colour of a sky from its paint and what can lie over it: the backdrop and scene stops
 * repaired for their inks, and the driving screen's sky for both HUD palettes. One builder for the
 * adaptive moods and the static looks, so every contrast guarantee holds for both.
 */
function paintedSky(paint: Paint, veil: Veils, halo: string, disc: string): SkyColors {
  // The ink has to read on the bare sky and through everything that can lie over it.
  const inks = [SKY_INK.text, SKY_INK.textMuted, SKY_INK.textSubtle];
  const veils = skyVeils({ ...veil, halo });
  const backdrop = paint.stops.map((s) => deepen(s, inks, SKY_AA, veils)) as SkyStops;

  // The scene card is the same sky, a little deeper: brightest top-left, darkest bottom-right.
  const sceneInks = [SCENE_INK.text, SCENE_INK.textMuted, SCENE_INK.textSubtle];
  const [top, mid, low] = paint.stops;
  const scene = [mix(low, '#000000', 0.1), mix(mid, '#000000', 0.2), mix(top, '#000000', 0.32)].map((s) =>
    ensureGround(s, sceneInks, AA, '#000000')
  ) as [string, string, string];

  return {
    backdrop,
    horizon: opaque(paint.horizon),
    halo,
    disc,
    ...veil,
    scene,
    hud: { day: hudSky(paint.stops, HUD.day, HUD_SHADE.day), night: hudSky(paint.stops, HUD.night, HUD_SHADE.night) },
  };
}

/**
 * A white-ink palette lifted from the grounds it sits on (a scene card's stops, or the page sky's):
 * dark, with surfaces drawn from the grounds themselves, every ink and signal at AA on each, and on
 * any extra ground in `also` (the page sky's stops under its veils).
 */
function inkColors(
  grounds: readonly string[],
  ink: { text: string; textMuted: string; textSubtle: string },
  accent: string,
  also: readonly string[] = []
): ColorSet {
  const d = tokens.color.dark;
  const mid = grounds[1] ?? grounds[0]!;
  const deep = grounds[grounds.length - 1]!;
  const marks = [...grounds, ...also];
  const signal = Object.fromEntries(
    SIGNALS.map((s) => [s, { ...d.signal[s], text: ensureContrast(d.signal[s].text, marks, AA) }])
  ) as ColorSet['signal'];
  const inkAccent = ensureContrast(accent, marks, AA);
  return {
    ...d,
    bg: deep,
    bgElevated: mid,
    surface: mix(mid, '#000000', 0.25),
    surfaceRaised: mix(mid, '#FFFFFF', 0.14),
    // Tracks and rules sit darker than the ground, so a light mark on them still clears 3:1.
    border: mix(deep, '#000000', 0.4),
    borderStrong: mix(mid, '#FFFFFF', 0.6),
    divider: mix(mid, '#FFFFFF', 0.16),
    ...ink,
    textInverse: '#111113',
    accent: inkAccent,
    accentText: contrastRatio('#111113', inkAccent) >= contrastRatio('#FFFFFF', inkAccent) ? '#111113' : '#FFFFFF',
    accentFaint: mix(mid, inkAccent, 0.2),
    primary: '#FFFFFF',
    primaryPressed: '#E4E4E1',
    onPrimary: '#111113',
    signal,
    warning: ensureContrast(d.warning, marks, AA),
    danger: ensureContrast(d.danger, marks, AA),
    success: ensureContrast(d.success, marks, AA),
    info: ensureContrast(d.info, marks, AA),
  };
}

/** The whole theme for a mood. */
export function skyBundle(mood: SkyMood): SkyBundle {
  const scheme = PHASE_SCHEME[mood.phase];
  const base = tokens.color[scheme];
  const light = scheme === 'light';
  // A whisper of the sky in the page ground, so pushed screens belong to the same hour.
  const kind = mood.weather.kind;
  const tint = kind === 'clear' ? PHASE_TINT[mood.phase] : mix(PHASE_TINT[mood.phase], WEATHER_TINT[scheme][kind], WEATHER_WEIGHT[kind]);
  const bg = mix(base.bg, tint, light ? 0.1 : 0.12);
  const raw = rawAccent(mood.phase, scheme, mood.weather);
  const faint = mix(base.surface, raw, light ? 0.12 : 0.2);
  const grounds = [bg, base.surface, base.surfaceRaised, faint, base.infoFaint, base.successFaint, base.warningFaint, base.dangerFaint];
  const accent = ensureContrast(raw, grounds, AA);
  const accentText = contrastRatio('#FFFFFF', accent) >= contrastRatio('#111113', accent) ? '#FFFFFF' : '#111113';
  const colors: ColorSet = { ...base, bg, accent, accentText, accentFaint: faint };
  return bundleOf(scheme, colors, skyColors(mood, scheme));
}

/** A bundle from its page colours and its sky: the scene and sky inks lifted from the sky's grounds. */
function bundleOf(scheme: Scheme, colors: ColorSet, sky: SkyColors): SkyBundle {
  return {
    scheme,
    colors,
    onScene: inkColors(sky.scene, SCENE_INK, colors.accent),
    onSky: inkColors(sky.backdrop, SKY_INK, colors.accent, sky.backdrop.map((s) => skyVeils(sky).reduce(over, s))),
    sky,
  };
}

/** A clear sky of the scheme's own hour: clear day for light, clear night for dark. */
export function defaultMood(scheme: Scheme): SkyMood {
  return { phase: scheme === 'dark' ? 'night' : 'day', glow: 0, weather: CLEAR };
}

/**
 * The static looks' own skies (Settings › Appearance › Light, Dark or System, and any theme with
 * no mood), before repair: a royal blue for Light, bolder and more violet than the day's azure,
 * with a cool horizon and no warm band; a deep ultramarine for Dark, bluer and brighter than the
 * night's navy and nothing like an overcast grey. Neither is any hour's sky; neither carries weather.
 */
const STATIC_PAINT: Readonly<Record<Scheme, Paint>> = {
  light: { stops: ['#2338A8', '#2F47B8', '#4258C6'], horizon: '#AEBBEE' },
  dark: { stops: ['#111A48', '#182463', '#22317C'], horizon: '#34449A' },
};

const NONE = 'rgba(0, 0, 0, 0)';
/** Nothing lies over a static sky: no cover, cloud, stars or wash. */
const STILL: Veils = { cover: NONE, cloud: NONE, particle: NONE, wash: NONE };
const staticBundles: Partial<Record<Scheme, SkyBundle>> = {};

/**
 * The static look for a scheme (Light, Dark and System, the gallery and tests): the token sets
 * untouched (their own accents, no tint of any hour) with the static sky drawn around them, no sun,
 * moon or weather on it. Built by the same repairs as every mood, once per scheme, so a scheme is
 * always the same object.
 */
export function plainBundle(scheme: Scheme): SkyBundle {
  const hit = staticBundles[scheme];
  if (hit) return hit;
  const b = bundleOf(scheme, tokens.color[scheme], paintedSky(STATIC_PAINT[scheme], STILL, NONE, NONE));
  staticBundles[scheme] = b;
  return b;
}
