// The waiting panels (modes plan §3.7): a Start drive swipe waits up to 5 minutes for the car to
// move. At 2:00 with no driving and no touch, "Still planning to drive?" asks (Keep waiting /
// Cancel); from 4:30 it counts down the last 30 s ("Stopping in 0:27"). Any touch on the screen
// waits a fresh 5 minutes (the screen's own touch handler), and the panel closes; Cancel stops the
// wait, nothing saved. Each panel opens with one light haptic. It sits where the navigation list
// does (the two never show together) in the app's own sheet colours, and shows only with the car
// still, before a drive confirms.
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { WAIT_TOTAL_MS, type WaitingPublic } from '@/drive/waiting';
import { fontFamilies } from '@/ui/fonts';

import { hudCopy } from './hudCopy';
import { useAppActive } from './useHaloBurst';

export interface WaitPanelColors {
  surface: string;
  ink: string;
  muted: string;
  edge: string;
}

/** Below this height the panel puts its two buttons side by side and shrinks the countdown. */
const TALL_PT = 260;
const BUTTON_PT = 56;

/** Minutes left of the wait, rounded up (at 2:00 in: 3). */
export const waitMinutesLeft = (since: number, now: number): number => Math.max(1, Math.ceil((since + WAIT_TOTAL_MS - now) / 60_000));
/** Seconds left of the wait, rounded up, never under 0. */
export const waitSecondsLeft = (since: number, now: number): number => Math.max(0, Math.ceil((since + WAIT_TOTAL_MS - now) / 1000));
/** "0:27". */
export const countdownText = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** The clock, re-read every second while the panel shows. */
function useSecondClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function WaitPanel({
  waiting,
  colors: c,
  height,
  onKeep,
  onCancel,
}: {
  waiting: WaitingPublic & { phase: 'popup' | 'countdown' };
  colors: WaitPanelColors;
  /** The panel's height (`hudLayout` `panel.h`): a short one goes compact. */
  height: number;
  onKeep(): void;
  onCancel(): void;
}) {
  const now = useSecondClock();
  const active = useAppActive();
  const { phase, since } = waiting;
  const countdown = phase === 'countdown';
  const seconds = waitSecondsLeft(since, now);
  const minutes = waitMinutesLeft(since, now);
  const tall = height >= TALL_PT;

  // One light haptic as each panel opens (only with RoadWise in front), and its words read out.
  useEffect(() => {
    if (!active) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const t = Date.now();
    const words = countdown ? hudCopy.countdown.spoken(waitSecondsLeft(since, t)) : `${hudCopy.ask.title} ${hudCopy.ask.body(waitMinutesLeft(since, t))}`;
    AccessibilityInfo.announceForAccessibility?.(words);
    // once per panel (a phase), not per second
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, since]);

  return (
    <ScrollView testID="hud-wait-panel" style={styles.scroll} contentContainerStyle={[styles.body, { gap: tall ? 12 : 8 }]}>
      <Text accessibilityRole="header" style={[styles.title, { color: c.ink }]}>
        {countdown ? hudCopy.countdown.title : hudCopy.ask.title}
      </Text>
      {countdown ? (
        <View accessible accessibilityLabel={hudCopy.countdown.spoken(seconds)} accessibilityLiveRegion="polite">
          <Text testID="hud-wait-countdown" allowFontScaling={false} style={[styles.count, { color: c.ink, fontSize: tall ? 44 : 32, lineHeight: tall ? 50 : 36 }]}>
            {countdownText(seconds)}
          </Text>
          <Text style={[styles.body1, { color: c.muted }]}>{hudCopy.countdown.body}</Text>
        </View>
      ) : (
        <Text testID="hud-wait-body" style={[styles.body1, { color: c.muted }]}>
          {hudCopy.ask.body(minutes)}
        </Text>
      )}
      <View style={[styles.buttons, { flexDirection: tall ? 'column' : 'row' }]}>
        <Pressable
          testID="hud-wait-keep"
          accessibilityRole="button"
          accessibilityLabel={hudCopy.ask.keep}
          onPress={onKeep}
          style={({ pressed }) => [styles.button, !tall && styles.half, { backgroundColor: c.ink, borderColor: c.ink, opacity: pressed ? 0.8 : 1 }]}
        >
          <Text style={[styles.label, { color: c.surface }]}>{hudCopy.ask.keep}</Text>
        </Pressable>
        <Pressable
          testID="hud-wait-cancel"
          accessibilityRole="button"
          accessibilityLabel={hudCopy.ask.cancel}
          // Cancel is the one touch on this screen that is not a "keep waiting": it stops here.
          onTouchStart={(e) => e.stopPropagation()}
          onPress={onCancel}
          style={({ pressed }) => [styles.button, !tall && styles.half, { borderColor: c.edge, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={[styles.label, { color: c.ink }]}>{hudCopy.ask.cancel}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { flexGrow: 0 },
  title: { fontFamily: fontFamilies.headline, fontSize: 22, lineHeight: 28 },
  count: { fontFamily: fontFamilies.numeralsBold, fontVariant: ['tabular-nums'] },
  body1: { fontFamily: fontFamilies.ui, fontSize: 16, lineHeight: 22 },
  buttons: { gap: 8 },
  button: { minHeight: BUTTON_PT, alignItems: 'center', justifyContent: 'center', borderRadius: BUTTON_PT / 2, borderWidth: 1, paddingHorizontal: 16 },
  half: { flex: 1 },
  label: { fontFamily: fontFamilies.headline, fontSize: 18 },
});
