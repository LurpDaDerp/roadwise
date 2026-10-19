import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import * as Reanimated from 'react-native-reanimated';

import { lerpDeep } from './sky/color';
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
  /** The time of day and weather the theme is wearing; null when pinned (tests, gallery). */
  mood: SkyMood | null;
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

/** How long a change of sky takes to blend in (light ⇄ dark included). */
export const SKY_BLEND_MS = 2400;
/** The blend repaints at most this often: smooth to the eye without re-rendering every frame. */
export const BLEND_FRAME_MS = 50;
/** The first sky after launch lands at once (it is behind the splash); later changes blend. */
const SETTLE_MS = 1500;

export const easeInOutCubic = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

/**
 * `target`, reached by blending from whatever is on screen over `durationMs`. A new target
 * mid-blend starts from the colours on screen, so nothing ever jumps. The steep middle of the ease
 * keeps the instant where light and dark grounds cross as short as it can be.
 */
export function useBlendedBundle(target: SkyBundle, animate: boolean, durationMs = SKY_BLEND_MS): SkyBundle {
  const [shown, setShown] = useState(target);
  const [prev, setPrev] = useState(target);
  // A change that is not to be blended lands in the same render (React's "adjust state when a
  // prop changes" pattern), so a pinned scheme never shows a stale frame.
  if (prev !== target) {
    setPrev(target);
    if (!animate) setShown(target);
  }
  const shownRef = useRef(shown);
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);
  useEffect(() => {
    if (!animate) return;
    const from = shownRef.current;
    if (from === target) return;
    const start = Date.now();
    let last = 0;
    let frame: number | null = null;
    const step = () => {
      const t = Date.now();
      const p = Math.min(1, (t - start) / durationMs);
      if (p >= 1 || t - last >= BLEND_FRAME_MS) {
        last = t;
        const v = p >= 1 ? target : lerpDeep(from, target, easeInOutCubic(p));
        shownRef.current = v;
        setShown(v);
      }
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [target, animate, durationMs]);
  return shown;
}

function buildTheme(bundle: SkyBundle, mood: SkyMood | null, reduceMotion: boolean): Theme {
  return {
    scheme: bundle.scheme,
    colors: bundle.colors,
    onScene: bundle.onScene,
    onSky: bundle.onSky,
    sky: bundle.sky,
    mood,
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
 * The app's theme. With a `mood` (the root, fed by `useSkyMood`) the palette follows the sky and
 * every change blends in over a couple of seconds, light ⇄ dark included. Without one it is the
 * plain paper / ink set for the pinned or system scheme (tests, the gallery).
 */
export function ThemeProvider({
  children,
  scheme: forced,
  reduceMotion: forcedStill,
  mood,
}: {
  children: ReactNode;
  /** Pin a scheme (the dev gallery renders both side by side). Defaults to the system's. */
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

  const target = useMemo(() => (stable ? skyBundle(stable) : plainBundle(plainScheme)), [stable, plainScheme]);
  // The first sky lands at once (it is behind the splash); every later change blends.
  const [settled, setSettled] = useState(false);
  const hasMood = stable !== null;
  useEffect(() => {
    if (!hasMood) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [hasMood]);
  const bundle = useBlendedBundle(target, hasMood && settled);

  const value = useMemo<Theme>(() => buildTheme(bundle, stable, reduceMotion), [bundle, stable, reduceMotion]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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

export function useTheme(): Theme {
  const t = useContext(Ctx);
  if (!t) throw new Error('useTheme outside ThemeProvider');
  return t;
}

/** The theme, or null outside a ThemeProvider (the driving screen renders with or without one). */
export function useOptionalTheme(): Theme | null {
  return useContext(Ctx);
}
