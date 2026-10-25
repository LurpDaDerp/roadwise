import { createContext, startTransition, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import * as Reanimated from 'react-native-reanimated';

import { plainBundle, skyBundle, type SkyBundle, type SkyColors, type SkyMood } from './sky/palette';
import { tokens, type ColorSet, type Elevation, type HudSet, type TypeScale } from './tokens';

// expo-router's testing library swaps in a Reanimated mock without this hook; fall back to the
// AccessibilityInfo subscription alone there.
const useReducedMotion: () => boolean =
  typeof Reanimated.useReducedMotion === 'function' ? Reanimated.useReducedMotion : () => false;

/**
 * The OS reduce-motion setting (iOS Reduce Motion, Android "Remove animations"), live: Reanimated's
 * synchronous read for the first frame, then the AccessibilityInfo read and its change events, so a
 * change made mid-drive applies at the next render. Usable outside a ThemeProvider (the driving
 * screen gates its own motion with it).
 */
export function useOsReduceMotion(): boolean {
  const initial = useReducedMotion();
  const [still, setStill] = useState(initial);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (live) setStill(on);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (on: boolean) => {
      if (live) setStill(on);
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return still;
}

export type Theme = {
  scheme: 'light' | 'dark';
  colors: ColorSet;
  /** The palette for content drawn on a scene card (`Card variant="hero"`): always dark. */
  onScene: ColorSet;
  /**
   * The palette for text drawn straight on the page sky (a tab screen's title, Home's greeting):
   * white inks at AA on every backdrop stop. Use `Text tone="onSky"`, `ScreenTitle` or `SkyScope`.
   */
  onSky: ColorSet;
  /** The sky: backdrop, scene card and ambient colours for the current mood. */
  sky: SkyColors;
  /** The time of day and weather the theme is wearing; null in a static look (Light, Dark, System, tests, the gallery). */
  mood: SkyMood | null;
  /**
   * Whether the driving screen wears its night look, as the theme decides it: null when the theme
   * follows the sky (Adaptive: the driving screen judges night by the sun itself); in a static look,
   * true for Dark and false for Light, day or night (System: the phone's own scheme).
   */
  hudNight: boolean | null;
  hud: HudSet;
  type: TypeScale;
  elevation: Elevation;
  size: typeof tokens.size;
  space: typeof tokens.space;
  radius: typeof tokens.radius;
  motion: typeof tokens.motion;
  reduceMotion: boolean;
};

const Ctx = createContext<Theme | null>(null);
/** Whether a change of sky fades in now: kept off the theme, so the settle after launch re-renders only the sky's layers. */
const FadeCtx = createContext(false);

/** How long a change of sky takes to fade in (light ⇄ dark included). */
export const SKY_BLEND_MS = 2400;
/** The first sky after launch lands at once (it is behind the splash); later changes fade. */
const SETTLE_MS = 1500;

/** What the theme wears: the palette and the sky it was built for, switched together. */
type Look = { bundle: SkyBundle; mood: SkyMood | null };

/**
 * `target`, reached in a single render. A change of sky (`gentle`) renders as a React transition:
 * React builds the new look in short slices between frames and yields to every touch, scroll and
 * live update (the driving screen's speed) on the way, so a change of sky never stalls the JS thread
 * however much of the app it repaints, and nothing is laid over the screen meanwhile. The sky's own
 * layers then fade to it on the UI thread (`SkyFade`). Any other change (a static look, Reduce
 * Motion, the first sky) lands in the same render (React's "adjust state when a prop changes"
 * pattern), so a pinned scheme never shows a stale frame.
 */
export function useLook(target: Look, gentle: boolean): Look {
  const [shown, setShown] = useState(target);
  const [prev, setPrev] = useState(target);
  if (prev !== target) {
    setPrev(target);
    if (!gentle) setShown(target);
  }
  useEffect(() => {
    if (gentle && shown !== target) startTransition(() => setShown(target));
  }, [gentle, shown, target]);
  return shown;
}

function buildTheme(bundle: SkyBundle, mood: SkyMood | null, hudNight: boolean | null, reduceMotion: boolean): Theme {
  return {
    scheme: bundle.scheme,
    colors: bundle.colors,
    onScene: bundle.onScene,
    onSky: bundle.onSky,
    sky: bundle.sky,
    mood,
    hudNight,
    hud: tokens.color.hud,
    type: tokens.type,
    elevation: tokens.elevation[bundle.scheme],
    size: tokens.size,
    space: tokens.space,
    radius: tokens.radius,
    motion: tokens.motion,
    reduceMotion,
  };
}

const moodKey = (m: SkyMood | null) => (m ? `${m.phase}|${m.glow}|${m.weather.kind}|${m.weather.intensity}` : null);

/**
 * The app's theme. With a `mood` (Adaptive: the root, fed by `useSkyMood`) the palette follows the
 * sky and every change of sky fades in over a couple of seconds, light ⇄ dark included: the app
 * takes the new palette in one render that never blocks a touch (`useLook`), and the sky itself
 * fades to it on the UI thread (`SkyFade`). Without one it is the static look (`plainBundle`) for the pinned scheme (Light, Dark, tests, the gallery)
 * or, with none pinned, the system's (System). A switch between Adaptive and a static look is the
 * driver's own and lands at once, either way.
 */
export function ThemeProvider({
  children,
  scheme: forced,
  reduceMotion: forcedStill,
  mood,
}: {
  children: ReactNode;
  /** Pin a static scheme (Light or Dark, the dev gallery, tests). Defaults to the system's. */
  scheme?: 'light' | 'dark';
  /** Pin reduce motion (tests, gallery). Defaults to the OS accessibility setting. */
  reduceMotion?: boolean;
  /** The sky to wear. Ignored when `scheme` is pinned. */
  mood?: SkyMood | null;
}) {
  const system = useColorScheme();
  const sysScheme = system === 'dark' ? 'dark' : 'light';
  // Reanimated reads the setting synchronously, so the first frame after launch already knows;
  // the AccessibilityInfo subscription keeps it current.
  const osStill = useOsReduceMotion();
  const reduceMotion = forcedStill ?? osStill;
  const live = !forced && mood ? mood : null;
  // The mood held by value: an equal mood in a new object never re-blends.
  const [stable, setStable] = useState(live);
  if (moodKey(stable) !== moodKey(live)) setStable(live);
  const plainScheme = forced ?? sysScheme;

  // Bundles are cached by mood, so the phone's scheme (which the sky itself sets, `SkyChrome`)
  // never makes a new target under the sky.
  const bundle = stable ? skyBundle(stable) : plainBundle(plainScheme);
  const target = useMemo<Look>(() => ({ bundle, mood: stable }), [bundle, stable]);
  // The first sky lands at once (it is behind the splash, or the driver just chose Adaptive); every
  // later change of sky fades. A static look starts the settle over.
  const [settled, setSettled] = useState(false);
  const hasMood = stable !== null;
  if (!hasMood && settled) setSettled(false);
  // A static look decides the driving screen's night itself; the sky leaves it to the sun.
  const hudNight = hasMood ? null : plainScheme === 'dark';
  useEffect(() => {
    if (!hasMood) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [hasMood]);
  // Under Reduce Motion the sky lands at once, as a static look's switch does.
  const fades = hasMood && settled && !reduceMotion;
  const look = useLook(target, fades);

  const value = useMemo<Theme>(
    () => buildTheme(look.bundle, look.mood, hudNight, reduceMotion),
    [look, hudNight, reduceMotion]
  );

  return (
    <Ctx.Provider value={value}>
      <FadeCtx.Provider value={fades}>{children}</FadeCtx.Provider>
    </Ctx.Provider>
  );
}

/**
 * Children drawn on a scene card: the parent's theme with the scene palette (dark, lifted from the
 * card's own gradient), so every primitive inside reads correctly and blends with the sky.
 */
export function SceneScope({ children }: { children: ReactNode }) {
  const parent = useTheme();
  const value = useMemo<Theme>(
    () => ({ ...parent, scheme: 'dark', colors: parent.onScene, elevation: tokens.elevation.dark }),
    [parent]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Children drawn straight on the page sky with no card under them (a header row of text and icon
 * buttons): the parent's theme with the white `onSky` palette, so every primitive inside reads on
 * the sky. Paper cards never go inside one; they keep the page palette.
 */
export function SkyScope({ children }: { children: ReactNode }) {
  const parent = useTheme();
  const value = useMemo<Theme>(
    () => ({ ...parent, scheme: 'dark', colors: parent.onSky, elevation: tokens.elevation.dark }),
    [parent]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Whether a change of sky fades in now (the sky has settled and Reduce Motion is off); else it lands at once. */
export function useSkyFades(): boolean {
  return useContext(FadeCtx);
}

export function useTheme(): Theme {
  const t = useContext(Ctx);
  if (!t) throw new Error('useTheme outside ThemeProvider');
  return t;
}

/** The theme, or null outside a ThemeProvider (the driving screen renders with or without one). */
export function useOptionalTheme(): Theme | null {
  return useContext(Ctx);
}
