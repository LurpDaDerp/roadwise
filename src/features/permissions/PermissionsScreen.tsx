import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { recordPrompt } from '@/core/permissions';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { Section, TopBar } from '@/features/settings/parts';
import { Banner, Card, Screen, Skeleton, Text, useTheme } from '@/ui';

import { permissionsCopy as copy, rowDetail, rowTitle } from './copy';
import type { Fix } from './health';
import { HealthRow } from './HealthRow';
import {
  defaultPermissionsAdapter,
  markSettingsReturn,
  usePermissionHealth,
  type PermissionHealthDeps,
} from './usePermissionHealth';

/**
 * `/settings/permissions`: location (While Using only), precise location, motion and
 * notifications, each with what it means for a drive and one Fix. A Fix is the driver's own tap,
 * so it goes to the OS directly; back from Settings, the phone is read again.
 */
export function PermissionsScreen({ deps = {} }: { deps?: PermissionHealthDeps & { now?: () => number } }) {
  const th = useTheme();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const adapter = deps.adapter ?? defaultPermissionsAdapter();
  const health = usePermissionHealth({ ...deps, adapter });
  const [busy, setBusy] = useState<Fix | null>(null);
  const [failed, setFailed] = useState(false);
  const now = deps.now ?? Date.now;

  const onFix = async (fix: Fix) => {
    if (busy) return;
    setBusy(fix);
    setFailed(false);
    try {
      if (fix === 'openSettings') {
        await markSettingsReturn(settings, now());
        await adapter.openAppSettings();
      } else if (fix === 'requestLocation') {
        await adapter.requestLocationForeground();
        await recordPrompt(settings, 'location', now()).catch(() => {});
      } else if (fix === 'requestMotion') {
        await adapter.requestMotion();
        await recordPrompt(settings, 'motion', now()).catch(() => {});
      } else {
        await adapter.requestNotifications();
        await recordPrompt(settings, 'notifications', now()).catch(() => {});
      }
      await health.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  let body;
  if (health.status === 'loading') {
    body = (
      <Card accessibilityLabel={copy.loading}>
        <Skeleton width="60%" height={18} />
        <Skeleton width="90%" height={14} />
      </Card>
    );
  } else if (health.status === 'error') {
    body = (
      <Banner
        tone="danger"
        message={copy.readError}
        action={{ label: copy.retry, onPress: () => void health.refresh() }}
        testID="permissions-read-error"
      />
    );
  } else {
    const platform = health.snapshot.platform;
    body = (
      <>
        <Text variant="title3" testID="permissions-summary">
          {copy.summary[health.overall]}
        </Text>
        <Section testID="permissions-rows">
          {health.rows.map((r) => (
            <HealthRow
              key={r.id}
              testID={`permission-${r.id}`}
              title={rowTitle(r.id, platform)}
              status={r.status}
              detail={rowDetail(r.id, r.status)}
              fix={r.fix}
              busy={busy === r.fix}
              onFix={(f) => void onFix(f)}
            />
          ))}
        </Section>
      </>
    );
  }

  return (
    <Screen scroll testID="permissions-screen">
      <TopBar title={copy.title} />
      {failed ? <Banner tone="warning" message={copy.actionError} testID="permissions-action-error" /> : null}
      {body}
      <View style={{ flexDirection: 'row', gap: th.space.sm, alignItems: 'flex-start' }}>
        <Ionicons name="lock-closed-outline" size={th.size.icon} color={th.colors.textMuted} />
        <Text variant="footnote" tone="muted" style={{ flex: 1 }}>
          {copy.never}
        </Text>
      </View>
    </Screen>
  );
}
