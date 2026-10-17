import type { ReactNode } from 'react';
import { View } from 'react-native';

import { IconButton, Text, useTheme } from '@/ui';

/** The (app) stack has no native header: each screen prints its title next to its own Back. */
export function BackHeader({
  title,
  onBack,
  trailing,
  subtitle,
}: {
  title: string;
  onBack: () => void;
  trailing?: ReactNode;
  subtitle?: string;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
      <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={onBack} testID="back" variant="surface" />
      <View style={{ flex: 1 }}>
        <Text variant="title2" accessibilityRole="header" numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="subhead" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}
