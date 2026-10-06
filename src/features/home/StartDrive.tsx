import { View } from 'react-native';

import { Banner, Button, Chip, useTheme } from '@/ui';

export type StartRefusal = 'moving' | 'permission' | 'busy' | 'error';

export const REFUSAL_COPY: Record<StartRefusal, string> = {
  moving: 'Pull over to start a drive. Start only works while you’re stopped.',
  permission: 'RoadWise needs location and motion access to record a drive.',
  busy: 'A drive is already running.',
  error: 'Couldn’t start the drive. Try again.',
};

/**
 * The bottom-reachable Start drive button with the DMS chip beside it. A refused start says why
 * in one line above the button; nothing is recorded.
 */
export function StartDriveBar({
  dmsOn,
  onToggleDms,
  onStart,
  starting,
  refusal,
  onRefusalAction,
}: {
  dmsOn: boolean;
  onToggleDms: () => void;
  onStart: () => void;
  starting: boolean;
  refusal: StartRefusal | null;
  onRefusalAction: () => void;
}) {
  const t = useTheme();
  const action =
    refusal === 'permission' ? { label: 'Fix it', onPress: onRefusalAction } : refusal === 'busy' ? { label: 'Open it', onPress: onRefusalAction } : undefined;
  return (
    <View
      style={{
        gap: t.space.sm,
        paddingHorizontal: t.space.lg,
        paddingTop: t.space.md,
        paddingBottom: t.space.md,
        backgroundColor: t.colors.bg,
        borderTopWidth: 1,
        borderTopColor: t.colors.divider,
      }}
    >
      {refusal ? <Banner tone={refusal === 'moving' ? 'warning' : 'danger'} message={REFUSAL_COPY[refusal]} action={action} testID="start-refusal" /> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <Chip
          label="DMS"
          icon={dmsOn ? 'eye' : 'eye-off-outline'}
          role="switch"
          selected={dmsOn}
          onPress={onToggleDms}
          accessibilityHint="Driver monitoring uses the front camera to spot eyes off the road. On earns ×1.25 points."
          testID="dms-chip"
        />
        <Button label="Start drive" icon="car-sport" size="lg" onPress={onStart} loading={starting} style={{ flex: 1 }} testID="start-drive" />
      </View>
    </View>
  );
}
