import { contrastRatio } from '../contrast';
import { tokens, type ColorSet, type Signal } from '../tokens';
import { ensureContrast, ensureGround, mix, withAlpha } from './color';
import { PHASE_SCHEME, type Scheme, type SkyPhase } from './phase';
import { CLEAR, type SkyWeather, type WeatherKind } from './weather';

/**
 * The sky theme: the neutral paper / ink grounds with colour from the time of day and the weather.
 *
 * The phase picks the scheme and a base hue (day blue, dawn coral, dusk ember, night moonlight);
 * the weather pulls that hue toward its own (slate for cloud, sage for fog, teal for rain, ice for
 * snow, violet for a storm) and tints the backdrop. Every colour that carries text or a mark is
 * repaired to AA against the grounds it sits on, so any mix, and any blend between two of them,
 * stays readable. Pure functions: the provider calls `skyBundle(mood)` and interpolates bundles.
 */

export type SkyMood = {
  phase: SkyPhase;
  /** Twilight warmth 0..1 (0 outside dawn and dusk). */
  glow: number;
  weather: SkyWeather;
};

export type SkyColors = {
  /** The backdrop's top colour, fading into `bg` (text reads on it at AA). */
  top: string;
  /** A warm band low in the backdrop at dawn and dusk; equals `top` otherwise. */
  horizon: string;
  /** The sun or moon's halo (translucent). */
  halo: string;
  /** The sun or moon disc (translucent); fully transparent under heavy weather. */
  disc: string;
  /** Particles and drifting shapes in the backdrop (translucent). */
  particle: string;
  /** The scene card gradient (top-left → bottom-right); white text reads on every stop at AA. */
  scene: [string, string, string];
  /** A soft glow drawn in the scene card's corner (translucent). */
  sceneGlow: string;
};

export type SkyBundle = {
  scheme: Scheme;
  colors: ColorSet;
  /** The palette for anything drawn on a scene card (always dark). */
  onScene: ColorSet;
  sky: SkyColors;
};

const AA = 4.5;

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

/** How far the weather pulls (0 keeps the phase hue). */
export const WEATHER_WEIGHT: Readonly<Record<WeatherKind, number>> = {
  clear: 0,
  cloudy: 0.6,
  fog: 0.65,
  rain: 0.7,
  snow: 0.65,
  storm: 0.75,
};

/** The backdrop's sky tint per phase. */
const PHASE_SKY: Readonly<Record<SkyPhase, string>> = {
  day: '#C9DDFF',
  dawn: '#FFD2B6',
  dusk: '#4A2236',
  night: '#172149',
};

const WEATHER_SKY: Readonly<Record<Scheme, Record<Exclude<WeatherKind, 'clear'>, string>>> = {
  light: { cloudy: '#D2D7DF', fog: '#DDE2DE', rain: '#BCD1DB', snow: '#E4EDF7', storm: '#C9C0E3' },
  dark: { cloudy: '#252A34', fog: '#27302F', rain: '#11303B', snow: '#24324A', storm: '#22183E' },
};

/** The warm band at dawn and dusk. */
const HORIZON: Readonly<Record<SkyPhase, string | null>> = {
  dawn: '#FFC39A',
  dusk: '#7C2F3A',
  day: null,
  night: null,
};

/** Scene card stops per phase (before the weather and the AA repair). */
const PHASE_SCENE: Readonly<Record<SkyPhase, [string, string, string]>> = {
  day: ['#4D8DF2', '#2A5FC4', '#16357A'],
  dawn: ['#EE8F67', '#B04E6A', '#46254F'],
  dusk: ['#F2844C', '#99345A', '#2B1636'],
  night: ['#2D3C7C', '#18214D', '#0A0E24'],
};

const WEATHER_SCENE: Readonly<Record<Exclude<WeatherKind, 'clear'>, [string, string, string]>> = {
  cloudy: ['#7A879C', '#4D596D', '#29303F'],
  fog: ['#8D9C97', '#5D6C68', '#313A38'],
  rain: ['#4B7A91', '#2B546A', '#142B39'],
  snow: ['#91A9C8', '#58739A', '#2A3B55'],
  storm: ['#594C93', '#342A65', '#160E32'],
};

