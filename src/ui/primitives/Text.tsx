import { Text as RNText, useWindowDimensions, type TextProps, type TextStyle } from 'react-native';

import { useTheme } from '../theme';
import type { TypeScale } from '../tokens';

export type TextTone =
  | 'default'
  | 'muted'
  | 'subtle'
  | 'inverse'
  | 'accent'
  | 'danger'
  | 'success'
  | 'warning'
  | 'onPrimary';

/** Dynamic Type follows the system up to this multiple, never past it. */
export const MAX_FONT_SCALE = 2;

/** The current Dynamic Type multiple, capped at {@link MAX_FONT_SCALE}. */
export function useFontScale(cap: number = MAX_FONT_SCALE): number {
  const { fontScale } = useWindowDimensions();
  return Math.min(fontScale, cap);
}

export type AppTextProps = TextProps & { variant?: keyof TypeScale; tone?: TextTone };

/**
 * Every string in the app goes through here. Dynamic Type is applied by hand and capped per style
 * (`maxScale`: hero/display 1.3×, stat 1.5×, everything else 2×) so a layout cannot be scaled past
 * what it was designed for; a 64 pt hero numeral at 2× would not fit a phone. The scale comes from
 * `useWindowDimensions`, not a render-time `PixelRatio` read, so changing system text size while
 * the app is open re-renders at the new size.
 */
export function Text({ variant = 'body', tone = 'default', style, ...rest }: AppTextProps) {
  const t = useTheme();
  const s = t.type[variant];
  const scale = useFontScale(s.maxScale ?? MAX_FONT_SCALE);
  const color = {
    default: t.colors.text,
    muted: t.colors.textMuted,
    subtle: t.colors.textSubtle,
    inverse: t.colors.textInverse,
    accent: t.colors.accent,
    danger: t.colors.danger,
    success: t.colors.success,
    warning: t.colors.warning,
    onPrimary: t.colors.onPrimary,
  }[tone];

  // Spread the optional properties in only when they are set: a bare `fontWeight: undefined` in
  // the style object is enough for a weighted face to pick up a synthetic bold on Android.
  const base: TextStyle = {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize * scale,
    lineHeight: s.lineHeight * scale,
    color,
    ...(s.fontWeight ? { fontWeight: s.fontWeight } : null),
    ...(s.letterSpacing !== undefined ? { letterSpacing: s.letterSpacing } : null),
    ...(s.fontVariant ? { fontVariant: s.fontVariant } : null),
    ...(s.textTransform ? { textTransform: s.textTransform } : null),
  };

  return <RNText allowFontScaling={false} {...rest} style={[base, style]} />;
}
