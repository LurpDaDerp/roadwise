// `/settings/dms-setup`: the parked, 20-second mount and gaze calibration. A live preview (native; blank at any
// other time), the mount check with its live issue line, then the four gaze prompts behind a progress ring. On
// success `dms.calibratedAt` is set and DMS turned on; a failure says plainly what to fix and offers a retry.
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Linking, View } from 'react-native';

import { previewView, type DmsSetupView } from '@/core/dms';
import { isBusyStatus } from '@/drive/policy';
import { useDrive } from '@/drive/useDrive';
import { TopBar } from '@/features/settings/parts';
import { Banner, Button, Card, ProgressRing, Screen, Text, useTheme } from '@/ui';

import { dmsCopy } from './copy';
import { useDmsSetup, type DmsSetupDeps } from './useDmsSetup';

const copy = dmsCopy.setup;
/** The native preview component, resolved once (null where the module is not linked). */
const Native = previewView();

function Preview({ view }: { view: DmsSetupView | null }) {
  const th = useTheme();
  return (
    <View
      testID="dms-preview"
      style={{ height: 220, borderRadius: th.radius.lg, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: th.colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' }}
    >
      {Native !== null ? <Native style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} /> : null}
      <View style={{ position: 'absolute', bottom: th.space.sm, left: th.space.sm, paddingHorizontal: th.space.sm, paddingVertical: 2, borderRadius: th.radius.pill, backgroundColor: th.colors.surface }}>
        <Text variant="footnote" tone="muted" testID="dms-camera-word">
          {view === null ? copy.camera.starting : Native === null ? copy.previewUnavailable : copy.camera[view.camera]}
        </Text>
      </View>
    </View>
  );
}

function Running({ view }: { view: DmsSetupView | null }) {
  const th = useTheme();
  const step = view?.state.step ?? 'mount';
  const title = step === 'done' || step === 'failed' ? copy.stepTitle.mount : copy.stepTitle[step];
  const hint = step === 'done' || step === 'failed' ? copy.stepHint.mount : copy.stepHint[step];
  const issue = view === null ? null : view.state.issue;
  return (
    <View style={{ gap: th.space.lg }}>
      <Preview view={view} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.lg }}>
        <ProgressRing value={view?.progress ?? 0} size={72} accessibilityLabel="Setup progress" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="title3" accessibilityRole="header" testID="dms-step-title">
            {title}
          </Text>
          <Text variant="footnote" tone="muted">
            {hint}
          </Text>
        </View>
      </View>
      {issue !== null ? <Banner testID="dms-issue" tone="warning" message={copy.issue[issue]} /> : null}
    </View>
  );
}

export function DmsSetupScreen({ deps = {} }: { deps?: DmsSetupDeps }) {
  const th = useTheme();
  const router = useRouter();
  const busy = useDrive((s) => isBusyStatus(s.status));
  const { phase, start, cancel } = useDmsSetup(deps);
  const leave = () => {
    cancel();
    if (router.canGoBack()) router.back();
  };
  // A setup must never run during a drive: the screen cancels if one begins.
  useEffect(() => {
    if (busy) cancel();
  }, [busy, cancel]);

  return (
    <Screen scroll testID="dms-setup">
      <TopBar title={copy.title} />
      {busy ? <Banner testID="dms-setup-busy" tone="info" message={dmsCopy.settings.duringDrive} /> : null}
      {phase.kind === 'intro' ? (
        <View style={{ gap: th.space.lg }}>
          <Card>
            <Text variant="body" testID="dms-setup-intro">
              {copy.intro}
            </Text>
          </Card>
          <Text variant="footnote" tone="muted">
            {dmsCopy.permissionReason}
          </Text>
          <Button testID="dms-setup-start" label={copy.start} icon="scan-outline" onPress={start} disabled={busy} />
          <Button testID="dms-setup-cancel" label={copy.cancel} variant="ghost" onPress={leave} />
        </View>
      ) : null}
      {phase.kind === 'running' ? (
        <View style={{ gap: th.space.lg }}>
          <Running view={phase.view} />
          <Button testID="dms-setup-cancel" label={copy.cancel} variant="ghost" onPress={leave} />
        </View>
      ) : null}
      {phase.kind === 'done' ? (
        <View style={{ gap: th.space.lg }}>
          <Banner testID="dms-setup-done" tone="success" message={copy.success} />
          <Text variant="footnote" tone="muted" testID="dms-setup-mirrors">
            {copy.successMirrors(phase.mirrors)}
          </Text>
          <Button testID="dms-setup-finish" label={copy.done} icon="checkmark" onPress={leave} />
        </View>
      ) : null}
      {phase.kind === 'failed' ? (
        <View style={{ gap: th.space.lg }}>
          <Banner
            testID="dms-setup-failed"
            tone="warning"
            message={copy.failure[phase.reason]}
            action={phase.reason === 'permission' ? { label: dmsCopy.settings.openSettings, onPress: () => void Linking.openSettings() } : undefined}
          />
          <Button testID="dms-setup-retry" label={copy.tryAgain} icon="refresh" onPress={start} disabled={busy} />
          <Button testID="dms-setup-cancel" label={copy.cancel} variant="ghost" onPress={leave} />
        </View>
      ) : null}
    </Screen>
  );
}
