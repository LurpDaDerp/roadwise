import { View } from 'react-native';

import { Button, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';
import { StepTitle } from './StepTitle';

const copy = dashpalCopy.wizard;

/** Screen 2, after the pairing: the time left in the hold's last minute, a lost link reconnecting, and Next. */
export function StepInstructions({
  holdLeftS,
  reconnecting,
  step,
  onNext,
}: {
  holdLeftS: number | null;
  reconnecting: boolean;
  step: string | null;
  onNext(): void;
}) {
  const th = useTheme();
  return (
    <View style={{ gap: th.space.md }}>
      <StepTitle step={step} testID="wizard-instructions-title">
        {copy.instructions.title}
      </StepTitle>
      {reconnecting ? (
        <Text variant="callout" tone="muted" accessibilityLiveRegion="polite" testID="wizard-reconnecting">
          {copy.connecting.reconnecting}
        </Text>
      ) : null}
      {holdLeftS !== null ? (
        <Text variant="callout" tone="warning" accessibilityLiveRegion="polite" testID="wizard-hold-left">
          {copy.holdLeft(holdLeftS)}
        </Text>
      ) : null}
      <Button label={copy.instructions.nextSkip} onPress={onNext} style={{ marginTop: th.space.sm }} testID="wizard-next" />
    </View>
  );
}
