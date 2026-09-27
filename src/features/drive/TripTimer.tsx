import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { DriveState } from '@/drive/host';
import { fontFamilies } from '@/ui/fonts';
import { hudPalette } from '@/ui/drive';

import { hudCopy } from './hudCopy';

const DIGITS_PT = 28;

/**
 * Whole minutes driven, on the row clock — the trip began at `startedAt` and the last row is at
 * `lastRowTs`, both epoch ms on the same clock — or null with no trip. A pure selector: read
 * through `useDrive(tripMinutes)` it re-renders once a minute and never on the rows between, and
 * no timer runs at all.
 */
export function tripMinutes(s: Pick<DriveState, 'startedAt' | 'lastRowTs'>): number | null {
  if (s.startedAt === null || s.lastRowTs === null) return null;
  return Math.max(0, Math.floor((s.lastRowTs - s.startedAt) / 60_000));
}

/** Minutes as `H:MM` — "0:42", "1:07", "12:00". Never negative. */
export function formatMinutes(minutes: number): string {
  const m = Number.isFinite(minutes) ? Math.max(0, Math.floor(minutes)) : 0;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** The trip's running time, bottom centre of the HUD, in the quiet ink. */
export const TripTimer = memo(function TripTimer({
  minutes,
  night,
}: {
  minutes: number | null;
  night: boolean;
}) {
  if (minutes === null) return <View style={styles.slot} />;
  const p = hudPalette(night);
  return (
    <View
      testID="hud-timer"
      accessible
      accessibilityRole="text"
      accessibilityLabel={hudCopy.hud.timerLabel(Math.floor(minutes / 60), minutes % 60)}
      style={styles.slot}
    >
      <Text allowFontScaling={false} style={[styles.digits, { color: p.inkMuted }]}>
        {formatMinutes(minutes)}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  slot: { minWidth: 96, alignItems: 'center', justifyContent: 'center' },
  digits: {
    fontFamily: fontFamilies.numerals,
    fontSize: DIGITS_PT,
    lineHeight: Math.round(DIGITS_PT * 1.2),
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
  },
});
