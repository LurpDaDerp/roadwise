import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';

import { tokens, type ColorSet, type HudSet, type TypeScale } from './tokens';

type Theme = {
  scheme: 'light' | 'dark';
  colors: ColorSet;
  hud: HudSet;
  type: TypeScale;
  space: typeof tokens.space;
  radius: typeof tokens.radius;
  motion: typeof tokens.motion;
  reduceMotion: boolean;
};

const Ctx = createContext<Theme | null>(null);

export function ThemeProvider({
  children,
  scheme: forced,
}: {
  children: ReactNode;
  scheme?: 'light' | 'dark';
}) {
  const system = useColorScheme();
  const scheme = forced ?? (system === 'dark' ? 'dark' : 'light');
  const [reduceMotion, setReduceMotion] = useState(false);

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
