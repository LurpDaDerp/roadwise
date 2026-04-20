import { useContext, useMemo } from 'react';
import { ThemeContext } from '../context/ThemeContext';
import { tokens, radius, spacing, typography, elevation } from './tokens';

export function useTheme() {
  const { resolvedTheme } = useContext(ThemeContext);
  const isDark = resolvedTheme === 'dark';
  const mode = isDark ? 'dark' : 'light';

  return useMemo(() => ({
    isDark,
    mode,
    colors: tokens[mode],
    palette: tokens.palette,
    radius,
    spacing,
    typography,
    elevation: elevation[mode],
  }), [isDark, mode]);
}
