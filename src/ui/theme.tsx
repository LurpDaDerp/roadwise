import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import * as Reanimated from 'react-native-reanimated';

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

export function ThemeProvider({
  children,
  scheme: forced,
  reduceMotion: forcedStill,
}: {
  children: ReactNode;
  /** Pin a scheme (the dev gallery renders both side by side). Defaults to the system's. */
  scheme?: 'light' | 'dark';
  /** Pin reduce motion (tests, gallery). Defaults to the OS accessibility setting. */
  reduceMotion?: boolean;
}) {
  const system = useColorScheme();
  const scheme = forced ?? (system === 'dark' ? 'dark' : 'light');
  // Reanimated reads the setting synchronously, so the first frame after launch already knows;
  // the AccessibilityInfo subscription keeps it current.
  const osStill = useOsReduceMotion();
  const reduceMotion = forcedStill ?? osStill;

  const value = useMemo<Theme>(
    () => ({
      scheme,
      colors: tokens.color[scheme],
      hud: tokens.color.hud,
      type: tokens.type,
      elevation: tokens.elevation[scheme],
      size: tokens.size,
      space: tokens.space,
      radius: tokens.radius,
      motion: tokens.motion,
      reduceMotion,
    }),
    [scheme, reduceMotion]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(Ctx);
  if (!t) throw new Error('useTheme outside ThemeProvider');
  return t;
}
