import { View } from 'react-native';

import { Banner, Button, useTheme } from '@/ui';

export type StartRefusal = 'moving' | 'permission' | 'busy' | 'error';

export const REFUSAL_COPY: Record<StartRefusal, string> = {
  moving: 'Pull over to start a drive. Start only works while you’re stopped.',
  permission: 'RoadWise needs location and motion access to record a drive.',
  busy: 'A drive is already running.',
  error: 'Couldn’t start the drive. Try again.',
};

/**
 * The bottom-reachable Start drive button. A refused start says why in one line above the
 * button; nothing is recorded.
 */
export function StartDriveBar({
  onStart,
  starting,
  refusal,
  onRefusalAction,
}: {
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
        <Button label="Start drive" icon="car-sport" size="lg" onPress={onStart} loading={starting} style={{ flex: 1 }} testID="start-drive" />
      </View>
    </View>
  );
}
