import { t } from '@/i18n';
import { Banner, Screen, Text } from '@/ui';

export const bootstrapCopy = {
  title: "Couldn't open your drives",
  body: 'Try again. If it keeps happening, restart your phone.',
} as const;

/**
 * The launch's one error state (§7.0: inline, plain language, with retry). The database did not
 * open, migrate or recover, so no screen can read anything; the driver is told that in words
 * and given the one thing they can do. The failure itself is in the log, not on the screen.
 */
export function BootstrapFailed({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <Screen>
      <Text variant="title2" accessibilityRole="header">
        {bootstrapCopy.title}
      </Text>
      <Banner
        tone="danger"
        message={bootstrapCopy.body}
        action={retrying ? undefined : { label: t('common.retry'), onPress: onRetry }}
      />
    </Screen>
  );
}
