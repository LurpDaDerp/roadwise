import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useTheme } from '../theme';
import { Button, type IconName } from './Button';
import { Text } from './Text';

export type EmptyStateProps = {
  title: string;
  body: string;
  /** Drawn large on a gold-tinted disc above the title. */
  icon?: IconName;
  /** A primary-gold call to action ("Take your first drive"). */
  action?: { label: string; onPress: () => void };
  /** Anything custom in place of the icon disc. */
  illustration?: ReactNode;
  testID?: string;
};

/** Says what is missing, why it is worth filling, and the one tap that fills it. */
export function EmptyState({ title, body, icon, action, illustration, testID }: EmptyStateProps) {
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
      {illustration ? (
        <View>{illustration}</View>
      ) : icon ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            backgroundColor: t.colors.accentFaint,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: t.space.xs,
          }}
        >
          <Ionicons name={icon} size={36} color={t.scheme === 'dark' ? t.colors.gold : t.colors.accent} />
        </View>
      ) : null}
      <Text variant="title2" style={{ textAlign: 'center' }}>
        {title}
      </Text>
      <Text variant="subhead" tone="muted" style={{ textAlign: 'center', maxWidth: 320 }}>
        {body}
      </Text>
      {action ? (
        <Button
          label={action.label}
          onPress={action.onPress}
          size="md"
          style={{ alignSelf: 'center', marginTop: t.space.sm }}
        />
      ) : null}
    </View>
  );
}
