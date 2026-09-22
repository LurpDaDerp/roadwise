import { useRef } from 'react';

import { AutoRecordPanel, useAutoRecord, type AutoRecordDeps } from '../AutoRecordPanel';
import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame, type StepAction } from '../StepFrame';

const copy = onboardingCopy.autoRecord;

/**
 * A9 · Record drives automatically: the shared `AutoRecordPanel` with Turn on / Skip.
 *
 * - Off and available: **Turn on** (the host, or the iOS intent) then on; **Skip** marks manual by
 *   choice, which nothing nags about.
 * - Already on: Continue (the toggle turns it off).
 * - Blocked, or the phone couldn't be read: Continue, writing nothing (D12).
 */
export function AutoDetectStep({ onNext, onBack, deps }: StepProps & { deps?: AutoRecordDeps }) {
  const model = useAutoRecord(deps);
  const leaving = useRef(false);
  const go = (work?: () => Promise<boolean | void>) => async () => {
    if (leaving.current) return;
    leaving.current = true;
    const ok = work ? await work() : true;
    if (ok === false) {
      leaving.current = false;
      return;
    }
    onNext();
  };

  const cont: StepAction = { label: copy.continue, onPress: () => void go()(), testID: 'auto-record-continue' };
  let primary: StepAction = cont;
  let secondary: StepAction | undefined;
  if (model.status === 'loading') {
    primary = { ...cont, disabled: true };
  } else if (model.status === 'ready' && model.mode !== 'blocked' && !model.on) {
    primary = {
      label: copy.turnOn,
      onPress: () => void go(() => model.setOn(true))(),
      loading: model.busy,
      testID: 'auto-record-turn-on',
    };
    secondary = {
      label: copy.skip,
      onPress: () => void go(model.skip)(),
      disabled: model.busy,
      testID: 'auto-record-skip',
    };
  }

  return (
    <StepFrame title={copy.title} body={copy.body} onBack={onBack} primary={primary} secondary={secondary} testID="auto-detect-step">
      <AutoRecordPanel model={model} />
    </StepFrame>
  );
}
