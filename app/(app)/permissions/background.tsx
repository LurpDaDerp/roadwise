import { useLocalSearchParams, useRouter, type Href } from 'expo-router';

import { BackgroundDisclosure, parseDisclosureReason } from '@/features/permissions';
import { Screen } from '@/ui';

const HOME = '/(tabs)/home' as Href;

/**
 * `/permissions/background?reason=first-drive|third-drive|repair` — the prominent disclosure for
 * background location, reached from the post-drive offers and from B2's Fix. Every entry here is
 * about auto-record, so Continue also records that the driver wants it on. Whatever the answer,
 * the screen goes back to where the driver came from.
 */
export default function BackgroundDisclosureRoute() {
  const router = useRouter();
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  const done = () => {
    if (router.canGoBack()) router.back();
    else router.replace(HOME);
  };
  return (
    <Screen scroll testID="background-disclosure-screen">
      <BackgroundDisclosure reason={parseDisclosureReason(reason)} enableAutoRecord onResult={done} />
    </Screen>
  );
}
