import { View } from 'react-native';

import { Button, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';
import { DashpalIllustration } from './DashpalIllustration';
import { StepTitle } from './StepTitle';

const copy = dashpalCopy.wizard.confirm;

/**
 * Screen 1: the DashPal's picture and Pair. Nothing is sent to the DashPal before the tap. `again`
 * is Set up again; `open` a DashPal opened by Add another phone (no aiming, so no face note);
 * `replaces` the paired DashPal this one replaces on this phone.
 */
export function StepConfirm({
  name,
  mode,
  replaces,
  step,
  onPair,
}: {
  name: string;
  mode: 'new' | 'open' | 'again';
  replaces: string | null;
  step: string | null;
  onPair(): void;
}) {
  const th = useTheme();
  return (
    <View style={{ gap: th.space.md }}>
      <View style={{ alignItems: 'center', paddingVertical: th.space.sm }}>
        <DashpalIllustration size={160} testID="wizard-confirm-picture" />
      </View>
      <StepTitle step={step} testID="wizard-confirm-title">
        {mode === 'again' ? copy.titleAgain(name) : copy.title(name)}
      </StepTitle>
      <Text variant="body" testID="wizard-confirm-body">
        {copy.body}
      </Text>
      {mode !== 'open' ? (
        <Text variant="callout" tone="muted" testID="wizard-confirm-note">
          {copy.note}
        </Text>
      ) : null}
      {replaces ? (
        <Text variant="callout" tone="warning" testID="wizard-confirm-replaces">
          {copy.replaces(replaces)}
        </Text>
      ) : null}
      <Button label={copy.pair} onPress={onPair} style={{ marginTop: th.space.sm }} testID="wizard-pair" />
    </View>
  );
}
