import { Pressable, View } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export type SectionHeaderProps = {
  title: string;
  /** A trailing link such as "See all". */
  action?: { label: string; onPress: () => void; accessibilityLabel?: string };
  testID?: string;
};

/** A section title in the display face, with an optional trailing link. Marked as a header for VoiceOver. */
export function SectionHeader({ title, action, testID }: SectionHeaderProps) {
  const t = useTheme();
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: t.space.md,
        paddingTop: t.space.sm,
      }}
    >
      <Text variant="title3" accessibilityRole="header" style={{ flexShrink: 1 }}>
        {title}
      </Text>
      {action ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={action.accessibilityLabel ?? action.label}
          onPress={action.onPress}
          hitSlop={12}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, minHeight: 24, justifyContent: 'center' })}
        >
          <Text variant="subhead" tone="accent" style={{ fontWeight: '600' }}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
