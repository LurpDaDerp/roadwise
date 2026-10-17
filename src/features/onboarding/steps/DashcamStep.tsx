import { useRef, useState } from 'react';
import { Platform } from 'react-native';

import { dashpalCopy } from '@/dashcam/copy';
import { dashpalSecrets, type DashpalSecrets } from '@/dashcam/secure';
import type { SetupStart } from '@/dashcam/setup';
import { PairWizardSheet } from '@/dashcam/ui/wizard/PairWizardSheet';
import type { SetupFlowDeps } from '@/dashcam/ui/wizard/useSetupFlow';
import { Card, Text } from '@/ui';

import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';

const copy = dashpalCopy.onboarding;

/**
 * The optional DashPal step (after notifications): "Got a DashPal dashcam?". Only "Find my DashPal"
 * opts in and asks for Bluetooth (inside the setup sheet, on that tap) — nobody without a DashPal is
 * ever asked. The setup sheet opens over the step (onboarding keeps its own routes) and looks for a
 * DashPal in pairing mode; a setup that finished moves on, one closed before that leaves the step as
 * it was. "Not now" moves on, and it can be done later from Settings › DashPal.
 */
const androidApi = (): number | null => {
  if (Platform.OS !== 'android') return null;
  const v = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
  return Number.isFinite(v) ? v : null;
};

export function DashcamStep({
  ctx,
  onNext,
  onBack,
  deps,
  api = androidApi(),
  secrets = dashpalSecrets,
}: StepProps & { deps?: SetupFlowDeps; api?: number | null; secrets?: DashpalSecrets }) {
  const [setup, setSetup] = useState<SetupStart | null>(null);
  const leaving = useRef(false);
  const leave = () => {
    if (leaving.current) return;
    leaving.current = true;
    onNext();
  };

  return (
    <StepFrame
      title={copy.title}
      body={`${copy.body} ${copy.asks(ctx.platform, api)}`}
      onBack={onBack}
      primary={{ label: copy.find, onPress: () => setSetup({}), testID: 'dashcam-find' }}
      secondary={{ label: copy.notNow, onPress: leave, testID: 'dashcam-not-now' }}
      testID="dashcam-step"
    >
      <Card>
        <Text variant="body">{dashpalCopy.screen.intro}</Text>
      </Card>
      <PairWizardSheet
        start={setup}
        onClose={(outcome) => {
          setSetup(null);
          if (outcome === 'done') leave();
        }}
        deps={{ platform: ctx.platform, secrets, ...deps }}
      />
    </StepFrame>
  );
}
