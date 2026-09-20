import { View } from 'react-native';

import { t } from '@/i18n';
import { Banner, Button, Screen, Text } from '@/ui';

export const bootstrapCopy = {
  title: "Couldn't open your drives",
  body: 'Try again. If it keeps happening, restart your phone.',
  retrying: 'Opening your drives…',
} as const;

/**
 * The launch's one error state (§7.0: inline, plain language, with retry). The database did not
 * open, migrate or recover, so no screen can read anything; the driver is told that in words and
 * given the one thing they can do. The failure itself is in the log, not on the screen.
 *
 * While the retry is in flight the control stays where it was — loading, not gone — and a live
 * region says so, because a screen that answers a press by removing its only button reads as
 * broken rather than busy.
 */
export function BootstrapFailed({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <Screen>
      <Text variant="title2" accessibilityRole="header">
        {bootstrapCopy.title}
      </Text>
      <Banner tone="danger" message={bootstrapCopy.body} />
      {retrying ? (
        <Text variant="footnote" tone="muted" accessibilityLiveRegion="polite">
          {bootstrapCopy.retrying}
        </Text>
      ) : null}
      <View style={{ flexGrow: 1 }} />
      <Button
        label={t('common.retry')}
        onPress={onRetry}
        loading={retrying}
        disabled={retrying}
        testID="bootstrap-retry"
      />
    </Screen>
  );
}
