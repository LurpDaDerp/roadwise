import { MaterialCommunityIcons } from '@expo/vector-icons';
import { memo, useLayoutEffect, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AlertDecision, AlertKind } from '@/core/alerts/types';

import { fontFamilies } from '../fonts';
import { tokens } from '../tokens';
import { overlayWords } from './hudSelectors';
import {
  hudPalette,
  OVERLAY_WORDS_CRITICAL_PT,
  OVERLAY_WORDS_PT,
  type HudPalette,
} from './hudTokens';

export type AlertOverlayProps = {
  /** The host's `activeAlert`: the decision now showing, or null. */
  decision: AlertDecision | null;
  night: boolean;
  reduceMotion: boolean;
};

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

/** One drawn mark per alert kind, in the HUD's one icon family. States a condition, never a manoeuvre (SR6). */
export const ALERT_ICON: Record<AlertKind, IconName> = {
  speeding: 'speedometer',
  phone: 'cellphone',
  eyes_off: 'eye-off',
  drowsy: 'sleep',
  break: 'coffee',
};

/** SR3 allows state transitions up to 300 ms; the fade is the fast token, well inside it. */
export const ALERT_FADE_MS = tokens.motion.fast;
const L1_FRAME = 12;

/**
 * The C5 alert layer, over the HUD. The three levels differ by shape and position as well as
 * colour, so each is recognisable without colour vision and in peripheral vision:
 * - L1 advisory: a border tint round the whole screen and the kind's mark in a corner, no words;
 * - L2 warning: a full-width band across the top, mark + at most three words;
 * - L3 critical: a full-screen high-contrast panel, large mark + at most three words.
 *
 * It never takes a touch (the long-press mute lives beneath it, U2). It appears with one short
 * fade per decision — never a pulse, never a repeat at 1 Hz — and instantly under reduce motion.
 * Sound and haptics are the player's (P2); this is the visual channel only.
 */
function AlertOverlayView({ decision, night, reduceMotion }: AlertOverlayProps) {
  const [opacity] = useState(() => new Animated.Value(reduceMotion ? 1 : 0));
  const id = decision?.id ?? null;

  // A layout effect, not a passive one: it runs in the commit, before the frame is painted. With
  // `useEffect` a new decision would paint once at the previous value (1 — the last fade's end),
  // then drop to 0 and fade in: a one-frame blink, worst for the full-screen L3 (U1 review M1).
  // Keyed on `id`, so it also resets when decision B replaces A while A is still showing.
  useLayoutEffect(() => {
    if (id === null) return;
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0);
    const fade = Animated.timing(opacity, {
      toValue: 1,
      duration: ALERT_FADE_MS,
      useNativeDriver: true,
    });
    fade.start();
    return () => fade.stop();
  }, [id, reduceMotion, opacity]);

  if (!decision) return null;
  const p = hudPalette(night);

  return (
    <Animated.View
      testID="hud-alert"
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { opacity: reduceMotion ? 1 : opacity }]}
    >
      {decision.level === 1 ? (
        <L1 decision={decision} p={p} />
      ) : decision.level === 2 ? (
        <L2 decision={decision} p={p} />
      ) : (
        <L3 decision={decision} p={p} />
      )}
    </Animated.View>
  );
}

function L1({ decision, p }: { decision: AlertDecision; p: HudPalette }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="hud-alert-l1"
      accessible
      accessibilityRole="alert"
      accessibilityLabel={overlayWords(decision)}
      style={[styles.fill, styles.l1, { borderColor: p.attention }]}
    >
      <View
        style={[
          styles.l1Badge,
          {
            backgroundColor: p.attention,
            top: 12 + insets.top,
            right: 12 + insets.right,
          },
        ]}
      >
        <MaterialCommunityIcons
          testID="hud-alert-icon"
          name={ALERT_ICON[decision.kind]}
          size={36}
          color={p.attentionInk}
        />
      </View>
    </View>
  );
}

function L2({ decision, p }: { decision: AlertDecision; p: HudPalette }) {
  const words = overlayWords(decision);
  // The band starts at the screen's top edge and pads its print clear of the notch / island.
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="hud-alert-l2"
      accessible
      accessibilityRole="alert"
      accessibilityLabel={words}
      style={[
        styles.band,
        {
          backgroundColor: p.attention,
          paddingTop: 20 + insets.top,
          paddingLeft: 24 + insets.left,
          paddingRight: 24 + insets.right,
        },
      ]}
    >
      <MaterialCommunityIcons
        testID="hud-alert-icon"
        name={ALERT_ICON[decision.kind]}
        size={44}
        color={p.attentionInk}
      />
      <Text
        testID="hud-alert-words"
        allowFontScaling={false}
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[styles.words, { color: p.attentionInk, fontSize: OVERLAY_WORDS_PT }]}
      >
        {words}
      </Text>
    </View>
  );
}

function L3({ decision, p }: { decision: AlertDecision; p: HudPalette }) {
  const words = overlayWords(decision);
  return (
    <View
      testID="hud-alert-l3"
      accessible
      accessibilityRole="alert"
      accessibilityLabel={words}
      style={[styles.fill, styles.panel, { backgroundColor: p.critical }]}
    >
      <MaterialCommunityIcons
        testID="hud-alert-icon"
        name={ALERT_ICON[decision.kind]}
        size={112}
        color={p.criticalInk}
      />
      <Text
        testID="hud-alert-words"
        allowFontScaling={false}
        numberOfLines={2}
        adjustsFontSizeToFit
        style={[
          styles.words,
          styles.wordsCritical,
          { color: p.criticalInk, fontSize: OVERLAY_WORDS_CRITICAL_PT },
        ]}
      >
        {words}
      </Text>
    </View>
  );
}

/** Keyed on the decision, not its object: the host republishes the same alert every second. */
function propsEqual(a: AlertOverlayProps, b: AlertOverlayProps): boolean {
  return (
    a.night === b.night &&
    a.reduceMotion === b.reduceMotion &&
    (a.decision?.id ?? null) === (b.decision?.id ?? null) &&
    a.decision?.level === b.decision?.level &&
    a.decision?.kind === b.decision?.kind &&
    a.decision?.voice === b.decision?.voice
  );
}

export const AlertOverlay = memo(AlertOverlayView, propsEqual);

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 },
  l1: {
    borderWidth: L1_FRAME,
    borderRadius: 28,
  },
  l1Badge: {
    position: 'absolute',
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  band: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    minHeight: 112,
    paddingBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  panel: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 24,
  },
  words: {
    fontFamily: fontFamilies.fieldBold,
    flexShrink: 1,
  },
  wordsCritical: {
    textAlign: 'center',
  },
});
