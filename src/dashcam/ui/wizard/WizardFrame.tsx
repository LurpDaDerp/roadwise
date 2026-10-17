import { useEffect, useRef, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, View, type GestureResponderEvent } from 'react-native';
import Animated, { LinearTransition, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';

const copy = dashpalCopy.wizard;

/** A downward swipe this long on the grabber asks to cancel. */
export const SWIPE_CANCEL_PT = 40;
/** The body's height follows the step over this long. */
export const BODY_RESIZE_MS = 260;

/**
 * The setup's bottom sheet, local to the wizard so it can be restyled on its own: a scrim, a panel
 * that springs up (no slide under Reduce Motion) with a grabber, a header with Cancel on the left and
 * the step number in the middle, and a body whose height follows its step. The scrim, Android back
 * and a downward swipe on the grabber all call `onRequestCancel` (the sheet decides: ask, or close).
 * `cancel` false hides Cancel (done, finishing); `overlay` (the confirmation) renders under the body,
 * which dims and goes inert meanwhile (`dimmed`). A body taller than the panel's 92% scrolls, and the
 * confirmation keeps its full height, so its buttons always stay on screen.
 */
export function WizardFrame({
  visible,
  step,
  cancel = true,
  onRequestCancel,
  overlay,
  dimmed = false,
  children,
}: {
  visible: boolean;
  step: string | null;
  cancel?: boolean;
  onRequestCancel(): void;
  overlay?: ReactNode;
  dimmed?: boolean;
  children: ReactNode;
}) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const rise = useSharedValue(th.reduceMotion ? 0 : 360);
  const swipeFrom = useRef<number | null>(null);

  useEffect(() => {
    if (!visible) {
      rise.value = th.reduceMotion ? 0 : 360;
      return;
    }
    rise.value = th.reduceMotion ? 0 : withSpring(0, th.motion.spring.gentle);
  }, [visible, th.reduceMotion, th.motion.spring.gentle, rise]);
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateY: rise.value }] }));

  const touchStart = (e: GestureResponderEvent) => {
    swipeFrom.current = e.nativeEvent.pageY;
  };
  const touchEnd = (e: GestureResponderEvent) => {
    const from = swipeFrom.current;
    swipeFrom.current = null;
    if (from !== null && e.nativeEvent.pageY - from >= SWIPE_CANCEL_PT) onRequestCancel();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onRequestCancel} testID="wizard-modal">
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cancel ? copy.cancelLabel : copy.close}
          onPress={onRequestCancel}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: th.colors.scrim }}
          testID="wizard-scrim"
        />
        <Animated.View
          accessibilityViewIsModal
          testID="wizard-sheet"
          style={[
            {
              maxHeight: '92%',
              backgroundColor: th.colors.surface,
              borderTopLeftRadius: th.radius.xl,
              borderTopRightRadius: th.radius.xl,
              borderCurve: 'continuous',
              paddingBottom: Math.max(insets.bottom, th.space.lg),
              boxShadow: th.elevation.overlay,
            },
            panelStyle,
          ]}
        >
          <View
            onTouchStart={touchStart}
            onTouchEnd={touchEnd}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ height: 28, alignItems: 'center', justifyContent: 'center' }}
            testID="wizard-grabber"
          >
            <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: th.colors.border }} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: th.size.touch, paddingHorizontal: th.space.sm }}>
            <View style={{ flex: 1, alignItems: 'flex-start' }}>
              {cancel ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.cancelLabel}
                  onPress={onRequestCancel}
                  hitSlop={8}
                  style={({ pressed }) => ({ minHeight: th.size.touch, minWidth: th.size.touch, justifyContent: 'center', paddingHorizontal: th.space.sm, opacity: pressed ? 0.6 : 1 })}
                  testID="wizard-cancel"
                >
                  <Text variant="headline" tone="accent">
                    {copy.cancel}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <Text variant="footnote" tone="muted" testID="wizard-step-number" accessibilityElementsHidden importantForAccessibility="no">
              {step ?? ''}
            </Text>
            <View style={{ flex: 1 }} />
          </View>
          {/* The body shrinks to the panel's 92% and scrolls; the confirmation keeps its height under it. */}
          <View style={{ flexShrink: 1 }} testID="wizard-body-frame">
            <ScrollView
              bounces={false}
              keyboardShouldPersistTaps="handled"
              style={{ flexGrow: 0, flexShrink: 1 }}
              contentContainerStyle={{ paddingHorizontal: th.space.lg, paddingTop: th.space.sm }}
              testID="wizard-scroll"
            >
              <Animated.View
                layout={th.reduceMotion ? undefined : LinearTransition.duration(BODY_RESIZE_MS)}
                pointerEvents={dimmed ? 'none' : 'auto'}
                importantForAccessibility={dimmed ? 'no-hide-descendants' : 'auto'}
                accessibilityElementsHidden={dimmed}
                style={{ opacity: dimmed ? 0.4 : 1 }}
                testID="wizard-body"
              >
                {children}
              </Animated.View>
            </ScrollView>
            {overlay}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}
