import { useRef, useState } from 'react';
import { View } from 'react-native';

import { recordPrompt, type PermissionSnapshot } from '@/core/permissions';
import { markSettingsReturn } from '@/features/permissions/usePermissionHealth';
import { Banner, Card, Skeleton, Text, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame, type StepAction } from '../StepFrame';
import { StatusLine, usePhone, useStepDeps, type PermissionStepDeps } from './permissionKit';

const all = onboardingCopy.location;

const granted = (s: PermissionSnapshot | null) => s?.location === 'foreground' || s?.location === 'always';

type View_ = 'loading' | 'error' | 'ask' | 'denied' | 'approximate' | 'granted' | 'whileUsing';

/**
 * Location, on the driver's tap. On an iPhone one tap asks twice, as iOS allows: While Using, then
 * the upgrade to Always that lets RoadWise notice drives with the app closed; the primer says so
 * first. On Android it asks While Using only, for the drives the driver starts. A denial still moves
 * on (D12). Approximate location is said plainly, with a way to Settings, and is never asked for
 * Always.
 */
export function LocationStep({ ctx, onNext, onBack, deps }: StepProps & { deps?: PermissionStepDeps }) {
  const th = useTheme();
  const { settings, adapter, appState, now } = useStepDeps(deps);
  const phone = usePhone(adapter, appState);
  const ios = ctx.platform === 'ios';

  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leaving = useRef(false);

  const snapshot = phone.status === 'ready' ? phone.snapshot : null;

  let view: View_;
  if (phone.status === 'error') view = 'error';
  else if (snapshot === null) view = 'loading';
  else if (granted(snapshot)) {
    if (snapshot.precise === false) view = 'approximate';
    else if (!ios || snapshot.location === 'always') view = 'granted';
    // While Using on an iPhone: offer the Always step until it has been asked.
    else view = answered || snapshot.canAskAlways === false ? 'whileUsing' : 'ask';
  } else if (snapshot.location === 'denied' && (answered || !snapshot.locationCanAskAgain)) view = 'denied';
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
      let next = await phone.reload();
      const precise = next?.precise !== false;
      if (ios && access === 'foreground' && precise) {
        // The second ask: Always, right after While Using.
        await adapter.requestLocationAlways();
        next = await phone.reload();
      }
      setAnswered(true);
      // Move on once the phone holds what this platform needs, unless there is something to say first.
      const done = ios ? next?.location === 'always' : access === 'foreground' || access === 'always';
      if (done && precise) leave();
    } catch {
      setAnswered(true);
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

  const copy = ios ? all.ios : all.android;
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
    case 'whileUsing':
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
          {ios && view === 'ask' ? (
            <Text variant="callout" testID="location-twice">
              {all.ios.steps}
            </Text>
          ) : null}
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
        {view === 'granted' ? <StatusLine tone="ok">{ios ? all.ios.always : all.android.allowed}</StatusLine> : null}
        {view === 'whileUsing' ? <StatusLine tone="attention">{all.ios.whileUsing}</StatusLine> : null}
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
