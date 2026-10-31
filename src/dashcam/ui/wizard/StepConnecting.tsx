import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';

import { Text, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';
import { Checkmark } from './Checkmark';
import { announce, StepTitle } from './StepTitle';

const copy = dashpalCopy.wizard;

/** The spinner fades out this long before the check mark draws. */
export const SPINNER_OUT_MS = 150;

export type ConnectingView =
  | { kind: 'connecting'; name: string; reconnecting: boolean }
  | { kind: 'connected'; name: string }
  | { kind: 'press_button'; name: string }
  | { kind: 'waiting_busy'; name: string }
  | { kind: 'finishing'; reconnecting: boolean };

function words(v: ConnectingView): { title: string; body: string | null } {
  switch (v.kind) {
    case 'connecting':
      return { title: v.reconnecting ? copy.connecting.reconnecting : copy.connecting.title(v.name), body: copy.connecting.body };
    case 'connected':
      return { title: copy.connecting.done, body: copy.connecting.body };
    case 'press_button':
      return { title: copy.pressButton, body: null };
    case 'waiting_busy':
      return { title: copy.waitingBusy, body: null };
    case 'finishing':
      return { title: copy.finishing, body: v.reconnecting ? copy.connecting.reconnecting : null };
  }
}

/**
 * Screen 1 after the Pair tap: a spinner while the phone connects and pairs ("Connecting to
 * DashPal-XXXX…", other phones held off meanwhile), then a check mark with "Connected" and a success
 * haptic. Set up again's "Press DashPal's button 5 times.", the wait for another phone's setup
 * and "Finishing…" (with "Reconnecting…" under it while a lost link reconnects) show here too. Each
 * change is said to a screen reader.
 */
export function StepConnecting({ view, step }: { view: ConnectingView; step: string | null }) {
  const th = useTheme();
  const { title, body } = words(view);
  const done = view.kind === 'connected';

  const said = view.kind === 'connecting' && !view.reconnecting ? title.replace(/…$/, '') : view.kind === 'finishing' && view.reconnecting && body ? body : title;
  useEffect(() => {
    announce(said);
    if (done) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    // Once per text: the same words set again are not said again.
  }, [said, done]);

  return (
    <View style={{ gap: th.space.md, alignItems: 'center', paddingVertical: th.space.lg }} testID={`wizard-connect-${view.kind}`}>
      <View style={{ height: 72, alignItems: 'center', justifyContent: 'center' }}>
        {done ? (
          <Checkmark testID="wizard-check" />
        ) : (
          <Animated.View exiting={th.reduceMotion ? undefined : FadeOut.duration(SPINNER_OUT_MS)}>
            <ActivityIndicator size="large" color={th.colors.accent} testID="wizard-spinner" />
          </Animated.View>
        )}
      </View>
      <StepTitle step={step} testID="wizard-connect-title">
        {title}
      </StepTitle>
      {body ? (
        <Text variant="body" tone="muted" style={{ textAlign: 'center' }} testID="wizard-connect-body">
          {body}
        </Text>
      ) : null}
    </View>
  );
}
