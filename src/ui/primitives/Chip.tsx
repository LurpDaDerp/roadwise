import { Ionicons } from '@expo/vector-icons';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import type { IconName } from './Button';
import { Text } from './Text';

export type ChipProps = {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Drawn before the label. When selected and no icon is given, a check is drawn instead. */
  icon?: IconName;
  /**
   * `switch` for an on/off setting (VoiceOver says "on"/"off"); `button` (default) for a filter
   * chip (VoiceOver says "selected").
   */
  role?: 'button' | 'switch';
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * A capsule toggle. Selected chips fill with ink (paper in dark) and carry a glyph, so "on" never
 * rides on colour alone. 40 pt tall with hit slop to the 44 pt floor.
 */
export function Chip({
  label,
  selected,
  onPress,
  icon,
  role = 'button',
  disabled,
  accessibilityHint,
  style,
  testID,
}: ChipProps) {
  const t = useTheme();
  const c = t.colors;
  const fg = selected ? c.onPrimary : c.text;
  const glyph: IconName | undefined = icon ?? (selected ? 'checkmark' : undefined);

  return (
    <Pressable
      testID={testID}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={
        role === 'switch' ? { checked: selected, disabled: !!disabled } : { selected, disabled: !!disabled }
      }
      disabled={disabled}
      onPress={onPress}
      hitSlop={2}
      style={({ pressed }) => [
        {
          minHeight: 40,
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: t.space.xs + 2,
          paddingHorizontal: t.space.lg,
          borderRadius: t.radius.pill,
          backgroundColor: selected ? (pressed ? c.primaryPressed : c.primary) : pressed ? c.surfaceRaised : c.surface,
          borderWidth: 1,
          borderColor: selected ? c.primary : c.borderStrong,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      {glyph ? <Ionicons name={glyph} size={t.size.iconSm} color={fg} /> : null}
      <Text variant="subhead" style={{ color: fg, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}
