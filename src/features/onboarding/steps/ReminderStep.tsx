import { useRef, useState } from 'react';
import { View } from 'react-native';

import type { TripReminderStatus } from '@drive-sense';

import type { PermissionsAdapter } from '@/core/permissions';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { reminderCopy, reminderLine, turnOnReminder, type ReminderNative } from '@/features/reminder';
import { Card, Text, useTheme } from '@/ui';

import type { StepProps } from '../stepRegistry';
import { StepFrame, type StepAction } from '../StepFrame';
import { StatusLine } from './permissionKit';

const copy = reminderCopy.step;

export interface ReminderStepDeps {
  adapter?: PermissionsAdapter;
  native?: ReminderNative;
}

/**
 * The optional "Forgot to start?" step (after notifications). "Turn on" asks for what the reminder
 * still needs (on iOS, Location "Always") and turns it on; "Not now" asks nothing. Either way the
 * flow goes on, and it can be turned on later in Settings › Driving. The reminder only ever sends a
 * note that opens RoadWise; it never starts a drive.
 */
export function ReminderStep({ ctx, onNext, onBack, deps = {} }: StepProps & { deps?: ReminderStepDeps }) {
  const th = useTheme();
  const [status, setStatus] = useState<TripReminderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leaving = useRef(false);

  const leave = () => {
    if (leaving.current) return;
    leaving.current = true;
    onNext();
  };

  const turnOn = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      setStatus(await turnOnReminder(deps.adapter ?? defaultPermissionsAdapter(), deps.native));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  let primary: StepAction;
  let secondary: StepAction | undefined;
  if (status) {
    primary = { label: copy.continue, onPress: leave, testID: 'reminder-continue' };
  } else {
    primary = { label: copy.turnOn, onPress: () => void turnOn(), loading: busy, testID: 'reminder-turn-on' };
    secondary = { label: copy.notNow, onPress: leave, disabled: busy, testID: 'reminder-not-now' };
  }
  const line = status ? reminderLine(status, ctx.platform) : null;

  return (
    <StepFrame title={copy.title} body={copy.body} onBack={onBack} primary={primary} secondary={secondary} testID="reminder-step">
      <View style={{ gap: th.space.lg }}>
        <Card style={{ gap: th.space.sm }}>
          {[...copy.bullets, ctx.platform === 'ios' ? copy.ios : copy.android].map((b) => (
            <Text key={b} variant="body">
              {`• ${b}`}
            </Text>
          ))}
        </Card>
        {line && status ? (
          <StatusLine tone={status.state === 'on' || status.state === 'paused' ? 'ok' : 'attention'} testID="reminder-line">
            {line.text}
          </StatusLine>
        ) : null}
        {failed ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert">
            {reminderCopy.failed}
          </Text>
        ) : null}
      </View>
    </StepFrame>
  );
}
