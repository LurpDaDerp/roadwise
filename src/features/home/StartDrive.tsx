import { IDLE_END_S } from '@scoring';
import { View } from 'react-native';

import type { EndCause } from '@/core/engine/engine.types';
import type { DropReason } from '@/core/engine/finalize';
import { Banner, Button, useTheme } from '@/ui';

export type StartRefusal = 'permission' | 'busy' | 'error';

export const REFUSAL_COPY: Record<StartRefusal, string> = {
  permission: 'RoadWise needs location to record a drive.',
  busy: 'A drive is already running.',
  error: 'Couldn’t start the drive. Try again.',
};

const IDLE_MIN = Math.round(IDLE_END_S / 60);

/** Why the last drive was not kept, by what ended it and why it was dropped (product spec v3 Home). */
export function dropCopy(cause: EndCause, reason: DropReason): string {
  switch (cause) {
    case 'walking':
      return 'Drive ended: you walked away before driving, so it wasn’t saved.';
    case 'manual':
      return reason === 'no_gps' ? 'There was no GPS signal, so the drive wasn’t saved.' : 'The car never moved, so the drive wasn’t saved.';
    case 'orphan':
      return reason === 'no_gps'
        ? 'A drive left open when RoadWise closed had no GPS signal, so it wasn’t saved.'
        : 'A drive left open when RoadWise closed never moved, so it wasn’t saved.';
    case 'stopped':
    case 'limit':
      return reason === 'no_gps'
        ? 'Drive ended: there was no GPS signal, so it wasn’t saved.'
        : `Drive ended: the car didn’t move for ${IDLE_MIN} min, so it wasn’t saved.`;
  }
}

/**
 * The bottom-reachable Start drive button. A refused start says why in one line above the
 * button; nothing is recorded. With no refusal, a drive that was not kept says why there until OK.
 */
export function StartDriveBar({
  onStart,
  starting,
  refusal,
  onRefusalAction,
  notice,
}: {
  onStart: () => void;
  starting: boolean;
  refusal: StartRefusal | null;
  onRefusalAction: () => void;
  notice?: { message: string; onDismiss: () => void } | null;
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
      {refusal ? (
        <Banner tone="danger" message={REFUSAL_COPY[refusal]} action={action} testID="start-refusal" />
      ) : notice ? (
        <Banner tone="info" message={notice.message} action={{ label: 'OK', onPress: notice.onDismiss }} testID="drive-dropped" />
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <Button label="Start drive" icon="car-sport" size="lg" onPress={onStart} loading={starting} style={{ flex: 1 }} testID="start-drive" />
      </View>
    </View>
  );
}
