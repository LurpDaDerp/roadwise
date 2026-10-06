import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';

import { tokens, type ColorSet, type Elevation, type HudSet, type TypeScale } from './tokens';

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
  const [osStill, setReduceMotion] = useState(false);
  const reduceMotion = forcedStill ?? osStill;

  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (live) setReduceMotion(on);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

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
