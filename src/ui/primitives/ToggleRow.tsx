import { Ionicons } from '@expo/vector-icons';
import { Pressable, Switch, View } from 'react-native';

import { useTheme } from '../theme';
import type { IconName } from './Button';
import { Text } from './Text';

export type ToggleRowProps = {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  icon?: IconName;
  disabled?: boolean;
  testID?: string;
};

/**
 * A settings row with the platform switch. Tapping anywhere on the row flips it; the switch keeps
 * its native look (gold track when on) and is the one element VoiceOver lands on.
 */
export function ToggleRow({
  title,
  subtitle,
  value,
  onValueChange,
  icon,
  disabled,
  testID,
}: ToggleRowProps) {
  const t = useTheme();
  return (
    <Pressable
      accessible={false}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={({ pressed }) => ({
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.space.md,
        paddingVertical: t.space.md,
        paddingHorizontal: t.space.lg,
        backgroundColor: pressed ? t.colors.surfaceRaised : 'transparent',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {icon ? <Ionicons name={icon} size={t.size.icon} color={t.colors.accent} /> : null}
      <View
        style={{ flex: 1, gap: 2 }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text variant="body">{title}</Text>
        {subtitle ? (
          <Text variant="footnote" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Switch
        testID={testID}
        accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ true: t.colors.primary, false: t.colors.border }}
        ios_backgroundColor={t.colors.border}
        thumbColor="#FFFFFF"
      />
    </Pressable>
  );
}
