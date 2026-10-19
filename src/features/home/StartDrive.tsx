import { IDLE_END_S } from '@scoring';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, View } from 'react-native';

import type { EndCause } from '@/core/engine/engine.types';
import type { DropReason } from '@/core/engine/finalize';
import type { StartRefusalReason } from '@/drive/host';
import { Banner, Text, useTheme } from '@/ui';

export type StartRefusal = StartRefusalReason;

/** What the line under the drive card says: a refused start, or a tap on a forgot-to-start reminder whose trip is over. */
export type StartBanner = StartRefusal | 'reminder-expired';

export const REFUSAL_COPY: Record<StartBanner, string> = {
  permission: 'RoadWise needs location to record a drive.',
  precise: 'RoadWise needs Precise Location to record a drive.',
  services: 'Location Services are off. Turn them on to record a drive.',
  busy: 'A drive is already running.',
  error: 'Couldn’t start the drive. Try again.',
  'reminder-expired': 'That reminder has expired. Tap Start drive instead.',
};

const IDLE_MIN = Math.round(IDLE_END_S / 60);

/** Why the last drive was not kept, by what ended it and why it was dropped (product spec v3 Home). */
export function dropCopy(cause: EndCause, reason: DropReason): string {
  switch (cause) {
    case 'walking':
      return 'You walked away before driving, so the drive wasn’t saved.';
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
 * with an ink disc at its end carrying the car. One tap starts a drive; while the start is under
 * way the disc spins and the capsule says it is busy.
 */
export function StartDriveButton({ onStart, starting }: { onStart: () => void; starting: boolean }) {
  const t = useTheme();
  const c = t.colors;
  return (
    <Pressable
      testID="start-drive"
      accessibilityRole="button"
      accessibilityLabel="Start drive"
      accessibilityState={{ busy: starting, disabled: starting }}
      disabled={starting}
      onPress={onStart}
      style={({ pressed }) => ({
        minHeight: 60,
        borderRadius: t.radius.pill,
        borderCurve: 'continuous',
        backgroundColor: pressed ? c.primaryPressed : c.primary,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: t.space.xl,
        paddingRight: 6,
        paddingVertical: 6,
        gap: t.space.md,
        transform: [{ scale: pressed && !starting ? 0.98 : 1 }],
        boxShadow: '0px 8px 24px rgba(0, 0, 0, 0.28)',
      })}
    >
      <Text variant="headline" style={{ flex: 1, color: c.onPrimary, fontSize: 18 }} numberOfLines={2}>
        Start drive
      </Text>
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: 24,
          backgroundColor: c.onPrimary,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {starting ? <ActivityIndicator color={c.primary} /> : <Ionicons name="car-sport" size={t.size.iconLg - 4} color={c.primary} />}
      </View>
    </Pressable>
  );
}

/**
 * The line under the drive card: a refused start (the button's, or a tap on the forgot-to-start
 * reminder's) says why, with its fix; with no refusal, a drive that was not kept says why until OK.
 * Nothing is recorded either way.
 */
export function StartNotice({
  refusal,
  onRefusalAction,
  notice,
}: {
  refusal: StartBanner | null;
  onRefusalAction: () => void;
  notice?: { message: string; onDismiss: () => void } | null;
}) {
  const fixable = refusal === 'permission' || refusal === 'precise' || refusal === 'services';
  const action = fixable ? { label: 'Fix it', onPress: onRefusalAction } : refusal === 'busy' ? { label: 'Open it', onPress: onRefusalAction } : undefined;
  if (refusal) {
    return <Banner tone={refusal === 'reminder-expired' ? 'warning' : 'danger'} message={REFUSAL_COPY[refusal]} action={action} testID="start-refusal" />;
  }
  if (notice) return <Banner tone="info" message={notice.message} action={{ label: 'OK', onPress: notice.onDismiss }} testID="drive-dropped" />;
  return null;
}
