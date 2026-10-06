// `/settings/dms`: driver monitoring on or off, the calibration, and the plain privacy note. Turning it on asks
// for the camera permission right there (one-line reason), then runs the setup if it never ran, then turns on.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Linking, View } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { isBusyStatus } from '@/drive/policy';
import { useDrive } from '@/drive/useDrive';
import { TopBar } from '@/features/settings/parts';
import { Banner, Button, Card, Divider, Pill, Screen, Text, ToggleRow, useTheme } from '@/ui';

import type { CameraPermission } from './bridge';
import { dmsCopy } from './copy';
import { DMS_SETTING_QUERY_KEY, enableStep, readDmsPrefs, writeDmsEnabled, type DmsPrefs } from './dmsSettings';
import { cameraBridge } from './runtime';
import { DMS_SETUP_HREF } from './routes';

const copy = dmsCopy.settings;

export interface DmsSettingsDeps {
  /** default: the launch's bridge */
  requestPermission?: () => Promise<CameraPermission>;
}

function useDmsPrefs() {
  const db = useDb();
  const query = useQuery<DmsPrefs>({ queryKey: DMS_SETTING_QUERY_KEY, queryFn: () => readDmsPrefs(createSettingsRepo(db)) });
  const { refetch } = query;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch])
  );
  return query;
}

const calibratedLabel = (at: number) => copy.calibratedOn(new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));

export function DmsSettingsScreen({ deps = {} }: { deps?: DmsSettingsDeps }) {
  const th = useTheme();
  const db = useDb();
  const qc = useQueryClient();
  const router = useRouter();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const busy = useDrive((s) => isBusyStatus(s.status));
  const prefs = useDmsPrefs();
  const [notice, setNotice] = useState<'permission' | 'unavailable' | 'save' | null>(null);
  const [asking, setAsking] = useState(false);
  const enabled = prefs.data?.enabled ?? false;
  const calibratedAt = prefs.data?.calibratedAt ?? null;

  const write = useMutation({
    mutationFn: (on: boolean) => writeDmsEnabled(settings, on),
    onMutate: (on) => {
      qc.setQueryData<DmsPrefs>(DMS_SETTING_QUERY_KEY, (cur) => ({ calibratedAt: cur?.calibratedAt ?? null, enabled: on }));
    },
    onError: () => setNotice('save'),
    onSettled: () => qc.invalidateQueries({ queryKey: DMS_SETTING_QUERY_KEY }),
  });

  const onToggle = async (on: boolean) => {
    if (busy || asking) return;
    setNotice(null);
    if (!on) {
      write.mutate(false);
      return;
    }
    setAsking(true);
    try {
      const ask = deps.requestPermission ?? (() => cameraBridge()?.requestPermission() ?? Promise.resolve('unavailable' as const));
      const step = enableStep(await ask(), calibratedAt !== null);
      if (step === 'permission_denied') setNotice('permission');
      else if (step === 'unavailable') setNotice('unavailable');
      else if (step === 'setup') router.push(DMS_SETUP_HREF);
      else write.mutate(true);
    } finally {
      setAsking(false);
    }
  };

  return (
    <Screen scroll testID="dms-settings">
      <TopBar title={copy.title} trailing={<Pill label={copy.beta} tone="neutral" />} />
      {prefs.data === undefined ? <View testID="dms-loading" /> : null}
      {busy ? <Banner testID="dms-busy" tone="info" message={copy.duringDrive} /> : null}
      {notice === 'permission' ? <Banner testID="dms-permission" tone="warning" message={copy.permissionDenied} action={{ label: copy.openSettings, onPress: () => void Linking.openSettings() }} /> : null}
      {notice === 'unavailable' ? <Banner testID="dms-unavailable" tone="info" message={copy.unavailable} /> : null}
      {notice === 'save' ? <Banner testID="dms-save-error" tone="warning" message={copy.saveError} /> : null}
      <Card padded={false}>
        <ToggleRow
          title={copy.switchTitle}
          subtitle={enabled ? copy.switchOn : copy.switchOff}
          value={enabled}
          disabled={busy || asking || prefs.data === undefined}
          onValueChange={(next) => void onToggle(next)}
          icon="eye-outline"
          testID="dms-switch"
        />
        <Divider inset={th.space.lg} />
        <View style={{ padding: th.space.lg, gap: th.space.sm }}>
          <Text variant="footnote" tone="muted" testID="dms-privacy">
            {copy.privacy}
          </Text>
          <Text variant="footnote" tone="muted">
            {copy.bonus}
          </Text>
        </View>
      </Card>
      <View style={{ gap: th.space.sm }}>
        <Button
          testID="dms-calibrate"
          label={calibratedAt === null ? copy.calibrate : copy.recalibrate}
          icon="scan-outline"
          variant={calibratedAt === null ? 'primary' : 'secondary'}
          disabled={busy}
          onPress={() => router.push(DMS_SETUP_HREF)}
        />
        <Text variant="footnote" tone="muted" testID="dms-calibrated">
          {calibratedAt === null ? copy.notCalibrated : calibratedLabel(calibratedAt)}
        </Text>
      </View>
    </Screen>
  );
}
