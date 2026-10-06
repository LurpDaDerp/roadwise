import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { recordPrompt, type NotificationAccess } from '@/core/permissions';
import { requestDeviceSync } from '@/data/devices/events';
import { markSettingsReturn } from '@/features/permissions/usePermissionHealth';
import { Card, Text, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame, type StepAction } from '../StepFrame';
import {
  FieldLabel,
  StatusLine,
  usePhone,
  useStepDeps,
  type PermissionStepDeps,
} from './permissionKit';

const copy = onboardingCopy.notifications;

export interface NotificationsStepDeps extends PermissionStepDeps {
  /** Default: Task 5's `ensureAndroidChannels`, loaded on first use. */
  ensureChannels?: () => Promise<void>;
  /** Default: Task 10's `requestDeviceSync`, which the device host answers by registering the token. */
  requestDeviceSync?: () => void;
}

const defaultEnsureChannels = async () =>
  (await import('@/features/notifications/channels')).ensureAndroidChannels();

const allowed = (a: NotificationAccess | undefined) => a === 'granted' || a === 'provisional';

/**
 * Notifications: the three pushes v3 sends, shown as the server words them. On Android the
 * channels are created before the prompt, so the system names them from the first moment. One
 * request on the driver's tap; a grant asks the device host to register the push token. A denial
 * still moves on.
 */
export function NotificationsStep({ ctx, onNext, onBack, deps = {} }: StepProps & { deps?: NotificationsStepDeps }) {
  const th = useTheme();
  const { settings, adapter, appState, now } = useStepDeps(deps);
  const phone = usePhone(adapter, appState);

  const [answer, setAnswer] = useState<NotificationAccess | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leaving = useRef(false);

  const snapshot = phone.status === 'ready' ? phone.snapshot : null;
  const current = answer ?? snapshot?.notifications;
  const deniedForGood = answer === 'denied' || (snapshot?.notifications === 'denied' && !snapshot.notificationsCanAskAgain);

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
      if (ctx.platform === 'android') {
        // A failure here costs only the names: NotificationsHost creates them again at launch.
        await (deps.ensureChannels ?? defaultEnsureChannels)().catch(() => {});
      }
      const result = await adapter.requestNotifications();
      await recordPrompt(settings, 'notifications', now()).catch(() => {});
      setAnswer(result);
      if (allowed(result)) {
        (deps.requestDeviceSync ?? requestDeviceSync)();
        leave();
      }
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
      setAnswer(undefined);
    } catch {
      setFailed(true);
    }
  };

  const cont: StepAction = {
    label: copy.continue,
    onPress: () => leave(),
    testID: 'notifications-continue',
  };

  let primary: StepAction;
  let secondary: StepAction | undefined;
  let line: { tone: 'ok' | 'off'; text: string } | null = null;
  if (allowed(current)) {
    primary = cont;
    line = { tone: 'ok', text: current === 'provisional' ? copy.quiet : copy.allowed };
  } else if (deniedForGood) {
    primary = cont;
    secondary = { label: copy.openSettings, onPress: () => void openSettings(), testID: 'notifications-settings' };
    line = { tone: 'off', text: copy.denied };
  } else {
    primary = {
      label: copy.allow,
      onPress: () => void allow(),
      loading: busy,
      disabled: phone.status === 'loading',
      testID: 'notifications-allow',
    };
    secondary = {
      label: copy.notNow,
      onPress: () => leave(),
      disabled: busy,
      testID: 'notifications-not-now',
    };
  }

  return (
    <StepFrame title={copy.title} body={copy.body} onBack={onBack} primary={primary} secondary={secondary} testID="notifications-step">
      <View style={{ gap: th.space.lg }}>
        <View style={{ gap: th.space.sm }}>
          <FieldLabel>{copy.examples}</FieldLabel>
          {copy.previews.map((p) => (
            <Card key={p.id} testID={`notifications-preview-${p.id}`} style={{ gap: th.space.xs }}>
              <View
                style={{
                  paddingBottom: th.space.xs,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: th.colors.border,
                }}
              >
                <Text variant="caption" tone="muted">
                  RoadWise
                </Text>
              </View>
              <Text variant="headline">{p.title}</Text>
              <Text variant="subhead" tone="muted">
                {p.body}
              </Text>
            </Card>
          ))}
        </View>
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
