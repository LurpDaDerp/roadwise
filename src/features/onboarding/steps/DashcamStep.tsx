import { useRef, useState } from 'react';
import { View } from 'react-native';

import { dashpalCopy } from '@/dashcam/copy';
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
export function DashcamStep({ ctx, onNext, onBack, deps }: StepProps & { deps?: SetupPanelDeps }) {
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
      body={finding ? undefined : copy.body}
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
            deps={{ platform: ctx.platform, ...deps }}
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
