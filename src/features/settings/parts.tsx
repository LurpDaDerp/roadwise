import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Children, type ComponentProps, type ReactNode } from 'react';
import { View } from 'react-native';

import { HOME_HREF } from '@/features/drives/routes';
import { Card, Divider, IconButton, ListRow, Text, useFontScale, useTheme } from '@/ui';

/** Back where there is a screen to go back to; Home when this one is all there is. */
export function backOrHome(router: Pick<ReturnType<typeof useRouter>, 'canGoBack' | 'back' | 'replace'>): void {
  if (router.canGoBack()) router.back();
  else router.replace(HOME_HREF);
}

type IconName = ComponentProps<typeof Ionicons>['name'];

/**
 * The header every screen outside the tabs prints for itself (`app/(app)/_layout.tsx` is a
 * headerless stack): Back, the screen's title as its heading, and an optional trailing control.
 * Back always shows: with nowhere to go back to (a link that opened RoadWise straight onto this
 * screen, or the one onboarding finished on) it goes Home, so no screen is a dead end.
 */
export function TopBar({ title, trailing, testID }: { title: string; trailing?: ReactNode; testID?: string }) {
  const th = useTheme();
  const router = useRouter();
  return (
    <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md, minHeight: th.size.touch }}>
      <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={() => backOrHome(router)} variant="surface" testID="top-bar-back" />
      <Text variant="title2" accessibilityRole="header" style={{ flex: 1 }}>
        {title}
      </Text>
      {trailing}
    </View>
  );
}

/** A group of rows on one card, with an optional heading above it and hairlines between rows. */
export function Section({
  title,
  footer,
  children,
  testID,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
  testID?: string;
}) {
  const th = useTheme();
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={{ gap: th.space.sm }}>
      {title ? (
        <Text variant="headline" accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      <Card padded={false} testID={testID}>
        {rows.map((row, i) => (
          <View key={i}>
            {i > 0 ? <Divider inset={th.space.lg} /> : null}
            {row}
          </View>
        ))}
      </Card>
      {footer ? (
        <Text variant="footnote" tone="muted">
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

/** A tinted icon in a soft square, the leading mark of a navigation row. */
export function RowIcon({ name, tone = 'accent' }: { name: IconName; tone?: 'accent' | 'danger' }) {
  const th = useTheme();
  const scale = useFontScale();
  const box = Math.round(32 * Math.min(scale, 1.4));
  return (
    <View
      style={{
        width: box,
        height: box,
        borderRadius: box / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tone === 'danger' ? th.colors.dangerFaint : th.colors.accentFaint,
      }}
    >
      <Ionicons name={name} size={th.size.icon} color={tone === 'danger' ? th.colors.danger : th.colors.accent} />
    </View>
  );
}

/** A row that opens another screen. */
export function LinkRow({
  icon,
  title,
  subtitle,
  trailing,
  onPress,
  testID,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <ListRow
      testID={testID}
      title={title}
      subtitle={subtitle}
      leading={<RowIcon name={icon} />}
      trailing={trailing}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      onPress={onPress}
    />
  );
}
