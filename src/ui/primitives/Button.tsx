import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, View, type PressableProps } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

type Props = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  size?: 'md' | 'lg' | 'hud';
  loading?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  testID?: string;
  accessibilityHint?: PressableProps['accessibilityHint'];
};

const MIN_HEIGHT = { md: 44, lg: 52, hud: 64 } as const;

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  loading,
  disabled,
  icon,
  testID,
  accessibilityHint,
}: Props) {
  const t = useTheme();
  const bg = {
    primary: t.colors.accent,
    secondary: t.colors.surfaceRaised,
    ghost: 'transparent',
    destructive: t.colors.danger,
  }[variant];
  const fg = {
    primary: t.colors.accentText,
    secondary: t.colors.text,
    ghost: t.colors.accent,
    destructive: t.colors.textInverse,
  }[variant];
  const minHeight = MIN_HEIGHT[size];
  const inactive = !!disabled || !!loading;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      hitSlop={t.space.xs}
      style={({ pressed }) => ({
        minHeight,
        borderRadius: t.radius.md,
        backgroundColor: bg,
        // `secondary` fills with `surfaceRaised`, which is all but invisible against `bg`, so the
        // border is what makes it a button at all: 1.5 pt of ink that clears 3:1 on the background.
        borderWidth: variant === 'secondary' ? 1.5 : 0,
        borderColor: t.colors.borderStrong,
        opacity: inactive ? 0.6 : pressed ? 0.85 : 1,
        transform: [{ scale: pressed && !inactive ? 0.98 : 1 }],
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        paddingHorizontal: t.space.lg,
        gap: t.space.sm,
      })}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <View>{icon}</View> : null}
          <Text variant={size === 'hud' ? 'title2' : 'headline'} style={{ color: fg }}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}
