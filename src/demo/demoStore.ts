// DEMO ONLY (temporary): the three demo switches in Settings and everything they drive. Delete this
// folder, and the lines marked "DEMO" in the files that import it, to take the demo out.
import { useSyncExternalStore } from 'react';

import type { DashcamVisual, HeldAlert } from '@/dashcam/alerts';
import { SOUND } from '@/dashcam/protocol';
import type { DangerAlert } from '@/features/weather/danger';
import { conditionsFrom, type Conditions } from '@/features/weather/conditions';
import type { SkyPhase } from '@/ui/sky/phase';
import { skyBundle, type SkyBundle, type SkyMood } from '@/ui/sky/palette';
import type { WeatherIntensity, WeatherKind } from '@/ui/sky/weather';
import { SKY_BLEND_MS } from '@/ui/theme';

/** Each theme is fully on screen this long once its fade has finished. */
export const THEME_HOLD_MS = 3000;
/** From one theme's switch to the next: the fade, then the hold. */
export const THEME_PERIOD_MS = SKY_BLEND_MS + THEME_HOLD_MS;
/** Each DashPal alert stays on the drive screen this long. */
export const DASHPAL_PERIOD_MS = 5000;

export type DemoFlags = { themeCycle: boolean; dashpalCycle: boolean; weatherWarning: boolean };
export type DemoState = DemoFlags & {
  themeIndex: number;
  dashpalIndex: number;
  /** When the DashPal alert on show began (JS clock). */
  dashpalAt: number;
  /** Counts every DashPal alert shown, for a fresh key each time. */
  dashpalCount: number;
};

let state: DemoState = {
  themeCycle: false,
  dashpalCycle: false,
  weatherWarning: false,
  themeIndex: 0,
  dashpalIndex: 0,
  dashpalAt: 0,
  dashpalCount: 0,
};
const listeners = new Set<() => void>();

const STORAGE_KEY = 'roadwise.demo.v1';

function storage(): { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    return (require('@react-native-async-storage/async-storage') as { default: ReturnType<typeof storage> }).default;
  } catch {
    return null;
  }
}

function publish(next: DemoState): void {
  state = next;
  for (const l of [...listeners]) l();
}

export const getDemo = (): DemoState => state;