/** Ink used on scene cards. */
const SCENE_INK = { text: '#FFFFFF', textMuted: '#D8D8DE', textSubtle: '#C6C6CE' } as const;

const SIGNALS: readonly Signal[] = ['clean', 'minor', 'moderate', 'severe'];

const weatherPull = (w: SkyWeather) => WEATHER_WEIGHT[w.kind];

/** The accent before repair: the phase hue pulled toward the weather's. */
function rawAccent(phase: SkyPhase, scheme: Scheme, w: SkyWeather): string {
  const base = PHASE_ACCENT[phase];
  if (w.kind === 'clear') return base;
  return mix(base, WEATHER_ACCENT[scheme][w.kind], weatherPull(w));
}

function skyColors(mood: SkyMood, scheme: Scheme, c: ColorSet): SkyColors {
  const { phase, weather } = mood;
  const light = scheme === 'light';
  const tint =
    weather.kind === 'clear' ? PHASE_SKY[phase] : mix(PHASE_SKY[phase], WEATHER_SKY[scheme][weather.kind], weatherPull(weather));
  const inks = [c.text, c.textMuted, c.textSubtle, c.accent];
  const away = light ? '#FFFFFF' : '#000000';
  const top = ensureGround(mix(c.bg, tint, light ? 0.85 : 0.9), inks, AA, away);
  const band = HORIZON[phase];
  const horizon = band ? ensureGround(mix(top, band, 0.55 * Math.max(0.4, mood.glow)), inks, AA, away) : top;

  const covered = weather.kind === 'clear' ? 1 : weather.kind === 'snow' ? 0.5 : weather.kind === 'cloudy' ? 0.35 : 0.2;
  const haloBase = { day: '#FFFFFF', dawn: '#FFD9B0', dusk: '#FF9A5E', night: '#C8D6FF' }[phase];
  const haloAlpha = { day: 0.85, dawn: 0.85, dusk: 0.26, night: 0.12 }[phase];
  const discBase = { day: '#FFFFFF', dawn: '#FFE7CC', dusk: '#FFB27E', night: '#E9EEFF' }[phase];
  const discAlpha = { day: 0.95, dawn: 0.95, dusk: 0.55, night: 0.6 }[phase];

  const particle = (() => {
    switch (weather.kind) {
      case 'rain':
        return light ? 'rgba(30, 70, 100, 0.22)' : 'rgba(165, 210, 235, 0.24)';
      case 'storm':
        return light ? 'rgba(60, 40, 120, 0.22)' : 'rgba(200, 185, 255, 0.22)';
      case 'snow':
        return light ? 'rgba(110, 140, 185, 0.45)' : 'rgba(255, 255, 255, 0.7)';
      case 'cloudy':
        return light ? 'rgba(255, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.05)';
      case 'fog':
        return light ? 'rgba(255, 255, 255, 0.6)' : 'rgba(210, 222, 216, 0.07)';
      case 'clear':
        return phase === 'night' ? 'rgba(255, 255, 255, 0.8)' : light ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 210, 170, 0.12)';
    }
  })();

  const baseScene = PHASE_SCENE[phase];
  const pull = weather.kind === 'clear' ? 0 : weatherPull(weather) * 0.9;
  const sceneInks = [SCENE_INK.text, SCENE_INK.textMuted, SCENE_INK.textSubtle];
  const scene = baseScene.map((stop, i) => {
    const w = weather.kind === 'clear' ? stop : mix(stop, WEATHER_SCENE[weather.kind][i] ?? stop, pull);
    return ensureGround(w, sceneInks, AA, '#000000');
  }) as [string, string, string];
  const sceneGlow = withAlpha(
    weather.kind === 'clear' ? discBase : mix(discBase, '#FFFFFF', 0.5),
    weather.kind === 'clear' ? 0.32 : 0.16
  );

  return {
    top,
    horizon,
    halo: withAlpha(haloBase, haloAlpha * covered),
    disc: withAlpha(discBase, weather.kind === 'clear' ? discAlpha : weather.kind === 'cloudy' ? discAlpha * 0.35 : 0),
    particle,
    scene,
    sceneGlow,
  };
}

