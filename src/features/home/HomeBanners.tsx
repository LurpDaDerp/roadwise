import { createContext, useContext, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { useOnline } from '@/data/net/useOnline';
import { useHydrationStatus } from '@/data/queries';
import { Banner, useTheme } from '@/ui';

import { homeCopy } from './copy';

const copy = homeCopy.banners;

/**
 * Re-runs the restore now, throttle bypassed: `() => jobs.runNow()` on the `ForegroundJobs` that
 * `startForegroundJobs(runtime)` returned (review D1 M4). The root layout provides it; without a
 * provider the failed banner still says what happened, and the next foreground retries anyway.
 */
export type RestoreRetry = () => Promise<unknown>;

const RestoreRetryContext = createContext<RestoreRetry | null>(null);

export function RestoreRetryProvider({
  retry,
  children,
}: {
  retry: RestoreRetry;
  children: ReactNode;
}) {
  return <RestoreRetryContext.Provider value={retry}>{children}</RestoreRetryContext.Provider>;
}

function RestoreBanner() {
  const status = useHydrationStatus();
  const retry = useContext(RestoreRetryContext);
  const [retrying, setRetrying] = useState(false);

  if (status.state === 'restoring') {
    return <Banner tone="info" message={copy.restoring(status.restored)} testID="banner-restoring" />;
  }
  if (status.state !== 'failed') return null;

  const onRetry = async () => {
    if (!retry || retrying) return;
    setRetrying(true);
    try {
      // `runNow` never rejects, and moves the status store itself (restoring, then idle or failed).
      await retry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Banner
      tone="warning"
      message={copy.failed}
      action={retry && !retrying ? { label: copy.retry, onPress: () => void onRetry() } : undefined}
      testID="banner-restore-failed"
    />
  );
}

/**
 * Home's conditional status banners (§7.B B1 item 2), most urgent first: the drive in progress
 * (U2's banner, which decides for itself whether it shows), offline, and a restore from the
 * server that is running or was cut short. Each says only what the device knows.
 */
export function HomeBanners({ inProgress }: { inProgress?: ReactNode }) {
  const th = useTheme();
  const online = useOnline();

  return (
    <View style={{ gap: th.space.sm }} testID="home-banners">
      {inProgress}
      {online ? null : <Banner tone="info" message={copy.offline} testID="banner-offline" />}
      <RestoreBanner />
    </View>
  );
}
