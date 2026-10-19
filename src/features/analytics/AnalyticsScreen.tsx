import { Screen, Text } from '@/ui';

/** The Analytics tab. A placeholder until the radar, metrics and trip map land. */
export function AnalyticsScreen() {
  return (
    <Screen sky scroll bottomInset={false} testID="analytics-screen">
      <Text variant="title1" accessibilityRole="header">
        Analytics
      </Text>
    </Screen>
  );
}
