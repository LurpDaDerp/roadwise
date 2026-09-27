// A10 · Camera coaching (beta), the onboarding step. Off by default: "Not now" is as easy as "Turn on". Only an adult
// account with the remote `camera_beta` flag can turn it on; anyone else sees why and continues. Turning it on
// records the versioned camera consent (optIn.ts); the OS camera prompt comes later, in context, at the start of the
// first mounted drive. There is no calibration step: the camera learns where the road is by itself as you drive.
import { useRef } from 'react';
import { View } from 'react-native';

import { StatusLine } from '@/features/onboarding/steps/permissionKit';
import type { StepProps } from '@/features/onboarding/stepRegistry';
import { StepFrame, type StepAction } from '@/features/onboarding/StepFrame';
import { Skeleton, useTheme } from '@/ui';

import { CameraConsent } from './CameraConsent';
import { cameraConsent, cameraCopy } from './copy';
import { useCameraBeta, type CameraBetaDeps } from './useCameraBeta';

const copy = cameraCopy.step;

export function CameraStep({ ctx, onNext, onBack, deps }: StepProps & { deps?: CameraBetaDeps }) {
  const th = useTheme();
  const beta = useCameraBeta(ctx.ageBand, deps);
  const leaving = useRef(false);
  const leave = () => {
    if (leaving.current) return;
    leaving.current = true;
    onNext();
  };

  const cont: StepAction = { label: copy.continue, onPress: leave, testID: 'camera-continue' };
  let primary: StepAction = cont;
  let secondary: StepAction | undefined;
  let line: { tone: 'ok' | 'off' | 'info'; text: string } | null = null;

  if (beta.eligibility === null) {
    primary = { ...cont, disabled: true };
  } else if (beta.eligibility === 'age') {
    line = { tone: 'info', text: copy.notAvailableAge };
  } else if (beta.eligibility === 'flag_off') {
    line = { tone: 'info', text: copy.notAvailableFlag };
  } else if (beta.on === true) {
    line = { tone: 'ok', text: copy.on };
  } else {
    primary = {
      label: copy.turnOn,
      onPress: () => {
        void beta.turnOn().then((ok) => {
          if (ok) leave();
        });
      },
      loading: beta.busy,
      testID: 'camera-turn-on',
    };
    secondary = { label: copy.notNow, onPress: leave, disabled: beta.busy, testID: 'camera-not-now' };
    if (beta.failed) line = { tone: 'off', text: copy.failed };
  }

  return (
    <StepFrame title={cameraConsent.title} onBack={onBack} primary={primary} secondary={secondary} testID="camera-step">
      <View style={{ gap: th.space.lg }}>
        {beta.eligibility === 'ok' ? <CameraConsent testID="camera-consent" /> : null}
        {beta.eligibility === null ? <Skeleton width="70%" height={20} /> : null}
        {line ? <StatusLine tone={line.tone} testID="camera-line">{line.text}</StatusLine> : null}
      </View>
    </StepFrame>
  );
}
