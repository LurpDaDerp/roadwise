import { usePreventScreenCapture } from 'expo-screen-capture';
import { View } from 'react-native';

import { Button, Text, useTheme } from '@/ui';
import { useSnapshotBlocked } from '@/ui/snapshotGuard';

import { dashpalCopy } from '../../copy';
import type { ViewReason } from '../../protocol';
import { AIM_RETRY, type AimStatus, type SetupFlow } from '../../setup';
import { AimView } from './AimView';
import { StepTitle } from './StepTitle';

const copy = dashpalCopy.wizard;

/** The words for a refused or stopped picture. */
export const refusalText = (reason: ViewReason | null): string => copy.aim.refused[reason ?? 'camera'];

/**
 * Screen 3: DashPal's live picture to aim it by (`AimView`), the refusal in words with Try again
 * where it can help, the hold's last minute and a reconnect, and Next, always enabled: the driver
 * decides when it is aimed, and the step changes nothing on the dashcam. While it is mounted the
 * system keeps screenshots, recordings and the app switcher from showing it.
 */
export function StepAim({
  status,
  reason,
  holdLeftS,
  reconnecting,
  step,
  flow,
  onRetry,
  onNext,
}: {
  status: AimStatus;
  reason: ViewReason | null;
  holdLeftS: number | null;
  reconnecting: boolean;
  step: string | null;
  flow: Pick<SetupFlow, 'onViewFrame' | 'onAim'>;
  onRetry(): void;
  onNext(): void;
}) {
  const th = useTheme();
  usePreventScreenCapture('dashpal-aim');
  // Nor is the theme's fade allowed a snapshot of the app while the picture shows.
  useSnapshotBlocked('dashpal-aim');
  const refused = status === 'refused';
  const canRetry = refused && reason !== null && AIM_RETRY.includes(reason);
  return (
    <View style={{ gap: th.space.md }}>
      <StepTitle step={step} testID="wizard-aim-title">
        {copy.aim.title}
      </StepTitle>
      <AimView flow={flow} status={status} />
      {refused ? (
        <Text variant="body" accessibilityLiveRegion="polite" testID="wizard-aim-refused">
          {refusalText(reason)}
        </Text>
      ) : null}
      {reconnecting ? (
        <Text variant="callout" tone="muted" accessibilityLiveRegion="polite" testID="wizard-reconnecting">
          {copy.connecting.reconnecting}
        </Text>
      ) : null}
      {holdLeftS !== null ? (
        <Text variant="callout" tone="warning" accessibilityLiveRegion="polite" testID="wizard-hold-left">
          {copy.holdLeft(holdLeftS)}
        </Text>
      ) : null}
      {canRetry ? <Button label={copy.aim.tryAgain} variant="secondary" onPress={onRetry} testID="wizard-aim-retry" /> : null}
      <Button label={copy.aim.next} onPress={onNext} testID="wizard-aim-next" />
    </View>
  );
}
