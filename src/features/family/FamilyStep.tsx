import { View } from 'react-native';

import type { StepProps } from '@/features/onboarding/stepRegistry';
import { StepFrame } from '@/features/onboarding/StepFrame';
import { Text, useTheme } from '@/ui';

import { familyCopy as copy } from './copy';
import { FamilyStart } from './FamilyStart';
import { useFamily, type FamilyDeps } from './useFamily';

/**
 * A11 · Family: join with a code or start a family, or *Not now*. Joining or starting moves on by
 * itself; a driver already in a family (a reinstall) is told so and continues. Nothing here turns
 * location sharing on: that is asked on the Family tab, with its own confirmation.
 */
export function FamilyStep({ onNext, onBack, deps = {} }: StepProps & { deps?: FamilyDeps }) {
  const th = useTheme();
  const family = useFamily(deps);
  const current = family.data?.family ?? null;
  return (
    <StepFrame
      testID="family-step"
      title={copy.step.title}
      body={current === null ? copy.step.body : undefined}
      onBack={onBack}
      primary={{ label: current === null ? copy.step.skip : copy.step.continue, onPress: onNext, testID: 'family-step-next' }}
    >
      {current !== null ? (
        <View style={{ gap: th.space.sm }}>
          <Text variant="body" testID="family-step-member">
            {copy.step.member(current.name)}
          </Text>
        </View>
      ) : (
        <FamilyStart deps={deps} onDone={onNext} />
      )}
    </StepFrame>
  );
}
