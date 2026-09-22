import { useRef, useState } from 'react';
import { View } from 'react-native';

import { recordPrompt, type Grant } from '@/core/permissions';
import { markSettingsReturn } from '@/features/permissions/usePermissionHealth';
import { Card, Skeleton, Text, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame, type StepAction } from '../StepFrame';
import {
  StatusLine,
  useGrantConsent,
  usePhone,
  useStepDeps,
  type PermissionStepDeps,
} from './permissionKit';

const copy = onboardingCopy.motion;

/**
 * A7 · Motion & Fitness (iOS) / Physical activity (Android). One OS prompt on the driver's tap,
 * through the drive-sense port on both platforms (`requestMotion`, M3's `requestMotionPermission`).
 * A grant records the `motion` consent and moves on; any other answer says what it means and the
 * step still moves on (D12). `unavailable` makes no claim about when the phone will ask.
 */
export function MotionStep({ ctx, onNext, onBack, deps }: StepProps & { deps?: PermissionStepDeps }) {
  const th = useTheme();
  const { settings, adapter, appState, now } = useStepDeps(deps);
  const phone = usePhone(adapter, appState);
  const grantConsent = useGrantConsent(settings);

  /** The answer to this screen's request; undefined until the driver asks. */
  const [answer, setAnswer] = useState<Grant | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leaving = useRef(false);

  const current = answer !== undefined ? answer : phone.status === 'ready' ? phone.snapshot.motion : undefined;
  const isGranted = current === 'granted';

  const leave = async (grantedNow: boolean) => {
    if (leaving.current) return;
    leaving.current = true;
    if (grantedNow) await grantConsent('motion');
    onNext();
  };

  const allow = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const result = await adapter.requestMotion();
      await recordPrompt(settings, 'motion', now()).catch(() => {});
      setAnswer(result);
      if (result === 'granted') await leave(true);
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
      // Back from Settings, the phone is read again (AppState); a new answer is taken from there.
      setAnswer(undefined);
    } catch {
      setFailed(true);
    }
  };

  const cont: StepAction = { label: copy.continue, onPress: () => void leave(isGranted), testID: 'motion-continue' };
  const settingsAction: StepAction = {
    label: copy.openSettings,
    onPress: () => void openSettings(),
    testID: 'motion-settings',
  };

  let primary: StepAction;
  let secondary: StepAction | undefined;
  let line: { tone: 'ok' | 'off' | 'info'; text: string } | null = null;
  if (isGranted) {
    primary = cont;
    line = { tone: 'ok', text: copy.allowed };
  } else if (answer === undefined) {
    // Nothing asked yet on this screen: the primer, whatever the phone said before.
    primary = {
      label: copy.allow,
      onPress: () => void allow(),
      loading: busy,
      disabled: phone.status === 'loading',
      testID: 'motion-allow',
    };
    secondary = { label: copy.notNow, onPress: () => void leave(false), disabled: busy, testID: 'motion-not-now' };
  } else if (answer === 'denied' || answer === 'undetermined') {
    primary = cont;
    secondary = settingsAction;
    line = { tone: 'off', text: copy.denied };
  } else if (answer === 'unavailable') {
    primary = cont;
    secondary = settingsAction;
    line = { tone: 'info', text: copy.unavailable };
  } else {
    primary = cont;
    line = { tone: 'info', text: copy.cantCheck };
  }

  return (
    <StepFrame title={copy.title[ctx.platform]} onBack={onBack} primary={primary} secondary={secondary} testID="motion-step">
      <View style={{ gap: th.space.lg }}>
        <Card variant="license">
          <Text variant="body">{copy.body}</Text>
        </Card>
        {phone.status === 'loading' && answer === undefined ? <Skeleton width="70%" height={20} /> : null}
        {line ? <StatusLine tone={line.tone}>{line.text}</StatusLine> : null}
        {failed ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert">
            {copy.failed}
          </Text>
        ) : null}
      </View>
    </StepFrame>
  );
}
