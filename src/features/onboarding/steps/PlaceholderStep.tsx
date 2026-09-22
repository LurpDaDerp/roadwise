import { onboardingCopy } from '../copy';
import type { StepId } from '../flow';
import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';

/**
 * Stands in for a step until its task builds it (Tasks 12–14). It asks for nothing and records
 * nothing, and says so: a placeholder that looked like a real permission screen would claim a
 * setup that never happened.
 */
export function PlaceholderStep({ step, onNext, onBack }: StepProps & { step: StepId }) {
  return (
    <StepFrame
      title={onboardingCopy.stepTitles[step]}
      body={onboardingCopy.placeholder.body}
      onBack={onBack}
      primary={{ label: onboardingCopy.placeholder.continue, onPress: onNext }}
    />
  );
}
