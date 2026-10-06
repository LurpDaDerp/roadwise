import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export type FreezeCountProps = {
  /** Freezes held. */
  count: number;
  /** Most you can hold. Default 3. */
  max?: number;
  /** Print "2/3" after the flakes. Default false. */
  showNumber?: boolean;
  testID?: string;
};

/** Streak freezes as a row of snowflakes: solid for each one held, outline for each empty slot. */
export function FreezeCount({ count, max = 3, showNumber = false, testID }: FreezeCountProps) {
  const t = useTheme();
  const held = Math.max(0, Math.min(count, max));
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${held} of ${max} ${max === 1 ? 'freeze' : 'freezes'} held`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start' }}
    >
      {Array.from({ length: max }, (_, i) => (
        <Ionicons
          key={i}
          name={i < held ? 'snow' : 'snow-outline'}
          size={t.size.icon}
          color={i < held ? t.colors.freeze : t.colors.textSubtle}
        />
      ))}
      {showNumber ? (
        <Text variant="label" tone="muted" style={{ marginLeft: t.space.xs }}>
          {`${held}/${max}`}
        </Text>
      ) : null}
    </View>
  );
}
