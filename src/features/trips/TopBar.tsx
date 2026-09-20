import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';

import { Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';
import { ICON, TOUCH } from './layout';

/**
 * The header every trip screen prints for itself (`app/(app)/_layout.tsx` is a headerless
 * `Stack`): Back on the left, the screen's own title beside it as the page heading, and whatever
 * the screen wants on the right.
 *
 * Back is omitted rather than disabled when there is nowhere to go — a deep link straight into a
 * drive — so the rotor never meets a dead control.
 */
export function TripTopBar({
  title,
  onBack,
  trailing,
  testID,
}: {
  title: string;
  onBack: (() => void) | null;
  trailing?: React.ReactNode;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.sm,
        minHeight: TOUCH,
      }}
    >
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.back}
          onPress={onBack}
          hitSlop={th.space.sm}
          style={({ pressed }) => ({
            minWidth: TOUCH,
            minHeight: TOUCH,
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: -th.space.sm,
            borderRadius: th.radius.pill,
            backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
          })}
        >
          <Ionicons name="chevron-back" size={ICON.xl} color={th.colors.accent} />
        </Pressable>
      ) : null}
      <Text variant="title3" accessibilityRole="header" style={{ flex: 1 }}>
        {title}
      </Text>
      {trailing}
    </View>
  );
}
