import { Ionicons } from '@expo/vector-icons';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import type { IconName } from './Button';

export type IconButtonProps = {
  icon: IconName;
  /** Required: an icon-only control has nothing else to speak. */
  accessibilityLabel: string;
  onPress: () => void;
  /**
   * `plain` bare glyph · `tinted` faint accent disc · `filled` ink disc (paper in dark) ·
   * `surface` a raised paper disc with a soft shadow (back, close, share over a page or a scene).
   * Default `plain`.
   */
  variant?: 'plain' | 'tinted' | 'filled' | 'surface';
  /** Visual diameter; the touch target never drops below 44. Default 44. */
  size?: number;
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  variant = 'plain',
  size = 44,
  disabled,
  accessibilityHint,
  style,
  testID,
}: IconButtonProps) {
  const t = useTheme();
  const c = t.colors;
  const fg = variant === 'filled' ? c.onPrimary : variant === 'surface' ? c.text : c.accent;
  const bg = { filled: c.primary, tinted: c.accentFaint, surface: c.surface, plain: 'transparent' }[variant];
  const slop = Math.max(0, (t.size.touch - size) / 2);

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={slop}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          borderWidth: variant === 'surface' && t.scheme === 'dark' ? 1 : 0,
          borderColor: c.border,
          boxShadow: variant === 'surface' ? t.elevation.card : undefined,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
          transform: [{ scale: pressed && !disabled ? 0.94 : 1 }],
        },
        style,
      ]}
    >
      <Ionicons name={icon} size={Math.round(size * 0.5)} color={fg} />
    </Pressable>
  );
}
