import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import { Section, TopBar } from '@/features/settings/parts';
import { Banner, Card, Screen, Skeleton, Text, useTheme } from '@/ui';

import { fixFor, overall, settingsRows } from './board';
import { permissionsCopy as copy, requestLabel, rowDetail, rowTitle, statusWord, type CopyCtx } from './copy';
import { HealthRow } from './HealthRow';
import type { PermissionId } from './registry';
import { usePermissionBoard, type PermissionBoardDeps } from './usePermissionBoard';

/**
 * `/settings/permissions`: every permission RoadWise uses on this phone, in Home's order, each with
 * its state, what it means, and its fix (the phone's prompt while it can still ask, otherwise its
 * Settings page; Bluetooth and the camera only Settings). A permission hidden from Home offers Show
 * on Home. A fix is the driver's own tap, so it goes to the phone directly; back from Settings, the
 * phone is read again.
 */
export function PermissionsScreen({ deps = {} }: { deps?: PermissionBoardDeps }) {
  const th = useTheme();
  const board = usePermissionBoard(deps);
  const [busy, setBusy] = useState<PermissionId | null>(null);
  const [failed, setFailed] = useState(false);

  const onFix = async (id: PermissionId) => {
    if (busy) return;
    setBusy(id);
    setFailed(false);
    try {
      await board.fix(id, { markReturn: true });
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const onShow = async (id: PermissionId) => {
    setFailed(false);
    try {
      await board.show(id);
    } catch {
      setFailed(true);
    }
  };

  let body;
  if (board.status === 'loading') {
    body = (
      <Card accessibilityLabel={copy.loading}>
        <Skeleton width="60%" height={18} />
        <Skeleton width="90%" height={14} />
      </Card>
    );
  } else if (board.status === 'error' || board.read === null) {
    body = (
      <Banner
        tone="danger"
        message={copy.readError}
        action={{ label: copy.retry, onPress: () => void board.refresh('fresh') }}
        testID="permissions-read-error"
      />
    );
  } else {
    const read = board.read;
    const ctx: CopyCtx = { platform: read.snapshot.platform, androidApi: read.androidApi };
    const rows = settingsRows(read, board.prefs);
    body = (
      <>
        <Text variant="title3" testID="permissions-summary">
          {copy.summary[overall(rows)]}
        </Text>
        <Section testID="permissions-rows">
          {rows.map((r) => {
            const fix = fixFor(r.id, r.state, board.prefs);
            const label = fix === null || r.state.kind !== 'missing' ? null : fix === 'request' ? requestLabel(r.id, r.state) : copy.openSettings;
            return (
              <HealthRow
                key={r.id}
                testID={`permission-${r.id}`}
                title={rowTitle(r.id, ctx)}
                word={statusWord(r.state)}
                required={r.def.need === 'required'}
                detail={rowDetail(r.id, r.state, ctx)}
                fixLabel={label}
                busy={busy === r.id}
                onFix={() => void onFix(r.id)}
                hiddenFromHome={r.hiddenFromHome}
                onShowOnHome={() => void onShow(r.id)}
              />
            );
          })}
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
          {copy.about[(board.read?.snapshot.platform ?? Platform.OS) === 'ios' ? 'ios' : 'android']}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: th.space.sm, alignItems: 'flex-start' }} testID="permissions-phone-note">
        <Ionicons name="phone-portrait-outline" size={th.size.icon} color={th.colors.textMuted} />
        <Text variant="footnote" tone="muted" style={{ flex: 1 }}>
          {copy.phone}
        </Text>
      </View>
    </Screen>
  );
}
