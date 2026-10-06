import { useEffect, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';
import { IconButton } from './IconButton';
import { Text } from './Text';

export type SheetProps = {
  visible: boolean;
  /** Called by the close button, a tap on the scrim, and Android back. */
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Wrap the content in a ScrollView (long lists such as report reasons). Default false. */
  scroll?: boolean;
  testID?: string;
};

/**
 * A bottom sheet for a short, self-contained task: report reasons, sort options, a confirmation
 * with detail. Built on `Modal` so it is testable and needs no extra dependency: the scrim fades,
 * the panel springs up (no slide under reduce motion). Max 90% of the screen.
 */
export function Sheet({ visible, onClose, title, children, scroll = false, testID }: SheetProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const y = useSharedValue(t.reduceMotion ? 0 : 320);

  useEffect(() => {
    if (!visible) {
      y.value = t.reduceMotion ? 0 : 320;
      return;
    }
    y.value = t.reduceMotion ? 0 : withSpring(0, t.motion.spring.gentle);
  }, [visible, t.reduceMotion, t.motion.spring.gentle, y]);

  const rise = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

  const content = (
    <View style={{ gap: t.space.lg, paddingHorizontal: t.space.lg }}>{children}</View>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: t.colors.scrim }}
        />
        <Animated.View
          testID={testID}
          accessibilityViewIsModal
          style={[
            {
              maxHeight: '90%',
              backgroundColor: t.colors.surface,
              borderTopLeftRadius: t.radius.xl,
              borderTopRightRadius: t.radius.xl,
              borderCurve: 'continuous',
              paddingTop: t.space.sm,
              paddingBottom: Math.max(insets.bottom, t.space.lg),
              boxShadow: t.elevation.overlay,
              gap: t.space.md,
            },
            rise,
          ]}
        >
          <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
              alignSelf: 'center',
              width: 40,
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
              paddingLeft: t.space.lg,
              paddingRight: t.space.sm,
              minHeight: 44,
            }}
          >
            {title ? (
              <Text variant="title2" accessibilityRole="header" style={{ flex: 1 }}>
                {title}
              </Text>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            <IconButton icon="close" accessibilityLabel="Close" onPress={onClose} variant="tinted" size={32} />
          </View>
          {scroll ? <ScrollView>{content}</ScrollView> : content}
        </Animated.View>
      </View>
    </Modal>
  );
}
