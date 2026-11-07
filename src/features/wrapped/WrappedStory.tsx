import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, useWindowDimensions, View, type GestureResponderEvent } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Text, useTheme, withAlpha } from '@/ui';

import { wrappedCopy as copy } from './copy';

/** Each slide shows this long before the next one, when the story plays on its own. */
export const SLIDE_MS = 6000;
/** A press held this long pauses the story until it lets go. */
export const HOLD_MS = 250;
/** A swipe down this far (or this fast) closes the story. */
export const CLOSE_SWIPE_DY = 80;
/** A move down this far starts the swipe (shorter ones stay taps). */
const SWIPE_SLOP = 12;

const WHITE = '#FFFFFF';

export interface StorySlide {
  id: string;
  node: ReactNode;
}

/** VoiceOver (TalkBack) is on. */
export function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((v) => {
        if (live) setOn(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', (v: boolean) => setOn(v));
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return on;
}

function Segment({ state, fill }: { state: 'done' | 'current' | 'todo'; fill: SharedValue<number> | null }) {
  const style = useAnimatedStyle(() => ({ width: `${(fill ? fill.get() : state === 'todo' ? 0 : 1) * 100}%` }));
  return (
    <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: withAlpha(WHITE, 0.35), overflow: 'hidden' }}>
      <Animated.View style={[{ height: 3, backgroundColor: WHITE }, state === 'current' && fill ? style : { width: state === 'todo' ? '0%' : '100%' }]} />
    </View>
  );
}

/**
 * The Wrapped story player: full screen on the archetype's gradient, segmented bars at the top, a
 * header and ✕. A tap on the right half goes on, on the left half back; holding pauses; a swipe down
 * or ✕ closes. It plays on its own (`SLIDE_MS` a slide, the last slide stays) except under Reduce
 * Motion or with a screen reader on: then only taps (and the Back and Next buttons a screen reader
 * gets) move it, and each move puts the screen reader's focus on the bars ("Slide 3 of 10"), just
 * above the new slide. During a drive the drive's hold on the app (`LockoutGate`) keeps it off screen.
 */