export function subscribeDemo(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDemo(): DemoState {
  return useSyncExternalStore(subscribeDemo, getDemo, getDemo);
}

/** A switch flipped in Settings: a cycle starts from its first step, and the flags are kept for the next launch. */
export function setDemoFlag(flag: keyof DemoFlags, value: boolean): void {
  const next = { ...state, [flag]: value };
  if (flag === 'themeCycle' && value) next.themeIndex = 0;
  if (flag === 'dashpalCycle' && value) {
    next.dashpalIndex = 0;
    next.dashpalAt = Date.now();
    next.dashpalCount = state.dashpalCount + 1;
  }
  publish(next);
  const { themeCycle, dashpalCycle, weatherWarning } = next;
  void storage()?.setItem(STORAGE_KEY, JSON.stringify({ themeCycle, dashpalCycle, weatherWarning })).catch(() => {});
}

export function advanceDemoTheme(): void {
  publish({ ...state, themeIndex: (state.themeIndex + 1) % DEMO_THEMES.length });
}

export function advanceDemoDashpal(): void {
  publish({
    ...state,
    dashpalIndex: (state.dashpalIndex + 1) % DEMO_DASHPAL.length,
    dashpalAt: Date.now(),
    dashpalCount: state.dashpalCount + 1,
  });
}

void storage()
  ?.getItem(STORAGE_KEY)
  .then((raw) => {
    if (!raw) return;
    const v = JSON.parse(raw) as Partial<DemoFlags>;
    publish({
      ...state,
      themeCycle: v.themeCycle === true,
      dashpalCycle: v.dashpalCycle === true,
      weatherWarning: v.weatherWarning === true,
      dashpalAt: Date.now(),
    });
  })
  .catch(() => {});

// --- themes ---------------------------------------------------------------------------------------

export type DemoTheme = { mood: SkyMood; label: string; conditions: Conditions };

const PHASES: readonly { phase: SkyPhase; glow: number; name: string; tempC: number; day: boolean }[] = [
  { phase: 'dawn', glow: 0.8, name: 'morning', tempC: 10, day: true },
  { phase: 'day', glow: 0, name: 'day', tempC: 20, day: true },
  { phase: 'dusk', glow: 0.8, name: 'sunset', tempC: 15, day: true },
  { phase: 'night', glow: 0, name: 'night', tempC: 8, day: false },
];

/** The sky's six weathers, each with the WMO code the drive card's weather reads and its warmth against clear. */
const WEATHERS: readonly { kind: WeatherKind; intensity: WeatherIntensity; adjective: string; code: number; offsetC: number }[] = [
  { kind: 'clear', intensity: 'light', adjective: 'clear', code: 0, offsetC: 0 },
  { kind: 'cloudy', intensity: 'moderate', adjective: 'cloudy', code: 3, offsetC: -2 },
  { kind: 'fog', intensity: 'moderate', adjective: 'foggy', code: 45, offsetC: -3 },
  { kind: 'rain', intensity: 'moderate', adjective: 'rainy', code: 63, offsetC: -4 },
  { kind: 'snow', intensity: 'moderate', adjective: 'snowy', code: 73, offsetC: -18 },
  { kind: 'storm', intensity: 'moderate', adjective: 'stormy', code: 95, offsetC: -3 },
];

const sample = (code: number, tempC: number, isDay: boolean) => ({
  time: 0,
  code,
  tempC,
  rainMmH: null,
  precipMmH: null,
  snowCmH: null,
  windMph: null,
  gustMph: null,
  visibilityM: null,
  isDay,
});

/** Every time of day under every weather, a full day under each weather in turn. */
export const DEMO_THEMES: readonly DemoTheme[] = WEATHERS.flatMap((w) =>
  PHASES.map((p) => ({
    mood: { phase: p.phase, glow: p.glow, weather: { kind: w.kind, intensity: w.intensity } },
    label: `${w.adjective} ${p.name}`,
    conditions: conditionsFrom(sample(w.code, p.tempC + w.offsetC, p.day)) as Conditions,
  }))
);

/** The weather warning's scene: night under heavy rain. */
export const DEMO_WARNING_THEME: DemoTheme = {
  mood: { phase: 'night', glow: 0, weather: { kind: 'rain', intensity: 'heavy' } },
  label: 'heavy rain night',
  conditions: conditionsFrom(sample(65, 11, false)) as Conditions,
};

export const DEMO_WARNING_ALERT: DangerAlert = { kind: 'heavy_rain', gustMph: null, visibilityM: null };

/** The theme the demo wants now (the weather warning outranks the cycle), or null when neither is on. */
export function demoThemeOf(s: DemoState): DemoTheme | null {
  if (s.weatherWarning) return DEMO_WARNING_THEME;
  if (s.themeCycle) return DEMO_THEMES[s.themeIndex % DEMO_THEMES.length] ?? null;
  return null;
}

export function useDemoTheme(): DemoTheme | null {
  return demoThemeOf(useDemo());
}

const bundles = new Map<DemoTheme, SkyBundle>();
/** The driving screen's sky for a demo theme, and whether it wears its night palette (the dark phases). */
export function demoHudLook(theme: DemoTheme): { night: boolean; sky: SkyBundle['sky']['hud']['day'] } {
  let b = bundles.get(theme);
  if (!b) {
    b = skyBundle(theme.mood);
    bundles.set(theme, b);
  }
  const night = b.scheme === 'dark';
  return { night, sky: night ? b.sky.hud.night : b.sky.hud.day };
}

// --- DashPal ----------------------------------------------------------------------------------------

/** Every alert DashPal can raise, in the order the cycle shows them. */
const DEMO_DASHPAL: readonly { sound: number; tier: number; level: number }[] = [
  { sound: SOUND.GLANCE, tier: 2, level: 0 },
  { sound: SOUND.DROWSY, tier: 2, level: 0 },
  { sound: SOUND.WAKE, tier: 3, level: 1 },
  { sound: SOUND.PHONE, tier: 2, level: 0 },
  { sound: SOUND.NO_FACE, tier: 2, level: 0 },
];

export type DemoDashpal = { flash: DashcamVisual & { until: number }; held: HeldAlert };

/** The DashPal alert on show, banner and halo alike, while the cycle is on; else null. */
export function demoDashpalOf(s: DemoState): DemoDashpal | null {
  if (!s.dashpalCycle) return null;
  const a = DEMO_DASHPAL[s.dashpalIndex % DEMO_DASHPAL.length];
  if (!a) return null;
  return {
    flash: {
      key: `demo:${s.dashpalCount}`,
      alertId: s.dashpalCount,
      sound: a.sound,
      tier: a.tier,
      level: a.level,
      onPhone: false,
      at: s.dashpalAt,
      resend: false,
      until: s.dashpalAt + DASHPAL_PERIOD_MS,
    },
    held: { sound: a.sound, tier: a.tier, level: a.level, since: s.dashpalAt },
  };
}