/** The palette drawn on a scene card: dark, with surfaces lifted from the scene itself. */
function sceneColors(scene: [string, string, string], accent: string): ColorSet {
  const d = tokens.color.dark;
  const mid = scene[1];
  const signal = Object.fromEntries(
    SIGNALS.map((s) => [s, { ...d.signal[s], text: ensureContrast(d.signal[s].text, scene, AA) }])
  ) as ColorSet['signal'];
  const sceneAccent = ensureContrast(accent, scene, AA);
  return {
    ...d,
    bg: scene[2],
    bgElevated: mid,
    surface: mix(mid, '#000000', 0.25),
    surfaceRaised: mix(mid, '#FFFFFF', 0.14),
    // Tracks and rules sit darker than the scene, so a light mark on them still clears 3:1.
    border: mix(scene[2], '#000000', 0.4),
    borderStrong: mix(mid, '#FFFFFF', 0.6),
    divider: mix(mid, '#FFFFFF', 0.16),
    ...SCENE_INK,
    textInverse: '#111113',
    accent: sceneAccent,
    accentText: contrastRatio('#111113', sceneAccent) >= contrastRatio('#FFFFFF', sceneAccent) ? '#111113' : '#FFFFFF',
    accentFaint: mix(mid, sceneAccent, 0.2),
    primary: '#FFFFFF',
    primaryPressed: '#E4E4E1',
    onPrimary: '#111113',
    signal,
    warning: ensureContrast(d.warning, scene, AA),
    danger: ensureContrast(d.danger, scene, AA),
    success: ensureContrast(d.success, scene, AA),
    info: ensureContrast(d.info, scene, AA),
    freeze: ensureContrast(d.freeze, scene, AA),
  };
}

/** The whole theme for a mood. */
export function skyBundle(mood: SkyMood): SkyBundle {
  const scheme = PHASE_SCHEME[mood.phase];
  const base = tokens.color[scheme];
  const light = scheme === 'light';
  // A whisper of the sky in the page ground, so pushed screens belong to the same hour.
  const tint = mood.weather.kind === 'clear' ? PHASE_SKY[mood.phase] : mix(PHASE_SKY[mood.phase], WEATHER_SKY[scheme][mood.weather.kind], weatherPull(mood.weather));
  const bg = mix(base.bg, tint, light ? 0.1 : 0.12);
  const raw = rawAccent(mood.phase, scheme, mood.weather);
  const faint = mix(base.surface, raw, light ? 0.12 : 0.2);
  const grounds = [bg, base.surface, base.surfaceRaised, faint, base.infoFaint, base.successFaint, base.warningFaint, base.dangerFaint];
  const accent = ensureContrast(raw, grounds, AA);
  const accentText = contrastRatio('#FFFFFF', accent) >= contrastRatio('#111113', accent) ? '#FFFFFF' : '#111113';
  const colors: ColorSet = { ...base, bg, accent, accentText, accentFaint: faint };
  const sky = skyColors(mood, scheme, colors);
  return { scheme, colors, onScene: sceneColors(sky.scene, accent), sky };
}

/** The mood the app wears with no sky information: clear day in light, clear night in dark. */
export function defaultMood(scheme: Scheme): SkyMood {
  return { phase: scheme === 'dark' ? 'night' : 'day', glow: 0, weather: CLEAR };
}

/**
 * The bundle with no sky at all (tests, the gallery, a pinned scheme): the token sets untouched,
 * with the default mood's sky drawn around them.
 */
export function plainBundle(scheme: Scheme): SkyBundle {
  const b = skyBundle(defaultMood(scheme));
  return { ...b, colors: tokens.color[scheme] };
}
