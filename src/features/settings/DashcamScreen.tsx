import { useState } from 'react';
import { View } from 'react-native';

import type { PermissionsAdapter } from '@/core/permissions';
import { dashpalCopy } from '@/dashcam/copy';
import { COMMAND, SOUND } from '@/dashcam/protocol';
import { AddPhoneSheet } from '@/dashcam/ui/AddPhoneSheet';
import type { DashcamState } from '@/dashcam/runtime';
import { dashcamStatus } from '@/dashcam/ui/status';
import { useDashcamRuntime, useDashcamSelector } from '@/dashcam/ui/useDashcam';
import { PairWizardSheet } from '@/dashcam/ui/wizard/PairWizardSheet';
import type { SetupFlowDeps } from '@/dashcam/ui/wizard/useSetupFlow';
import type { SetupStart } from '@/dashcam/setup';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { Banner, Button, Card, Divider, Screen, Sheet, Text, ToggleRow, useTheme } from '@/ui';

import { TopBar } from './parts';

const copy = dashpalCopy.screen;

/**
 * What the screen shows, and only that: a STATUS that changes nothing here (its receipt time, the
 * frame rate, the temperature) does not draw it again.
 */
function selectScreen(s: DashcamState | null) {
  const connected = s?.link.lifecycle === 'connected';
  return {
    status: dashcamStatus(s),
    paired: s?.link.paired ?? null,
    connected,
    phones: connected ? (s?.link.status?.bondCount ?? null) : null,
    newPhone: s?.newPhone ?? false,
    buzzerToo: s?.buzzerToo ?? false,
  };
}

/**
 * `/settings/dashcam` (Settings › Driving › DashPal). Unpaired: what DashPal is and "Set up
 * DashPal" (the setup sheet, looking for a DashPal in pairing mode). Paired: the link's status and its fix (Set up again for a DashPal that no longer knows
 * this phone or a device that cannot prove it is the DashPal), how many phones are paired with the
 * dashcam (its STATUS count, while connected; from 2, how to remove one), the one-time notice of a
 * phone this phone did not add, "Also beep on DashPal", a test sound, recalibrate, "Add another
 * phone" (only while connected: opens the dashcam's pairing mode for one phone for 2 minutes, with
 * the time left) and "Forget DashPal".
 */
export function DashcamScreen({ deps = {} }: { deps?: { adapter?: PermissionsAdapter; now?: () => number; setup?: SetupFlowDeps } }) {
  const th = useTheme();
  const runtime = useDashcamRuntime();
  const { status, paired, connected, phones, newPhone, buzzerToo } = useDashcamSelector(selectScreen);
  const now = deps.now ?? Date.now;
  const [notice, setNotice] = useState<{ tone: 'info' | 'warning'; message: string } | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [working, setWorking] = useState(false);
  const [sheet, setSheet] = useState<{ at: number } | null>(null);
  /** the setup sheet: search mode (Set up DashPal) or the paired DashPal (Set up again) */
  const [setup, setSetup] = useState<SetupStart | null>(null);

  const command = async (op: number, arg: number) => {
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
  };

  const addPhone = async () => {
    if (!runtime) return;
    setNotice(null);
    if (!connected) {
      setNotice({ tone: 'warning', message: copy.addPhoneNeedsLink });
      return;
    }
    setWorking(true);
    const opened = await runtime.addPhone().catch(() => null);
    setWorking(false);
    if (!opened) {
      setNotice({ tone: 'warning', message: copy.commandFailed });
      return;
    }
    setSheet({ at: opened.openedAt });
  };

  const forget = async () => {
    setConfirmForget(false);
    if (!runtime) return;
    setWorking(true);
    await runtime.forget().catch(() => {});
    setWorking(false);
    setNotice(null);
  };

  const openSettings = () => void (deps.adapter ?? defaultPermissionsAdapter()).openAppSettings().catch(() => {});
  const repairable = status.kind === 'needs_repair' || status.kind === 'unverified';

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
          <Button label={copy.setUp} onPress={() => setSetup({})} testID="dashcam-setup" />
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
            {phones !== null ? (
              <Text variant="callout" tone="muted" style={{ marginTop: th.space.sm }} testID="dashcam-phones">
                {copy.phonesPaired(phones)}
              </Text>
            ) : null}
            {phones !== null && phones >= 2 ? (
              <Text variant="footnote" tone="muted" testID="dashcam-phones-help">
                {copy.phonesPairedHelp}
              </Text>
            ) : null}
            {newPhone ? (
              <View style={{ gap: th.space.sm, marginTop: th.space.sm }}>
                <Banner tone="warning" message={copy.newPhone} testID="dashcam-new-phone" />
                <Button label={copy.newPhoneOk} variant="secondary" size="sm" onPress={() => void runtime?.dismissNewPhone()} testID="dashcam-new-phone-ok" />
              </View>
            ) : null}
            {status.kind === 'not_allowed' ? <Button label={copy.fix.openSettings} variant="secondary" size="sm" onPress={openSettings} testID="dashcam-open-settings" /> : null}
            {repairable ? (
              <Button label={copy.fix.setUpAgain} variant="secondary" size="sm" onPress={() => setSetup({ again: true })} testID="dashcam-repair" />
            ) : null}
          </Card>

          <Card padded={false}>
            <ToggleRow
              title={copy.buzzerToo.title}
              subtitle={copy.buzzerToo.subtitle}
              value={buzzerToo}
              onValueChange={(on) => void runtime?.setBuzzerToo(on).catch(() => setNotice({ tone: 'warning', message: copy.commandFailed }))}
              testID="dashcam-buzzer-too"
            />
          </Card>

          <Card>
            <View style={{ gap: th.space.sm }}>
              <Button label={copy.test} variant="secondary" disabled={working} onPress={() => void command(COMMAND.TEST_SOUND, SOUND.GLANCE)} testID="dashcam-test" />
              <Button label={copy.recalibrate} variant="secondary" disabled={working} onPress={() => void command(COMMAND.RECALIBRATE, 0)} testID="dashcam-recalibrate" />
              <Button label={copy.addPhone} variant="secondary" disabled={working || !connected} onPress={() => void addPhone()} testID="dashcam-add-phone" />
              {!connected ? (
                <Text variant="footnote" tone="muted" testID="dashcam-add-phone-needs-link">
                  {copy.addPhoneNeedsLink}
                </Text>
              ) : null}
              <Divider />
              <Button label={copy.forget} variant="destructive" disabled={working} onPress={() => setConfirmForget(true)} testID="dashcam-forget" />
            </View>
          </Card>
        </View>
      )}

      <PairWizardSheet start={setup} onClose={() => setSetup(null)} deps={{ adapter: deps.adapter, ...deps.setup }} />
      {paired ? <AddPhoneSheet openedAt={sheet?.at ?? null} onClose={() => setSheet(null)} now={now} /> : null}

      <Sheet visible={confirmForget} onClose={() => setConfirmForget(false)} title={copy.forgetConfirm.title} testID="dashcam-forget-sheet">
        <Text variant="body">{copy.forgetConfirm.body}</Text>
        <Button label={copy.forgetConfirm.confirm} variant="destructive" onPress={() => void forget()} testID="dashcam-forget-confirm" />
        <Button label={copy.forgetConfirm.cancel} variant="ghost" onPress={() => setConfirmForget(false)} testID="dashcam-forget-cancel" />
      </Sheet>
    </Screen>
  );
}
