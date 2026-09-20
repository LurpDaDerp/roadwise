import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

type Props = {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  accessory?: 'chevron' | 'none';
  /**
   * What the row says instead of "title, subtitle". Needed when `leading` carries meaning of its
   * own — a score, a count — which the row's own label would otherwise silence, since a label on
   * the pressable replaces everything inside it.
   */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
};

/**
 * A ruled row on the licence record. Built from `Pressable` rather than `@expo/ui`'s `ListItem`:
 * that one is a SwiftUI/Compose host view, so under Jest nothing it renders is queryable or
 * pressable, and its prop shape has no `accessory` or plain `subtitle` to map onto.
 */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  accessory = 'chevron',
  accessibilityLabel,
  accessibilityHint,
  testID,
}: Props) {
  const t = useTheme();
  const showChevron = accessory === 'chevron' && !!onPress && !trailing;

  const row: ViewStyle = {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space.md,
    paddingVertical: t.space.md,
    paddingHorizontal: t.space.lg,
  };

  const body = (
    <>
      {leading ? <View>{leading}</View> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body">{title}</Text>
        {subtitle ? (
          <Text variant="footnote" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ? <View>{trailing}</View> : null}
      {showChevron ? (
        <Ionicons name="chevron-forward" size={18} color={t.colors.textSubtle} />
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <View testID={testID} style={row}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [
        row,
        { backgroundColor: pressed ? t.colors.surfaceRaised : 'transparent' },
      ]}
    >
      {body}
    </Pressable>
  );
}
