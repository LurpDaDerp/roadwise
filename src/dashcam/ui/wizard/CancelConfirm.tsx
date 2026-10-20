import { View } from 'react-native';

import { Button, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';
import { StepTitle } from './StepTitle';

const copy = dashpalCopy.wizard.cancelConfirm;

/**
 * Cancel's second confirmation: "Stop setting up DashPal?", saying what stopping does before and
 * after the pairing, with Stop setup and Keep setting up. Back, the scrim or Keep setting up close it.
 * It shows at once, under the dimmed step: no entrance it would have to wait on.
 */
export function CancelConfirm({ paired, onStop, onKeep }: { paired: boolean; onStop(): void; onKeep(): void }) {
  const th = useTheme();
  return (
    <View accessibilityViewIsModal style={{ flexShrink: 0 }} testID="wizard-cancel-confirm">
      <View
        style={{
          marginHorizontal: th.space.lg,
          marginTop: th.space.lg,
          padding: th.space.lg,
          gap: th.space.md,
          borderRadius: th.radius.lg,
          borderWidth: 1,
          borderColor: th.colors.borderStrong,
          backgroundColor: th.colors.surfaceRaised,
        }}
      >
        <StepTitle testID="wizard-cancel-confirm-title">{copy.title}</StepTitle>
        <Text variant="body" tone="muted" testID="wizard-cancel-confirm-body">
          {paired ? copy.after : copy.before}
        </Text>
        <Button label={copy.stop} variant="destructive" onPress={onStop} testID="wizard-cancel-stop" />
        <Button label={copy.keep} variant="secondary" onPress={onKeep} testID="wizard-cancel-keep" />
      </View>
    </View>
  );
}
