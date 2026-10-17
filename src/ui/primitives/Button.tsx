import { Ionicons } from '@expo/vector-icons';
import { isValidElement, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export type IconName = keyof typeof Ionicons.glyphMap;
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'hud';

export type ButtonProps = {
  label: string;
  onPress: () => void;
  /** `primary` is the ink capsule (paper in dark), the one thing to do next on a screen. Default `primary`. */
  variant?: ButtonVariant;
  /** sm 36 (+hit slop to 44) · md 48 · lg 56 · hud 64. Default `lg`. */
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  /** An Ionicons name, or any node, drawn before the label. */
  icon?: IconName | ReactNode;
  /** Layout only (margins, alignSelf, flex). Merged last. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityHint?: PressableProps['accessibilityHint'];
};

export const BUTTON_MIN_HEIGHT = { sm: 36, md: 48, lg: 56, hud: 64 } as const;

/** A capsule. Ink for the one thing to do next; quieter variants for everything else. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  loading,
  disabled,
  icon,
  style,
  testID,
  accessibilityHint,
}: ButtonProps) {
  const t = useTheme();
  const c = t.colors;
  const fg = {
    primary: c.onPrimary,
    secondary: c.text,
    ghost: c.accent,
    destructive: c.textInverse,
  }[variant];
  const minHeight = BUTTON_MIN_HEIGHT[size];
  const inactive = !!disabled || !!loading;
  const iconSize = size === 'sm' ? t.size.iconSm : size === 'hud' ? t.size.iconLg : t.size.icon;

  const glyph =
    typeof icon === 'string' ? (
      <Ionicons name={icon as IconName} size={iconSize} color={fg} />
    ) : isValidElement(icon) ? (
      icon
    ) : null;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      // `sm` draws at 36 pt; the slop takes its touch target to the 44 pt floor.
      hitSlop={size === 'sm' ? 4 : t.space.xs}
      style={({ pressed }) => [
        {
          minHeight,
          borderRadius: t.radius.pill,
          borderCurve: 'continuous',
          backgroundColor: {
            primary: pressed ? c.primaryPressed : c.primary,
            secondary: pressed ? c.surfaceRaised : c.surface,
            ghost: pressed ? c.accentFaint : 'transparent',
            destructive: c.danger,
          }[variant],
          // `secondary` is a paper capsule, all but invisible on paper, so a hairline rule that
          // clears 3:1 on the background is what makes it a button at all.
          borderWidth: variant === 'secondary' ? 1 : 0,
          borderColor: c.borderStrong,
          opacity: inactive ? 0.5 : 1,
          transform: [{ scale: pressed && !inactive ? 0.97 : 1 }],
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          paddingHorizontal: size === 'sm' ? t.space.md : t.space.xl,
          gap: t.space.sm,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {glyph ? <View>{glyph}</View> : null}
          <Text
            variant={size === 'hud' ? 'title2' : size === 'sm' ? 'subhead' : 'headline'}
            style={size === 'sm' ? { color: fg, fontWeight: '600' } : { color: fg }}
            numberOfLines={2}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}
