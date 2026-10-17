import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  type GestureResponderEvent,
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';
import { IconButton } from './IconButton';
import { Text } from './Text';

export type SheetProps = {
  visible: boolean;
  /** Called by the close button, a tap on the scrim, a drag down, the screen reader's escape and Android back. */
  onClose: () => void;
  title?: string;
  /** A line under the title. */
  subtitle?: string;
  children: ReactNode;
  /** Wrap the content in a ScrollView (long lists such as report reasons). Default false. */
  scroll?: boolean;
  /**
   * Pinned under the content, above the home indicator: the sheet's one primary action (a full
   * width ink capsule). It stays put while the content scrolls and rises with the keyboard.
   */
  footer?: ReactNode;
  /** False keeps the sheet open against the scrim, a drag and the close button (a step that must finish). */
  dismissible?: boolean;
  /** Hide the close button (the grabber and the scrim still close it). */
  hideClose?: boolean;
  /** Layout for the content column. */
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

/** How far down a drag has to travel (or how fast) before the sheet closes. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 1.1;
/** Exits are faster than entrances. */
const EXIT_MS = 220;

/**
 * The bottom sheet: a rounded panel that rises over a dimmed page, with a grabber, a title row
 * with a round close button, optional scrolling content and an optional pinned footer.
 *
 * - Enter: the scrim fades and the panel springs up; exit: it slides down faster than it came.
 *   Under Reduce Motion it only fades.
 * - Drag the grabber or the title row down to close (a short drag springs back). Tap the scrim,
 *   press the close button, Android back, or the screen reader's escape gesture all close it too.
 * - Keyboard-safe: the panel lifts above the keyboard; `keyboardShouldPersistTaps` keeps a tap on
 *   a button working while a field is focused.
 * - The panel is a modal for VoiceOver / TalkBack and announces its title as a header.
 *
 * Built on `Modal` + Reanimated so it needs no extra dependency and renders under Jest.
 */
export function BottomSheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  scroll = false,
  footer,
  dismissible = true,
  hideClose = false,
  contentStyle,
  testID,
}: SheetProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();
  const offscreen = Math.max(400, screenH);
  const y = useSharedValue(t.reduceMotion ? 0 : offscreen);
  const fade = useSharedValue(0);
  // Stays mounted through the exit so the panel can leave instead of vanishing.
  const [mounted, setMounted] = useState(visible);
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) setMounted(true);
  }

  const still = t.reduceMotion;
  useEffect(() => {
    if (visible) {
      fade.value = withTiming(1, { duration: t.motion.base });
      y.value = still ? 0 : withSpring(0, t.motion.spring.gentle);
      return;
    }
    fade.value = withTiming(0, { duration: EXIT_MS });
    y.value = still ? 0 : withTiming(offscreen, { duration: EXIT_MS, easing: Easing.in(Easing.cubic) });
    const timer = setTimeout(() => setMounted(false), still ? 0 : EXIT_MS);
    return () => clearTimeout(timer);
  }, [visible, still, offscreen, t.motion.base, t.motion.spring.gentle, y, fade]);

  // Drag-to-close on the grabber and title row, through the plain responder props: the start of
  // the touch, and the last move, give the distance and the speed at release.
  const touch = useRef<{ y0: number; y: number; t: number; vy: number } | null>(null);
  const settle = () => y.set(withSpring(0, { damping: 22, stiffness: 260, mass: 1 }));
  const dragHandlers = {
    onMoveShouldSetResponder: (e: GestureResponderEvent) => {
      const start = touch.current;
      return !!start && e.nativeEvent.pageY - start.y0 > 6;
    },
    onTouchStart: (e: GestureResponderEvent) => {
      const py = e.nativeEvent.pageY;
      touch.current = { y0: py, y: py, t: e.nativeEvent.timestamp, vy: 0 };
    },
    onResponderMove: (e: GestureResponderEvent) => {
      const s = touch.current;
      if (!s) return;
      const py = e.nativeEvent.pageY;
      const dt = Math.max(1, e.nativeEvent.timestamp - s.t);
      touch.current = { ...s, y: py, t: e.nativeEvent.timestamp, vy: (py - s.y) / dt };
      const dy = py - s.y0;
      // Down follows the finger; up gives only a little, so the sheet feels anchored.
      y.set(dy > 0 ? dy : dy / 6);
    },
    onResponderRelease: () => {
      const s = touch.current;
      touch.current = null;
      if (!s) return;
      const dy = s.y - s.y0;
      if (dismissible && (dy > DISMISS_DISTANCE || s.vy > DISMISS_VELOCITY)) onClose();
      else settle();
    },
    onResponderTerminate: () => {
      touch.current = null;
      settle();
    },
  };

  const panel = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const scrim = useAnimatedStyle(() => ({ opacity: fade.value }));

  const content = (
    <View style={[{ gap: t.space.lg, paddingHorizontal: t.space.xl, paddingBottom: footer ? t.space.md : 0 }, contentStyle]}>
      {children}
    </View>
  );
  const close = () => {
    if (dismissible) onClose();
  };

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}
    >
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View
          style={[{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: t.colors.scrim }, scrim]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            importantForAccessibility="no"
            accessibilityElementsHidden
            onPress={close}
            style={{ flex: 1 }}
          />
        </Animated.View>
        <Animated.View
          testID={testID}
          accessibilityViewIsModal
          onAccessibilityEscape={close}
          style={[
            {
              maxHeight: '92%',
              marginHorizontal: t.space.sm,
              marginBottom: t.space.sm,
              backgroundColor: t.colors.surface,
              borderRadius: t.radius.xl,
              borderCurve: 'continuous',
              borderWidth: t.scheme === 'dark' ? 1 : 0,
              borderColor: t.colors.divider,
              paddingBottom: Math.max(insets.bottom - t.space.sm, t.space.lg),
              boxShadow: t.elevation.overlay,
              overflow: 'hidden',
            },
            panel,
          ]}
        >
          <View {...dragHandlers} testID={testID ? `${testID}-handle` : undefined} style={{ paddingTop: t.space.sm, gap: t.space.xs }}>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no"
              testID={testID ? `${testID}-grabber` : undefined}
              style={{
                alignSelf: 'center',
                width: 44,
                height: 5,
                borderRadius: 3,
                backgroundColor: t.colors.border,
              }}
            />
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: t.space.md,
                paddingLeft: t.space.xl,
                paddingRight: t.space.md,
                paddingBottom: t.space.sm,
                minHeight: 52,
              }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                {title ? (
                  <Text variant="title2" accessibilityRole="header">
                    {title}
                  </Text>
                ) : null}
                {subtitle ? (
                  <Text variant="subhead" tone="muted">
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              {hideClose || !dismissible ? null : (
                <IconButton icon="close" accessibilityLabel="Close" onPress={onClose} variant="surface" size={40} />
              )}
            </View>
          </View>
          {scroll ? (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: t.space.sm }}>
              {content}
            </ScrollView>
          ) : (
            content
          )}
          {footer ? <View style={{ paddingHorizontal: t.space.xl, paddingTop: t.space.sm, gap: t.space.sm }}>{footer}</View> : null}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** The sheet under its original name. */
export const Sheet = BottomSheet;
