import { Ionicons } from '@expo/vector-icons';
import { Children, type ComponentProps, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { ICON } from '@/features/trips/layout';
import { Card, ListRow, Text, useTheme } from '@/ui';

/** A small-caps field label over its group, as H6 prints them. */
export function FieldLabel({ children }: { children: string }) {
  return (
    <Text variant="caption" tone="muted" accessibilityRole="header" style={{ textTransform: 'uppercase', letterSpacing: 1.2 }}>
      {children}
    </Text>
  );
}

/** A labelled group of rows on one card, ruled between rows. */
export function Section({ label, children, testID }: { label?: string; children: ReactNode; testID?: string }) {
  const th = useTheme();
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={{ gap: th.space.sm }}>
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <Card padded={false} testID={testID}>
        {rows.map((row, i) => (
          <View key={i} style={{ borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: th.colors.divider }}>
            {row}
          </View>
        ))}
      </Card>
    </View>
  );
}

/** A row that opens another screen: an icon in the ID blue, its title and what it holds. */
export function LinkRow({
  icon,
  title,
  subtitle,
  hint,
  onPress,
  testID,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  title: string;
  subtitle?: string;
  hint: string;
  onPress: () => void;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <ListRow
      testID={testID}
      title={title}
      subtitle={subtitle}
      leading={<Ionicons name={icon} size={ICON.lg} color={th.colors.accent} />}
      accessibilityHint={hint}
      onPress={onPress}
    />
  );
}