export function WrappedStory({
  slides,
  stops,
  header,
  onClose,
  testID = 'wrapped-story',
}: {
  slides: readonly StorySlide[];
  stops: readonly [string, string, string];
  header: string;
  onClose: () => void;
  testID?: string;
}) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const reader = useScreenReader();
  const auto = !t.reduceMotion && !reader;
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const last = slides.length - 1;
  const at = Math.min(index, Math.max(0, last));

  // How long the slide `at` has shown (kept across a pause); a move starts the next one from 0.
  const shown = useRef({ at: 0, ms: 0 });
  const fill = useSharedValue(0);
  const goTo = useCallback(
    (i: number) => {
      const n = Math.max(0, Math.min(last, i));
      // Back on the first slide (or on past the last) stays put: the slide's timer and bar keep running.
      if (n === at) return;
      shown.current = { at: n, ms: 0 };
      cancelAnimation(fill);
      fill.set(0);
      setIndex(n);
    },
    [fill, last, at]
  );
  const next = useCallback(() => goTo(at + 1), [goTo, at]);
  const back = useCallback(() => goTo(at - 1), [goTo, at]);

  // With a screen reader on, a move puts its focus on the bars ("Slide 3 of 10"), just above the new
  // slide, so the move is heard and the slide reads on from there (not on opening: the screen's own
  // focus rules then).
  const progress = useRef<View>(null);
  const focusedAt = useRef(at);
  useEffect(() => {
    if (focusedAt.current === at) return;
    focusedAt.current = at;
    if (reader && progress.current) AccessibilityInfo.sendAccessibilityEvent(progress.current, 'focus');
  }, [at, reader]);

  const playing = auto && !held && at < last;
  useEffect(() => {
    if (!playing) return;
    if (shown.current.at !== at) shown.current = { at, ms: 0 };
    const started = Date.now();
    const left = Math.max(0, SLIDE_MS - shown.current.ms);
    fill.set(shown.current.ms / SLIDE_MS);
    fill.set(withTiming(1, { duration: left, easing: Easing.linear }));
    const timer = setTimeout(() => goTo(at + 1), left);
    return () => {
      clearTimeout(timer);
      cancelAnimation(fill);
      // Only a pause keeps the time: after a move the next slide starts afresh.
      if (shown.current.at === at) shown.current.ms += Date.now() - started;
    };
  }, [playing, at, fill, goTo]);

  // A swipe down closes: the root watches every touch start (without taking it) and takes over a
  // move that goes mostly downward; taps and holds stay with the slide area below.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const swipe = {
    onStartShouldSetResponderCapture: (e: GestureResponderEvent) => {
      touchStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
      return false;
    },
    onMoveShouldSetResponderCapture: (e: GestureResponderEvent) => {
      const s = touchStart.current;
      if (!s) return false;
      const dy = e.nativeEvent.pageY - s.y;
      return dy > SWIPE_SLOP && dy > 2 * Math.abs(e.nativeEvent.pageX - s.x);
    },
    onResponderTerminationRequest: () => false,
    onResponderRelease: (e: GestureResponderEvent) => {
      const s = touchStart.current;
      touchStart.current = null;
      if (s && e.nativeEvent.pageY - s.y > CLOSE_SWIPE_DY) onClose();
    },
  };

  const wasHeld = useRef(false);
  const onPress = (e: GestureResponderEvent) => {
    if (wasHeld.current) return;
    if (e.nativeEvent.pageX < width / 2) back();
    else next();
  };

  const slide = slides[at];
  return (
    <View style={{ flex: 1, backgroundColor: stops[2] }} testID={testID} {...swipe}>
      {/* The gradients are always dark: light status bar ink while the story is up. */}
      <StatusBar style="light" animated />
      <LinearGradient colors={stops} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom', 'left', 'right']}>
        <View style={{ paddingHorizontal: t.space.md, paddingTop: t.space.sm, gap: t.space.sm }}>
          <View ref={progress} style={{ flexDirection: 'row', gap: 4 }} accessible accessibilityLabel={copy.slideOf(at + 1, slides.length)} testID={`${testID}-progress`}>
            {slides.map((s, i) => (
              <Segment key={s.id} state={i < at ? 'done' : i === at ? 'current' : 'todo'} fill={i === at && auto && at < last ? fill : null} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: t.size.touch }}>
            <Text variant="headline" style={{ flex: 1, color: WHITE }} numberOfLines={1} accessibilityRole="header" testID={`${testID}-header`}>
              {header}
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={copy.close}
              hitSlop={8}
              style={({ pressed }) => ({ width: t.size.touch, height: t.size.touch, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
              testID={`${testID}-close`}
            >
              <Ionicons name="close" size={28} color={WHITE} />
            </Pressable>
          </View>
        </View>
        <Pressable
          style={{ flex: 1 }}
          accessible={false}
          onPress={onPress}
          delayLongPress={HOLD_MS}
          onLongPress={() => {
            wasHeld.current = true;
            setHeld(true);
          }}
          onPressOut={() => {
            if (!wasHeld.current) return;
            setHeld(false);
            // The release that ends a hold is not a tap.
            setTimeout(() => {
              wasHeld.current = false;
            }, 0);
          }}
          testID={`${testID}-slide`}
        >
          <View key={slide?.id} style={{ flex: 1, paddingHorizontal: t.space.xl, paddingVertical: t.space.lg }} testID={slide ? `wrapped-slide-${slide.id}` : undefined}>
            {slide?.node}
          </View>
        </Pressable>
        {reader ? (
          <View style={{ flexDirection: 'row', gap: t.space.md, paddingHorizontal: t.space.xl, paddingBottom: t.space.md }}>
            <StoryButton label={copy.previous} onPress={back} disabled={at === 0} testID={`${testID}-back`} />
            <StoryButton label={copy.next} onPress={next} disabled={at === last} testID={`${testID}-next`} />
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

/** A white-outlined button on the gradient. */
export function StoryButton({ label, onPress, disabled, icon, filled, testID }: { label: string; onPress: () => void; disabled?: boolean; icon?: keyof typeof Ionicons.glyphMap; filled?: boolean; testID?: string }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: t.size.touch,
        borderRadius: t.radius.pill,
        borderWidth: 1.5,
        borderColor: WHITE,
        backgroundColor: filled ? WHITE : 'transparent',
        flexDirection: 'row',
        gap: t.space.sm,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: t.space.lg,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
      testID={testID}
    >
      {icon ? <Ionicons name={icon} size={20} color={filled ? '#111113' : WHITE} /> : null}
      <Text variant="headline" style={{ color: filled ? '#111113' : WHITE }}>
        {label}
      </Text>
    </Pressable>
  );
}
