import { PixelRatio, Text as RNText, type TextProps } from 'react-native';

import { useTheme } from '../theme';
import type { TypeScale } from '../tokens';

type Tone = 'default' | 'muted' | 'subtle' | 'inverse' | 'accent' | 'danger';

/**
 * Every string in the app goes through here. Dynamic Type is applied by hand and capped at 2.0 so
 * the HUD and the card fields cannot be scaled into an unreadable layout.
 */
export function Text({
  variant = 'body',
  tone = 'default',
  style,
  ...rest
}: TextProps & { variant?: keyof TypeScale; tone?: Tone }) {
  const t = useTheme();
  const s = t.type[variant];
  const scale = Math.min(PixelRatio.getFontScale(), 2);
  const color = {
    default: t.colors.text,
    muted: t.colors.textMuted,
    subtle: t.colors.textSubtle,
    inverse: t.colors.textInverse,
    accent: t.colors.accent,
    danger: t.colors.danger,
  }[tone];

  return (
    <RNText
      allowFontScaling={false}
      {...rest}
      style={[
        {
          fontFamily: s.fontFamily,
          fontSize: s.fontSize * scale,
          lineHeight: s.lineHeight * scale,
          fontWeight: s.fontWeight,
          letterSpacing: s.letterSpacing,
          fontVariant: s.fontVariant,
          color,
        },
        style,
      ]}
    />
  );
}
