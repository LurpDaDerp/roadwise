import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import type { PermissionsAdapter } from '@/core/permissions';
import { dashpalCopy } from '@/dashcam/copy';
import { COMMAND, SOUND } from '@/dashcam/protocol';
import { dashcamStatus } from '@/dashcam/ui/status';
import { useDashcamRuntime, useDashcamState } from '@/dashcam/ui/useDashcam';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { Banner, Button, Card, Divider, Screen, Sheet, Text, ToggleRow, useTheme } from '@/ui';

import { TopBar } from './parts';
import { SETTINGS_HREFS } from './routes';

const copy = dashpalCopy.screen;

/**
 * `/settings/dashcam` (Settings › Driving › DashPal). Unpaired: what DashPal is and "Set up
 * DashPal". Paired: the link's status and its fix, "Also beep on DashPal", a test sound, recalibrate,
 * "Add another phone" (opens the dashcam's pairing window for 2 minutes) and "Forget DashPal".
 */
export function DashcamScreen({ deps = {} }: { deps?: { adapter?: PermissionsAdapter; platform?: 'ios' | 'android' } }) {
  const th = useTheme();
  const router = useRouter();
  const runtime = useDashcamRuntime();
  const state = useDashcamState();
  const platform = deps.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android');
  const status = dashcamStatus(state, platform);
  const [notice, setNotice] = useState<{ tone: 'info' | 'warning'; message: string } | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [working, setWorking] = useState(false);
  const paired = state?.link.paired ?? null;
  const connected = state?.link.lifecycle === 'connected';

  const command = async (op: number, arg: number, done?: string) => {
    if (!runtime) return;
    setNotice(null);
    if (!connected) {
      setNotice({ tone: 'warning', message: copy.notConnected });
      return;
    }
    setWorking(true);
    const ok = await runtime.command(op, arg).catch(() => false);
    setWorking(false);
    if (!ok) setNotice({ tone: 'warning', message: copy.commandFailed });
    else if (done) setNotice({ tone: 'info', message: done });
  };

  const forget = async () => {
    setConfirmForget(false);
    if (!runtime) return;
    setWorking(true);
    await runtime.forget().catch(() => {});
    setWorking(false);
    setNotice(platform === 'ios' ? { tone: 'info', message: copy.forgetIos } : null);
  };

  const openSettings = () => void (deps.adapter ?? defaultPermissionsAdapter()).openAppSettings().catch(() => {});

  return (
    <Screen scroll testID="dashcam-screen">
      <TopBar title={copy.title} />
      {notice ? <Banner tone={notice.tone} message={notice.message} testID="dashcam-notice" /> : null}

      {!paired ? (
        <View style={{ gap: th.space.lg }}>
          <Card>
            <Text variant="body" testID="dashcam-intro">
              {copy.intro}
            </Text>
          </Card>
          <Button label={copy.setUp} onPress={() => router.push(SETTINGS_HREFS.dashcamSetup)} testID="dashcam-setup" />
        </View>
      ) : (
        <View style={{ gap: th.space.lg }}>
          <Card>
            <Text variant="headline" testID="dashcam-name">
              {paired.name}
            </Text>
            <Text variant="body" tone={status.dot === 'bad' ? 'danger' : status.dot === 'ok' ? 'success' : 'muted'} testID="dashcam-status">
              {status.label}
            </Text>
            {status.fix ? (
              <Text variant="callout" tone="muted" style={{ marginTop: th.space.sm }} testID="dashcam-fix">
                {status.fix}
              </Text>
            ) : null}
            {status.kind === 'not_allowed' ? <Button label={copy.fix.openSettings} variant="secondary" size="sm" onPress={openSettings} testID="dashcam-open-settings" /> : null}
            {status.kind === 'needs_repair' ? (
              <Button label={copy.fix.setUpAgain} variant="secondary" size="sm" onPress={() => router.push(SETTINGS_HREFS.dashcamSetup)} testID="dashcam-repair" />
            ) : null}
          </Card>

          <Card padded={false}>
            <ToggleRow
              title={copy.buzzerToo.title}
              subtitle={copy.buzzerToo.subtitle}
              value={state?.buzzerToo ?? false}
              onValueChange={(on) => void runtime?.setBuzzerToo(on).catch(() => setNotice({ tone: 'warning', message: copy.commandFailed }))}
              testID="dashcam-buzzer-too"
            />
          </Card>

          <Card>
            <View style={{ gap: th.space.sm }}>
              <Button label={copy.test} variant="secondary" disabled={working} onPress={() => void command(COMMAND.TEST_SOUND, SOUND.GLANCE)} testID="dashcam-test" />
              <Button label={copy.recalibrate} variant="secondary" disabled={working} onPress={() => void command(COMMAND.RECALIBRATE, 0)} testID="dashcam-recalibrate" />
              <Button label={copy.addPhone} variant="secondary" disabled={working} onPress={() => void command(COMMAND.OPEN_PAIRING, 0, copy.addPhoneDone)} testID="dashcam-add-phone" />
              <Divider />
              <Button label={copy.forget} variant="destructive" disabled={working} onPress={() => setConfirmForget(true)} testID="dashcam-forget" />
            </View>
          </Card>
        </View>
      )}

      <Sheet visible={confirmForget} onClose={() => setConfirmForget(false)} title={copy.forgetConfirm.title} testID="dashcam-forget-sheet">
        <Text variant="body">{copy.forgetConfirm.body}</Text>
        <Button label={copy.forgetConfirm.confirm} variant="destructive" onPress={() => void forget()} testID="dashcam-forget-confirm" />
        <Button label={copy.forgetConfirm.cancel} variant="ghost" onPress={() => setConfirmForget(false)} testID="dashcam-forget-cancel" />
      </Sheet>
    </Screen>
  );
}
