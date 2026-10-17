import { ActivityIndicator, View } from 'react-native';

import { Button, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';
import { StepTitle } from './StepTitle';

const copy = dashpalCopy.setup;
const wiz = dashpalCopy.wizard;

export type PermissionView = 'asking' | 'denied' | 'off' | 'unavailable';

/**
 * Bluetooth for setup, asked on the driver's own action: while it is asked, then not allowed (Open
 * Settings, Try again), off (Try again) or no Bluetooth LE on this phone (Close).
 */
export function StepPermission({
  view,
  onOpenSettings,
  onRetry,
  onClose,
}: {
  view: PermissionView;
  onOpenSettings(): void;
  onRetry(): void;
  onClose(): void;
}) {
  const th = useTheme();
  const title = view === 'asking' ? copy.permission : view === 'denied' ? copy.denied : view === 'off' ? copy.off : copy.unavailable;
  return (
    <View style={{ gap: th.space.md, paddingVertical: view === 'asking' ? th.space.lg : 0, alignItems: view === 'asking' ? 'center' : 'stretch' }} testID={`wizard-permission-${view}`}>
      {view === 'asking' ? <ActivityIndicator size="large" color={th.colors.accent} /> : null}
      <StepTitle testID="wizard-permission-title">{title}</StepTitle>
      <View style={{ gap: th.space.sm }}>
        {view === 'denied' ? <Button label={dashpalCopy.screen.fix.openSettings} onPress={onOpenSettings} testID="wizard-open-settings" /> : null}
        {view === 'denied' || view === 'off' ? (
          <Button label={wiz.failed.tryAgain} variant={view === 'denied' ? 'secondary' : 'primary'} onPress={onRetry} testID="wizard-retry" />
        ) : null}
        {view === 'unavailable' ? <Button label={wiz.failed.close} variant="secondary" onPress={onClose} testID="wizard-close" /> : null}
      </View>
    </View>
  );
}
