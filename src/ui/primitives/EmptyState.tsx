import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useTheme } from '../theme';
import { Button } from './Button';
import { Text } from './Text';

type Props = {
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
  illustration?: ReactNode;
  testID?: string;
};

/** A blank field on the record: says what is missing and how to fill it. */
export function EmptyState({ title, body, action, illustration, testID }: Props) {
  const t = useTheme();

  return (
    <View
      testID={testID}
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        gap: t.space.md,
        paddingHorizontal: t.space.xl,
        paddingVertical: t.space.xxl,
      }}
    >
      {illustration ? <View>{illustration}</View> : null}
      <Text variant="title3" style={{ textAlign: 'center' }}>
        {title}
      </Text>
      <Text variant="subhead" tone="muted" style={{ textAlign: 'center' }}>
        {body}
      </Text>
      {action ? (
        <Button label={action.label} onPress={action.onPress} variant="secondary" size="md" />
      ) : null}
    </View>
  );
}
