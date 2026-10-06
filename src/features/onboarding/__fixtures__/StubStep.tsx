import { onboardingCopy } from '../copy';
import type { StepId } from '../flow';
import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';

/**
 * A step that asks for nothing: its title and one Continue. The stepper suites render every step
 * as this, so they test the stepper's mechanics and not what each step does.
 */
export function StubStep({ step, onNext, onBack }: StepProps & { step: StepId }) {
  return (
    <StepFrame
      title={onboardingCopy.stepTitles[step]}
      onBack={onBack}
      primary={{ label: 'Continue', onPress: onNext }}
    />
  );
}
