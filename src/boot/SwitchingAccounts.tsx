import { ActivityIndicator, View } from 'react-native';

import { Screen, Text, useTheme } from '@/ui';

export const switchingCopy = {
  title: 'Setting this phone up for you',
  body: 'The last driver signed out, so their drives are being cleared.',
} as const;

/**
 * Between two runtimes: the previous driver's cache and database handle have left the tree and
 * the new launch has not finished. It holds the screen for the moment a wipe takes, and it says
 * what is happening rather than showing a blank — a handover is a normal event on a phone shared
 * by a parent and a new driver, not an error.
 */
export function SwitchingAccounts() {
  const th = useTheme();
  return (
    <Screen>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={switchingCopy.title}
        accessibilityLiveRegion="polite"
        style={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: th.space.md }}
      >
        <ActivityIndicator color={th.colors.accent} />
        <Text variant="headline">{switchingCopy.title}</Text>
        <Text variant="subhead" tone="muted" style={{ textAlign: 'center' }}>
          {switchingCopy.body}
        </Text>
      </View>
    </Screen>
  );
}
