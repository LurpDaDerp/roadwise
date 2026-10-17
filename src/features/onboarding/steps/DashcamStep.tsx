import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';

import { dashpalCopy } from '@/dashcam/copy';
import { nameOf } from '@/dashcam/protocol';
import { dashpalSecrets, type DashpalSecrets } from '@/dashcam/secure';
import type { SetupPhase } from '@/dashcam/setup';
import { SetupPanel, type SetupPanelDeps } from '@/dashcam/ui/SetupScreen';
import { Card, Text, useTheme } from '@/ui';

import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';

const copy = dashpalCopy.onboarding;

/**
 * The optional DashPal step (after notifications): "Got a DashPal dashcam?". Only "Find my DashPal"
 * opts in and asks for Bluetooth and the camera (inside the setup flow, on that tap) — nobody without
 * a DashPal is ever asked. A label link the driver opened before signing in waits with its code in
 * SecureStore: the button then reads "Set up DashPal-XXXX" and opens its Pair screen. The setup runs
 * inline (onboarding keeps its own routes); "Not now" and "Continue" move on whatever happened, and
 * it can be done later from Settings › DashPal.
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
  now = Date.now,
}: StepProps & { deps?: SetupPanelDeps; api?: number | null; secrets?: DashpalSecrets; now?: () => number }) {
  const th = useTheme();
  const [finding, setFinding] = useState(false);
  const [held, setHeld] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void secrets
      .readPendingCode(now())
      .then((p) => {
        if (live && p?.dashcamId) setHeld(nameOf(p.dashcamId));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // read once, when the step opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
          : { label: held ? copy.setUpHeld(held) : copy.find, onPress: () => setFinding(true), testID: 'dashcam-find' }
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
