import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { recordPrompt, type NotificationAccess, type PermissionPlatform } from '@/core/permissions';
import { useDriveStateReported } from '@/data/devices/driveStateStore';
import { requestDeviceSync } from '@/data/devices/events';
import { markSettingsReturn } from '@/features/permissions/usePermissionHealth';
import { renderLocal, renderPush, type LiveType } from '@/notifications/catalog';
import { Card, Text, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame, type StepAction } from '../StepFrame';
import { FieldLabel } from './BirthDateField';
import {
  StatusLine,
  useGrantConsent,
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

export interface NotificationPreview {
  type: LiveType;
  title: string;
  body: string;
}

/**
 * A8's examples, rendered by the catalog itself — the drive summary as `renderLocal` words it for a
 * single drive whose driver isn't known yet, and a pushed permission lapse as `renderPush` words it
 * — so an example is never a notification the app doesn't send. Live types only.
 */
export function previewNotifications(platform: PermissionPlatform): NotificationPreview[] {
  const summary = renderLocal('trip_summary', {
    clientTripId: 'example',
    distanceM: 5150,
    roleUnknown: true,
    scorableIfDriver: false,
    count: 1,
  });
  const out: NotificationPreview[] = [{ type: 'trip_summary', title: summary.title, body: summary.body }];
  const lapse = renderPush('permission_lapsed', { permission: 'location', platform, deviceId: 'example' });
  if (lapse) out.push({ type: 'permission_lapsed', title: lapse.title, body: lapse.body });
  return out;
}

const allowed = (a: NotificationAccess | undefined) => a === 'granted' || a === 'provisional';

/**
 * A8 · Notifications. The examples come from the catalog; the promise "We hold them while you're
 * driving." is printed only while this phone reports its drive state to the server (rev1: C1).
 * On Android the channels are created before the prompt, so the system names them from the first
 * moment (rev1: m). One request on the driver's tap; a grant records the `notifications` consent
 * and asks the device host to register the push token. A denial says updates wait in the inbox,
 * and the step still moves on (D12).
 */
export function NotificationsStep({ ctx, onNext, onBack, deps = {} }: StepProps & { deps?: NotificationsStepDeps }) {
  const th = useTheme();
  const { settings, adapter, appState, now } = useStepDeps(deps);
  const phone = usePhone(adapter, appState);
  const grantConsent = useGrantConsent(settings);
  const reported = useDriveStateReported();
  const previews = previewNotifications(ctx.platform);

  const [answer, setAnswer] = useState<NotificationAccess | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leaving = useRef(false);

  const snapshot = phone.status === 'ready' ? phone.snapshot : null;
  const current = answer ?? snapshot?.notifications;
  const deniedForGood = answer === 'denied' || (snapshot?.notifications === 'denied' && !snapshot.notificationsCanAskAgain);

  const leave = async (grantedNow: boolean) => {
    if (leaving.current) return;
    leaving.current = true;
    if (grantedNow) await grantConsent('notifications');
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
        await grantConsent('notifications');
        (deps.requestDeviceSync ?? requestDeviceSync)();
        await leave(true);
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
    onPress: () => void leave(allowed(current)),
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
      onPress: () => void leave(false),
      disabled: busy,
      testID: 'notifications-not-now',
    };
  }

  return (
    <StepFrame title={copy.title} body={copy.body} onBack={onBack} primary={primary} secondary={secondary} testID="notifications-step">
      <View style={{ gap: th.space.lg }}>
        <View style={{ gap: th.space.sm }}>
          <FieldLabel>{copy.examples}</FieldLabel>
          {previews.map((p) => (
            <Card key={p.type} testID={`notifications-preview-${p.type}`} style={{ gap: th.space.xs }}>
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
        {reported ? (
          <Text variant="headline" testID="notifications-promise">
            {copy.promise}
          </Text>
        ) : null}
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
