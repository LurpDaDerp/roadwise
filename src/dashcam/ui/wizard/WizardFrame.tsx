import { useEffect, useRef, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, View, type GestureResponderEvent } from 'react-native';
import Animated, { LayoutAnimationConfig, LinearTransition, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StepDots, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';

const copy = dashpalCopy.wizard;

/** A downward swipe this long on the grabber asks to cancel. */
export const SWIPE_CANCEL_PT = 40;
/** The body's height follows the step over this long. */
export const BODY_RESIZE_MS = 260;

/**
 * The setup's bottom sheet, in the app's BottomSheet look (a floating rounded panel over a scrim,
 * a grabber, ink step pills) but with the setup's own rules: the header has Cancel on the left as a
 * paper capsule and the step pills in the middle, and the body's height follows its step. As with
 * BottomSheet, the system modal fades the scrim and panel in and out (no motion under Reduce
 * Motion) and the panel rests in place from the first frame: nothing it needs to be seen waits on a
 * JS-driven animation, and the first step shows without its slide-in (later steps slide). The scrim, Android back and a downward swipe on
 * the grabber all call `onRequestCancel` (the sheet decides: ask, or close); the panel follows a
 * swipe down and springs back, since closing always asks first.
 * `cancel` false hides Cancel (done, finishing); `overlay` (the confirmation) renders under the body,
 * which dims and goes inert meanwhile (`dimmed`). A body taller than the panel's 92% scrolls, and the
 * confirmation keeps its full height, so its buttons always stay on screen.
 */
export function WizardFrame({
  visible,
  step,
  stepIndex = null,
  stepCount = 0,
  cancel = true,
  onRequestCancel,
  overlay,
  dimmed = false,
  children,
}: {
  visible: boolean;
  /** The step's spoken name ("Step 1 of 3"), or null. */
  step: string | null;
  /** The step's number (1-based) for the pills, or null for none. */
  stepIndex?: number | null;
  stepCount?: number;
  cancel?: boolean;
  onRequestCancel(): void;
  overlay?: ReactNode;
  dimmed?: boolean;
  children: ReactNode;
}) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  // Only a swipe moves the panel; at rest it sits at 0.
  const rise = useSharedValue(0);
  const swipeFrom = useRef<number | null>(null);

  useEffect(() => {
    if (visible) rise.set(0);
  }, [visible, rise]);
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateY: rise.value }] }));

  const touchStart = (e: GestureResponderEvent) => {
    swipeFrom.current = e.nativeEvent.pageY;
  };
  // The panel follows the finger down (not up) and springs back on release.
  const touchMove = (e: GestureResponderEvent) => {
    const from = swipeFrom.current;
    if (from === null || th.reduceMotion) return;
    rise.set(Math.max(0, e.nativeEvent.pageY - from));
  };
  const touchEnd = (e: GestureResponderEvent) => {
    const from = swipeFrom.current;
    swipeFrom.current = null;
    if (!th.reduceMotion) rise.set(withSpring(0, th.motion.spring.gentle));
    if (from !== null && e.nativeEvent.pageY - from >= SWIPE_CANCEL_PT) onRequestCancel();
  };

  return (
    <Modal visible={visible} transparent animationType={th.reduceMotion ? 'none' : 'fade'} statusBarTranslucent onRequestClose={onRequestCancel} testID="wizard-modal">
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
              marginHorizontal: th.space.sm,
              marginBottom: th.space.sm,
              backgroundColor: th.colors.surface,
              borderRadius: th.radius.xl,
              borderCurve: 'continuous',
              borderWidth: th.scheme === 'dark' ? 1 : 0,
              borderColor: th.colors.divider,
              paddingBottom: Math.max(insets.bottom - th.space.sm, th.space.lg),
              boxShadow: th.elevation.overlay,
              overflow: 'hidden',
            },
            panelStyle,
          ]}
        >
          <View
            onTouchStart={touchStart}
            onTouchMove={touchMove}
            onTouchEnd={touchEnd}
            onTouchCancel={touchEnd}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ height: 28, alignItems: 'center', justifyContent: 'center' }}
            testID="wizard-grabber"
          >
            <View style={{ width: 44, height: 5, borderRadius: 3, backgroundColor: th.colors.border }} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: th.size.touch, paddingHorizontal: th.space.md }}>
            <View style={{ flex: 1, alignItems: 'flex-start' }}>
              {cancel ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.cancelLabel}
                  onPress={onRequestCancel}
                  hitSlop={8}
                  style={({ pressed }) => ({ minHeight: th.size.touch, minWidth: th.size.touch, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
                  testID="wizard-cancel"
                >
                  {/* A paper capsule with a hairline (the secondary button's look), its 44 pt target around it. */}
                  <View
                    style={{
                      minHeight: 36,
                      justifyContent: 'center',
                      paddingHorizontal: th.space.md,
                      borderRadius: th.radius.pill,
                      borderWidth: 1,
                      borderColor: th.colors.border,
                      backgroundColor: th.colors.surface,
                    }}
                  >
                    <Text variant="subhead" style={{ fontWeight: '600' }}>
                    {copy.cancel}
                    </Text>
                  </View>
                </Pressable>
              ) : null}
            </View>
            {/* The pills are not read out: each step's title says where the driver is. */}
            <View testID="wizard-step-number" accessibilityLabel={step ?? undefined} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {stepIndex !== null && stepCount > 0 ? <StepDots count={stepCount} current={stepIndex - 1} /> : null}
            </View>
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
                {/* The step showing as the sheet opens skips its entrance; later steps slide in. */}
                <LayoutAnimationConfig skipEntering>{children}</LayoutAnimationConfig>
              </Animated.View>
            </ScrollView>
            {overlay}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}
