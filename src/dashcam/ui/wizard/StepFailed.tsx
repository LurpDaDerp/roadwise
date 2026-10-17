import { useEffect } from 'react';
import { View } from 'react-native';

import { Button, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';
import type { SetupFailure, SetupRetry } from '../../setup';
import { announce, StepTitle } from './StepTitle';

const copy = dashpalCopy.wizard.failed;

export function failureText(reason: SetupFailure, name: string | null): string {
  switch (reason) {
    case 'not_found':
      return copy.not_found(name);
    case 'window_closed':
      return copy.window_closed(name);
    case 'lost':
      return copy.lost(name);
    case 'none_nearby':
    case 'setup_busy':
    case 'unverified':
    case 'update_firmware':
    case 'update_app':
    case 'mtu':
    case 'ios_forget_first':
    case 'expired':
    case 'save_failed':
    case 'error':
      return copy[reason];
  }
}

/**
 * Setup did not finish: what happened, Try again (what it does: the failure's `retry`; none for a
 * fix outside the app) and Close. `busy`: a drive is open ("Finish your drive first.").
 */
export function StepFailed({
  text,
  retry,
  onRetry,
  onClose,
}: {
  text: string;
  retry: SetupRetry;
  onRetry(): void;
  onClose(): void;
}) {
  const th = useTheme();
  useEffect(() => announce(text), [text]);
  return (
    <View style={{ gap: th.space.md }}>
      <StepTitle testID="wizard-failed-title">{text}</StepTitle>
      <View style={{ gap: th.space.sm, marginTop: th.space.sm }}>
        {retry !== 'none' ? <Button label={copy.tryAgain} onPress={onRetry} testID="wizard-retry" /> : null}
        <Button label={copy.close} variant={retry !== 'none' ? 'ghost' : 'secondary'} onPress={onClose} testID="wizard-close" />
      </View>
    </View>
  );
}

