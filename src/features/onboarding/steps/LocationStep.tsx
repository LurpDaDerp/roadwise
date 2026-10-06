import { useRef, useState } from 'react';
import { View } from 'react-native';

import { recordPrompt, type PermissionSnapshot } from '@/core/permissions';
import { markSettingsReturn } from '@/features/permissions/usePermissionHealth';
import { Banner, Card, Skeleton, Text, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame, type StepAction } from '../StepFrame';
import { StatusLine, usePhone, useStepDeps, type PermissionStepDeps } from './permissionKit';

const copy = onboardingCopy.location;

const granted = (s: PermissionSnapshot | null) => s?.location === 'foreground' || s?.location === 'always';

type View_ = 'loading' | 'error' | 'ask' | 'denied' | 'approximate' | 'granted';

/**
 * Location, *While Using* only: one OS prompt, on the driver's tap. "Always" is never asked for:
 * every drive starts in the app, and the OS keeps a started drive running in the background.
 * A denial still moves on (D12). Approximate location is said plainly, with a way to Settings.
 */
export function LocationStep({ onNext, onBack, deps }: StepProps & { deps?: PermissionStepDeps }) {
  const th = useTheme();
  const { settings, adapter, appState, now } = useStepDeps(deps);
  const phone = usePhone(adapter, appState);

  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leaving = useRef(false);

  const snapshot = phone.status === 'ready' ? phone.snapshot : null;

  let view: View_;
  if (phone.status === 'error') view = 'error';
  else if (snapshot === null) view = 'loading';
  else if (granted(snapshot)) view = snapshot.precise === false ? 'approximate' : 'granted'; else if (snapshot.location === 'denied' && (answered || !snapshot.locationCanAskAgain)) view = 'denied';
  else view = 'ask';

  const leave = () => {
    if (leaving.current) return;
    leaving.current = true;
    onNext();
  };

  const allow = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const access = await adapter.requestLocationForeground();
      await recordPrompt(settings, 'location', now()).catch(() => {});
      setAnswered(true);
      const next = await phone.reload();
      // Granted: move on, unless approximate location has something to say first.
      if ((access === 'foreground' || access === 'always') && next?.precise !== false) leave();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const openSettings = async () => {
    setFailed(false);
    try {
      await markSettingsReturn(settings, now());
      await adapter.openAppSettings();
    } catch {
      setFailed(true);
    }
  };

  const cont: StepAction = { label: copy.continue, onPress: () => leave(), testID: 'location-continue' };
  const settingsAction: StepAction = {
    label: copy.openSettings,
    onPress: () => void openSettings(),
    testID: 'location-settings',
  };

  let primary: StepAction;
  let secondary: StepAction | undefined;
  switch (view) {
    case 'loading':
      primary = { label: copy.allow, onPress: () => {}, disabled: true, testID: 'location-allow' };
      break;
    case 'error':
      primary = cont;
      break;
    case 'ask':
      primary = { label: copy.allow, onPress: () => void allow(), loading: busy, testID: 'location-allow' };
      secondary = { label: copy.notNow, onPress: () => leave(), disabled: busy, testID: 'location-not-now' };
      break;
    case 'denied':
      primary = cont;
      secondary =
        snapshot?.locationCanAskAgain && !answered
          ? { label: copy.allow, onPress: () => void allow(), loading: busy, testID: 'location-allow' }
          : settingsAction;
      break;
    case 'approximate':
      primary = cont;
      secondary = settingsAction;
      break;
    case 'granted':
      primary = cont;
      break;
  }

  return (
    <StepFrame title={copy.title} onBack={onBack} primary={primary} secondary={secondary} testID="location-step">
      <View style={{ gap: th.space.lg }}>
        <Card>
          <Text variant="body">{copy.body}</Text>
          <Text variant="subhead" tone="muted">
            {copy.promise}
          </Text>
        </Card>
        {view === 'loading' ? <Skeleton width="70%" height={20} /> : null}
        {view === 'error' ? (
          <Banner
            tone="warning"
            message={onboardingCopy.permissions.loadFailed}
            action={{ label: onboardingCopy.permissions.retry, onPress: () => void phone.reload() }}
            testID="location-read-error"
          />
        ) : null}
        {view === 'granted' ? <StatusLine tone="ok">{copy.allowed}</StatusLine> : null}
        {view === 'denied' ? <StatusLine tone="off">{copy.denied}</StatusLine> : null}
        {view === 'approximate' ? <StatusLine tone="attention">{copy.approximate}</StatusLine> : null}
        {failed ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert">
            {copy.failed}
          </Text>
        ) : null}
      </View>
    </StepFrame>
  );
}
