import { View } from 'react-native';

import { Button, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';
import { StepTitle } from './StepTitle';

const copy = dashpalCopy.wizard;

/**
 * Screen 2, after the pairing: how to aim DashPal at the driver's face, ending with sitting in the
 * normal driving position to confirm, and what happens to the picture. `onStart` starts the aiming
 * picture (Start); without it the button is Next, which finishes. A DashPal opened by Add another
 * phone (`aimAllowed` false) was aimed by the other phone: it says so, with Next. The time left in
 * the hold's last minute and a lost link reconnecting show above the button.
 */
export function StepInstructions({
  aimAllowed,
  holdLeftS,
  reconnecting,
  step,
  onStart,
  onNext,
}: {
  aimAllowed: boolean;
  holdLeftS: number | null;
  reconnecting: boolean;
  step: string | null;
  onStart?: () => void;
  onNext(): void;
}) {
  const th = useTheme();
  const start = aimAllowed && onStart ? onStart : null;
  return (
    <View style={{ gap: th.space.md }}>
      <StepTitle step={step} testID="wizard-instructions-title">
        {copy.instructions.title}
      </StepTitle>
      {aimAllowed ? (
        <>
          <View style={{ gap: th.space.md }} testID="wizard-instructions-steps">
            {copy.instructions.steps.map((line, i) => (
              <View key={line} style={{ flexDirection: 'row', gap: th.space.md }} accessible accessibilityLabel={`${i + 1}. ${line}`} testID={`wizard-instructions-step-${i + 1}`}>
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    backgroundColor: th.colors.accentFaint,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text variant="headline" tone="accent">
                    {String(i + 1)}
                  </Text>
                </View>
                <Text variant="body" style={{ flex: 1 }}>
                  {line}
                </Text>
              </View>
            ))}
          </View>
          <Text variant="footnote" tone="muted" testID="wizard-instructions-privacy">
            {copy.instructions.privacy}
          </Text>
        </>
      ) : (
        <Text variant="body" testID="wizard-instructions-aimed-elsewhere">
          {copy.instructions.aimedElsewhere}
        </Text>
      )}
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
      {start ? (
        <Button label={copy.instructions.start} onPress={start} style={{ marginTop: th.space.sm }} testID="wizard-start" />
      ) : (
        <Button label={copy.instructions.nextSkip} onPress={onNext} style={{ marginTop: th.space.sm }} testID="wizard-next" />
      )}
    </View>
  );
}
