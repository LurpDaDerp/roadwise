import { View } from 'react-native';

import { Button, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';
import type { Candidate } from '../../setup';
import { StepTitle } from './StepTitle';

const copy = dashpalCopy.wizard.search;

/** Search mode found several: "Which DashPal is yours?", strongest first, each New or Has phones paired. */
export function StepChoose({ candidates, onPick }: { candidates: Candidate[]; onPick(id: string): void }) {
  const th = useTheme();
  return (
    <View style={{ gap: th.space.md }}>
      <StepTitle testID="wizard-choose-title">{copy.chooseTitle}</StepTitle>
      {candidates.map((c) => (
        <Button
          key={c.id}
          label={`${c.name ?? 'DashPal'} · ${c.adv === 'open' ? copy.chooseOpen : copy.chooseNew}`}
          variant="secondary"
          onPress={() => onPick(c.id)}
          testID={`wizard-pick-${c.id}`}
        />
      ))}
    </View>
  );
}
