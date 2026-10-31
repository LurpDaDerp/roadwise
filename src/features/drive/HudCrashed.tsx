import type { ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { reportError } from '@/lib/crashReport';
import { HUD_MIN_TARGET_PT, hudPalette } from '@/ui/drive';
import { fontFamilies } from '@/ui/fonts';
import { useOptionalTheme } from '@/ui/theme';

import { hudCopy } from './hudCopy';

/** The Try again target: the HUD's 64 pt height, and wide enough to hit without looking. */
export const HUD_CRASHED_TARGET_W_PT = 240;

/**
 * The driving screen's error boundary (Expo Router's `ErrorBoundary` export of `app/drive/_layout`):
 * the driving screen threw while drawing. Only the screen is lost: the drive itself records in the
 * drive host, outside React, so it neither ends nor is discarded here, and the root's drive hold
 * (`LockoutGate`) still keeps the screen awake, swallows Android back and holds the app on this
 * route. In-car rules: three words and two, one 64 pt target, nothing moves. The one action is
 * Try again, which draws the driving screen again; there is no way Home from here, because the
 * hold would send a moving driver straight back. The error goes to the crash sink once.
 */
export function HudCrashed({ error, retry }: ErrorBoundaryProps) {
  const night = useOptionalTheme()?.hudNight ?? false;
  const p = hudPalette(night);
  useEffect(() => {
    reportError(error, 'driving screen');
  }, [error]);
  return (
    <SafeAreaView style={[styles.ground, { backgroundColor: p.ground }]} testID="hud-crashed">
      <StatusBar style="light" />
      <View style={styles.body} accessible accessibilityLabel={hudCopy.crashed.spoken}>
        <Text
          style={[styles.title, { color: p.ink }]}
          accessibilityRole="header"
          maxFontSizeMultiplier={1.5}
        >
          {hudCopy.crashed.title}
        </Text>
      </View>
      <Pressable
        testID="hud-crashed-retry"
        accessibilityRole="button"
        accessibilityLabel={hudCopy.crashed.retry}
        accessibilityHint={hudCopy.crashed.retryHint}
        onPress={() => void retry()}
        style={[styles.button, { backgroundColor: p.chrome, borderColor: p.chromeEdge }]}
      >
        <Text style={[styles.label, { color: p.ink }]} maxFontSizeMultiplier={1.5}>
          {hudCopy.crashed.retry}
        </Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 32 },
  body: { alignItems: 'center' },
  title: { fontFamily: fontFamilies.headline, fontSize: 34, lineHeight: 40, textAlign: 'center' },
  button: {
    minHeight: HUD_MIN_TARGET_PT,
    minWidth: HUD_CRASHED_TARGET_W_PT,
    paddingHorizontal: 32,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontFamily: fontFamilies.label, fontSize: 26, lineHeight: 32 },
});
