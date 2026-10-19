import { createContext, useContext, type ReactNode } from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';
import { Text } from './Text';

/** True inside a `Screen sky`: the page's top is the painted sky, so its title is white. */
const OnSky = createContext(false);

/** Whether this screen is drawn over the page sky (inside `Screen sky`). */
export function useOnSky(): boolean {
  return useContext(OnSky);
}

/**
 * A screen's large title (title1, a header for screen readers) with an optional trailing control
 * (an avatar, an icon button). Over the page sky (inside `Screen sky`, or with `onSky`) it uses the
 * white `onSky` ink, which reads on every backdrop stop at AA; elsewhere the page ink.
 */
export function ScreenTitle({
  children,
  trailing,
  onSky,
  testID,
}: {
  children: ReactNode;
  trailing?: ReactNode;
  /** Force the sky ink (a tab screen that is not a `Screen sky`). Defaults to the screen's. */
  onSky?: boolean;
  testID?: string;
}) {
  const t = useTheme();
  const inherited = useOnSky();
  const sky = onSky ?? inherited;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
      <Text variant="title1" accessibilityRole="header" tone={sky ? 'onSky' : 'default'} style={{ flex: 1 }} testID={testID}>
        {children}
      </Text>
      {trailing}
    </View>
  );
}

/**
 * The page every screen starts from: the scheme background, safe-area top, 16 pt gutters.
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
  sky = false,
  title,
  testID,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  /** Clear the home indicator. Off inside the tab bar, which owns that inset. */
  bottomInset?: boolean;
  /**
   * A tab screen: no ground of its own, so the sky drawn behind the tabs shows through, and its
   * `ScreenTitle` (or `title`) draws in the white `onSky` ink.
   */
  sky?: boolean;
  /** The screen's large title, first in the content (white on the sky for a `sky` screen). */
  title?: string;
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

  const body = (
    <>
      {title ? <ScreenTitle>{title}</ScreenTitle> : null}
      {children}
    </>
  );

  return (
    <OnSky.Provider value={sky}>
      <SafeAreaView
        style={{ flex: 1, backgroundColor: sky ? 'transparent' : t.colors.bg }}
        edges={['top', 'left', 'right']}
      >
        {scroll ? (
          <ScrollView
            contentContainerStyle={content}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
            showsVerticalScrollIndicator={false}
            testID={testID}
          >
            {body}
          </ScrollView>
        ) : (
          <View style={content} testID={testID}>
            {body}
          </View>
        )}
      </SafeAreaView>
    </OnSky.Provider>
  );
}
