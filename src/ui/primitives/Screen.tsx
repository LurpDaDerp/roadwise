import type { ReactNode } from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';

/**
 * The desk the licence card sits on. Every screen starts here.
 *
 * Top, left and right come from the native `SafeAreaView`, which measures its own overlap with the
 * status bar and notch, so a screen under a navigation header is not padded twice. The bottom inset
 * is folded into the content padding instead: on Face ID phones the home indicator sits inside the
 * window, and the one bottom-anchored primary action every screen carries has to clear it. Keeping
 * it in the content rather than the container lets a scrolling screen still scroll beneath the
 * indicator, as the rest of the platform does. Tab screens pass `bottomInset={false}`: the tab bar
 * sits between them and the indicator and pads itself.
 */
export function Screen({
  children,
  scroll = false,
  padded = true,
  bottomInset = true,
  testID,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  /** Clear the home indicator. Off inside the tab bar, which owns that inset. */
  bottomInset?: boolean;
  /** Lands on the content container, the element that carries the padding. */
  testID?: string;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const pad = padded ? t.space.lg : 0;
  const content: ViewStyle = {
    flexGrow: 1,
    paddingHorizontal: pad,
    paddingTop: pad,
    paddingBottom: pad + (bottomInset ? insets.bottom : 0),
    gap: t.space.lg,
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.colors.bg }}
      edges={['top', 'left', 'right']}
    >
      {scroll ? (
        <ScrollView
          contentContainerStyle={content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          testID={testID}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={content} testID={testID}>
          {children}
        </View>
      )}
    </SafeAreaView>
  );
}
