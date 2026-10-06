import { Screen, Text } from '@/ui';

/**
 * A route that a later work package fills in. It only names the screen, so a route file can swap
 * it for the real screen without touching anything else.
 */
export function PlaceholderScreen({ title, inTabs = false }: { title: string; inTabs?: boolean }) {
  return (
    <Screen bottomInset={!inTabs} testID="placeholder-screen">
      <Text variant="title2" accessibilityRole="header">
        {title}
      </Text>
    </Screen>
  );
}
