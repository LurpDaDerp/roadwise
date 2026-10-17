import { useRef, useState } from 'react';
import { Platform, View } from 'react-native';

import { dashpalCopy } from '@/dashcam/copy';
import { dashpalSecrets, type DashpalSecrets } from '@/dashcam/secure';
import type { SetupPhase } from '@/dashcam/setup';
import { SetupPanel, type SetupPanelDeps } from '@/dashcam/ui/SetupScreen';
import { Card, Text, useTheme } from '@/ui';

import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';

const copy = dashpalCopy.onboarding;

/**
 * The optional DashPal step (after notifications): "Got a DashPal dashcam?". Only "Find my DashPal"
 * opts in and asks for Bluetooth (inside the setup flow, on that tap) — nobody without a DashPal is
 * ever asked. The setup runs inline (onboarding keeps its own routes); "Not now" and "Continue" move
 * on whatever happened, and it can be done later from Settings › DashPal.
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
}: StepProps & { deps?: SetupPanelDeps; api?: number | null; secrets?: DashpalSecrets }) {
  const th = useTheme();
  const [finding, setFinding] = useState(false);
  const [phase, setPhase] = useState<SetupPhase['kind'] | null>(null);
  const leaving = useRef(false);
  const leave = () => {
    if (leaving.current) return;
    leaving.current = true;
    onNext();
  };

  const done = phase === 'done';
  return (
    <StepFrame
      title={copy.title}
      body={finding ? undefined : `${copy.body} ${copy.asks(ctx.platform, api)}`}
      onBack={onBack}
      primary={
        finding
          ? { label: copy.continue, onPress: leave, testID: 'dashcam-continue' }
          : { label: copy.find, onPress: () => setFinding(true), testID: 'dashcam-find' }
      }
      secondary={finding ? undefined : { label: copy.notNow, onPress: leave, testID: 'dashcam-not-now' }}
      testID="dashcam-step"
    >
      {finding ? (
        <View style={{ gap: th.space.lg }}>
          <SetupPanel
            deps={{ platform: ctx.platform, secrets, ...deps }}
            onClose={() => (done ? leave() : setFinding(false))}
            onPhase={(p) => setPhase(p.kind)}
          />
        </View>
      ) : (
        <Card>
          <Text variant="body">{dashpalCopy.screen.intro}</Text>
        </Card>
      )}
    </StepFrame>
  );
}
