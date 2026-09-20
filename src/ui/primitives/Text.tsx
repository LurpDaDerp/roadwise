import { Text as RNText, useWindowDimensions, type TextProps, type TextStyle } from 'react-native';

import { useTheme } from '../theme';
import type { TypeScale } from '../tokens';

type Tone = 'default' | 'muted' | 'subtle' | 'inverse' | 'accent' | 'danger';

/**
 * Every string in the app goes through here. Dynamic Type is applied by hand and capped at 2.0 so
 * the HUD and the card fields cannot be scaled into an unreadable layout. The scale comes from
 * `useWindowDimensions`, not a render-time `PixelRatio` read, so changing system text size while
 * the app is open re-renders at the new size.
 */
export function Text({
  variant = 'body',
  tone = 'default',
  style,
  ...rest
}: TextProps & { variant?: keyof TypeScale; tone?: Tone }) {
  const t = useTheme();
  const s = t.type[variant];
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const color = {
    default: t.colors.text,
    muted: t.colors.textMuted,
    subtle: t.colors.textSubtle,
    inverse: t.colors.textInverse,
    accent: t.colors.accent,
    danger: t.colors.danger,
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
  };

  return <RNText allowFontScaling={false} {...rest} style={[base, style]} />;
}
