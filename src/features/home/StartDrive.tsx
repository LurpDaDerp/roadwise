import { IDLE_END_S } from '@scoring';
import { View } from 'react-native';

import type { EndCause } from '@/core/engine/engine.types';
import type { DropReason } from '@/core/engine/finalize';
import type { StartRefusalReason } from '@/drive/host';
import { Banner, SwipeButton, Text, useTheme } from '@/ui';

import { homeCopy } from './copy';

export type StartRefusal = StartRefusalReason;

export const REFUSAL_COPY: Record<StartRefusal, string> = {
  permission: 'RoadWise needs location to record a drive.',
  precise: 'RoadWise needs Precise Location to record a drive.',
  services: 'Location Services are off. Turn them on to record a drive.',
  busy: 'A drive is already running.',
  error: 'Couldn’t start the drive. Try again.',
};

const IDLE_MIN = Math.round(IDLE_END_S / 60);

/** Why the last drive was not kept, by what ended it and why it was dropped (product spec v3 Home). */
export function dropCopy(cause: EndCause, reason: DropReason): string {
  // A Start-card drive under 0.5 mi and 2 min, however it ended.
  if (reason === 'too_short') return 'The drive was too short, so it wasn’t saved.';
  switch (cause) {
    case 'walking':
    case 'manual':
      if (reason === 'no_gps') return 'There was no GPS signal, so the drive wasn’t saved.';
      return reason === 'not_driven' ? 'The car never reached driving speed, so the drive wasn’t saved.' : 'The car never moved, so the drive wasn’t saved.';
    case 'orphan':
      if (reason === 'no_gps') return 'RoadWise closed during a drive with no GPS signal, so it wasn’t saved.';
      return reason === 'not_driven'
        ? 'RoadWise closed during a drive that never reached driving speed, so it wasn’t saved.'
        : 'RoadWise closed during a drive that never moved, so it wasn’t saved.';
    case 'stopped':
    case 'limit':
      if (reason === 'no_gps') return 'Drive ended: there was no GPS signal, so it wasn’t saved.';
      return reason === 'not_driven'
        ? 'Drive ended: the car never reached driving speed, so it wasn’t saved.'
        : `Drive ended: the car didn’t move for ${IDLE_MIN} min, so it wasn’t saved.`;
  }
}

/**
 * Start drive, the hero action at the foot of Home's drive card: a paper capsule across the scene
 * with an ink disc at its left carrying the car and the words to its right. The driver swipes the
 * car right to start a drive (it records from the swipe and is saved once the car drives), opening the
 * sky's accent behind it, with a success haptic as it lands; a tap does nothing. While the start
 * is under way the disc sits at the end and spins.
 */
export function StartDriveButton({ onStart, starting }: { onStart: () => void; starting: boolean }) {
  const t = useTheme();
  const c = t.colors;
  return (
    <View style={{ borderRadius: t.radius.pill, boxShadow: '0px 8px 24px rgba(0, 0, 0, 0.28)' }}>
      <SwipeButton
        testID="start-drive"
        accessibilityLabel={homeCopy.start.label}
        accessibilityHint={homeCopy.start.hint}
        icon="car-sport"
        colors={{ track: c.primary, fill: c.accent, knob: c.onPrimary, knobInk: c.primary, hint: c.onPrimary }}
        height={64}
        busy={starting}
        onSwipe={onStart}
        label={
          <Text variant="headline" style={{ color: c.onPrimary, fontSize: 18 }} numberOfLines={1}>
            {homeCopy.start.label}
          </Text>
        }
      />
    </View>
  );
}

/**
 * The line under the drive card: a refused start says why, with its fix (or OK where there is none:
 * `onRefusalAction` then takes it down); with no refusal, an information line (the "Not driving?"
 * acknowledgement, or why a started drive was not kept) stays until OK. Nothing is recorded either way.
 */
export function StartNotice({
  refusal,
  onRefusalAction,
  notice,
}: {
  refusal: StartRefusal | null;
  onRefusalAction: () => void;
  notice?: { message: string; onDismiss: () => void; testID?: string } | null;
}) {
  const fixable = refusal === 'permission' || refusal === 'precise' || refusal === 'services';
  const action = { label: fixable ? 'Fix it' : refusal === 'busy' ? 'Open it' : homeCopy.notices.ok, onPress: onRefusalAction };
  if (refusal) return <Banner tone="danger" message={REFUSAL_COPY[refusal]} action={action} testID="start-refusal" />;
  if (notice) {
    return <Banner tone="info" message={notice.message} action={{ label: homeCopy.notices.ok, onPress: notice.onDismiss }} testID={notice.testID ?? 'drive-dropped'} />;
  }
  return null;
}
