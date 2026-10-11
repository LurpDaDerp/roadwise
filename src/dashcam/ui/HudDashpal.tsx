// DashPal on the driving screen (plan §7.10): a small static chip, top right, while a DashPal is
// paired (its dot says whether it is connected), and the alert chip for 1.5 s per DashPal ALERT
// start or level change — never per repeat, never flashing. Copy and icons live here; the HUD
// decides precedence.
import { Ionicons } from '@expo/vector-icons';
import type { Tier } from '@scoring';
import { memo, useEffect, useState } from 'react';

import { ALERT_GLOW_MS } from '@/core/alerts/policy';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { fontFamilies } from '@/ui/fonts';
import { type HudPalette, tierColor } from '@/ui/drive';

import type { DashcamVisual } from '../alerts';
import { dashpalCopy } from '../copy';
import { SOUND } from '../protocol';
import type { DashcamState } from '../runtime';
import { dashcamStatus, type DashcamStatus } from './status';
import { useDashcamSelector } from './useDashcam';

/** A DashPal alert tier (1–3) as a HUD tier colour. */
export const dashpalTier = (tier: number): Tier => (tier >= 3 ? 'severe' : tier === 2 ? 'moderate' : 'minor');

const ICON: Readonly<Record<number, keyof typeof Ionicons.glyphMap>> = {
  [SOUND.GLANCE]: 'eye-off-outline',
  [SOUND.DROWSY]: 'moon-outline',
  [SOUND.WAKE]: 'alarm-outline',
  [SOUND.PHONE]: 'phone-portrait',
  [SOUND.CHIME]: 'videocam-outline',
};

const selectVisual = (s: DashcamState | null): DashcamVisual | null => s?.link.visual ?? null;
const platform: 'ios' | 'android' = Platform.OS === 'ios' ? 'ios' : 'android';
const selectChip = (s: DashcamState | null): DashcamStatus | null => (s?.link.paired ? dashcamStatus(s, platform) : null);

/**
 * The DashPal alert to show now: each new start or level change for 1.5 s, then nothing. The one
 * standing when the screen mounts is shown only for what is left of its 1.5 s.
 */
export function useDashpalFlash(now: () => number = Date.now): DashcamVisual | null {
  const visual = useDashcamSelector(selectVisual);
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (!visual) return;
    const timer = setTimeout(() => setExpired(visual.key), Math.max(0, ALERT_GLOW_MS - (now() - visual.at)));
    return () => clearTimeout(timer);
    // `key` names the alert; `now` is fixed for the screen's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visual?.key]);
  return visual && visual.key !== expired ? visual : null;
}

/** The paired dashcam's status for the chip, or null when none is paired. */
export function useDashpalChip(): DashcamStatus | null {
  return useDashcamSelector(selectChip);
}

function DashpalBannerView({ visual, palette }: { visual: DashcamVisual; palette: HudPalette }) {
  const words = dashpalCopy.alert[visual.sound] ?? dashpalCopy.name;
  return (
    <View
      testID="hud-dashpal-alert"
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`${dashpalCopy.name}: ${words}`}
      style={[styles.banner, { backgroundColor: tierColor(palette, dashpalTier(visual.tier)) }]}
    >
      <Ionicons name={ICON[visual.sound] ?? 'videocam-outline'} size={28} color={palette.ground} />
      <Text allowFontScaling={false} numberOfLines={1} style={[styles.words, { color: palette.ground }]}>
        {words}
      </Text>
    </View>
  );
}

export const DashpalHudBanner = memo(DashpalBannerView);

function DashpalChipView({ status, palette }: { status: DashcamStatus; palette: HudPalette }) {
  const dot = status.dot === 'ok' ? palette.gain : status.dot === 'bad' ? palette.severe : palette.minor;
  return (
    <View
      testID="hud-dashpal-chip"
      accessible
      accessibilityLabel={`${dashpalCopy.chip}: ${status.label}`}
      style={[styles.chip, { backgroundColor: palette.chrome, borderColor: palette.chromeEdge }]}
    >
      <View testID={`hud-dashpal-dot-${status.dot}`} style={[styles.dot, { backgroundColor: dot }]} />
      <Text allowFontScaling={false} style={[styles.chipText, { color: palette.inkMuted }]}>
        {dashpalCopy.chip}
      </Text>
    </View>
  );
}

export const DashpalChip = memo(DashpalChipView);

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 10,
    minHeight: 56,
    paddingHorizontal: 22,
    borderRadius: 28,
  },
  words: { fontFamily: fontFamilies.fieldBold, fontSize: 28, lineHeight: 34 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { fontFamily: fontFamilies.fieldBold, fontSize: 14, lineHeight: 18 },
});
