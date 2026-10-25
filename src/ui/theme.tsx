import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, StyleSheet, useColorScheme, View } from 'react-native';
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

/** How long a change of sky takes to fade in (light ⇄ dark included). */
export const SKY_BLEND_MS = 2400;
/** The first sky after launch lands at once (it is behind the splash); later changes fade. */
const SETTLE_MS = 1500;
/** A snapshot that is not back in this long is given up on: the new sky lands at once. */
const CAPTURE_TIMEOUT_MS = 600;
/** An image that has not loaded in this long is given up on the same way. */
const VEIL_LOAD_TIMEOUT_MS = 1000;

/** The screen as it is now, as an image file's uri, or null when it cannot be taken (no native support, a timeout). */
type Capture = () => Promise<string | null>;

type Veil = { uri: string; target: SkyBundle };

/**
 * `target`, reached by one switch under a fading snapshot of the screen as it was, so a change of
 * sky costs a single render of the app instead of a repaint of every themed view at 20 Hz for
 * seconds (which stalled the JS thread and every touch with it). The old look is captured as an
 * image, laid over the screen, the new look is applied in that one render, and the image fades out
 * on the native side without the JS thread. Anything that keeps the snapshot from coming (no native
 * module, a slow capture, an image that will not load) lands the new look at once instead. A new
 * target mid-fade drops the snapshot and starts over from what is on screen.
 */
export function useVeiledBundle(target: SkyBundle, animate: boolean, capture: Capture): { bundle: SkyBundle; veil: ReactNode } {
  const [shown, setShown] = useState(target);
  const [prev, setPrev] = useState(target);
  const [veil, setVeil] = useState<Veil | null>(null);
  // A change that is not to be faded lands in the same render (React's "adjust state when a prop
  // changes" pattern), so a pinned scheme never shows a stale frame; any fade in flight is dropped.
  if (prev !== target) {
    setPrev(target);
    if (veil !== null) setVeil(null);
    if (!animate) setShown(target);
  }
  // The snapshot of the look on screen, taken before anything changes.
  useEffect(() => {
    if (!animate || shown === target) return;
    let live = true;
    capture().then(
      (uri) => {
        if (!live) return;
        if (uri === null) setShown(target);
        else setVeil({ uri, target });
      },
      () => {
        if (live) setShown(target);
      }
    );
    return () => {
      live = false;
    };
  }, [animate, shown, target, capture]);
  // The snapshot is up and drawn (or it failed to be): the new look goes in underneath it.
  const landed = veil !== null && veil.target === shown;
  const waiting = veil !== null && !landed;
  useEffect(() => {
    if (!waiting || veil === null) return;
    const timer = setTimeout(() => setShown(veil.target), VEIL_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waiting, veil]);
  const lands = useCallback(() => {
    if (veil !== null) setShown(veil.target);
  }, [veil]);
  const gone = useCallback(() => setVeil(null), []);
  return {
    bundle: shown,
    veil: veil === null ? null : <ThemeVeil key={veil.uri} uri={veil.uri} landed={landed} onLoad={lands} onDone={gone} />,
  };
}

/** The old screen over the new one, fading out natively once the new look is in. */
function ThemeVeil({ uri, landed, onLoad, onDone }: { uri: string; landed: boolean; onLoad: () => void; onDone: () => void }) {
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!landed) return;
    const fade = Animated.timing(opacity, { toValue: 0, duration: SKY_BLEND_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: true });
    fade.start(({ finished }) => {
      if (finished) onDone();
    });
    return () => fade.stop();
  }, [landed, opacity, onDone]);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { opacity }]}
    >
      <Image testID="theme-veil" source={{ uri }} resizeMode="stretch" fadeDuration={0} onLoad={onLoad} onError={onLoad} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

/** The root's snapshot through react-native-view-shot, loaded on first use so a missing native module only costs the fade. */
function snapshotOf(view: View | null): Promise<string | null> {
  if (view === null) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
    const done = (uri: string | null) => {
      clearTimeout(timer);
      resolve(uri);
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
      const { captureRef } = require('react-native-view-shot') as typeof import('react-native-view-shot');
      captureRef(view, { format: 'jpg', quality: 0.8, result: 'tmpfile' }).then(
        (uri) => done(typeof uri === 'string' && uri.length > 0 ? (uri.startsWith('/') ? `file://${uri}` : uri) : null),
        () => done(null)
      );
    } catch {
      done(null);
    }
  });
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
 * sky and every change of sky fades in over a couple of seconds, light ⇄ dark included (a snapshot
 * of the old look fades out over the new one: `useVeiledBundle`). Without
 * one it is the static look (`plainBundle`) for the pinned scheme (Light, Dark, tests, the gallery)
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

  const target = useMemo(() => (stable ? skyBundle(stable) : plainBundle(plainScheme)), [stable, plainScheme]);
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
  const rootRef = useRef<View>(null);
  const capture = useCallback(() => snapshotOf(rootRef.current), []);
  const { bundle, veil } = useVeiledBundle(target, hasMood && settled && !reduceMotion, capture);

  const value = useMemo<Theme>(
    () => buildTheme(bundle, stable, hudNight, reduceMotion),
    [bundle, stable, hudNight, reduceMotion]
  );

  return (
    <Ctx.Provider value={value}>
      <View ref={rootRef} collapsable={false} style={{ flex: 1 }}>
        {children}
      </View>
      {veil}
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

export function useTheme(): Theme {
  const t = useContext(Ctx);
  if (!t) throw new Error('useTheme outside ThemeProvider');
  return t;
}

/** The theme, or null outside a ThemeProvider (the driving screen renders with or without one). */
export function useOptionalTheme(): Theme | null {
  return useContext(Ctx);
}
