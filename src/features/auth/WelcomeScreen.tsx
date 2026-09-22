import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ScrollView,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { t } from '@/i18n';
import { Button, Card, Screen, Text, useTheme } from '@/ui';

import { welcomeCopy as copy } from './copy';

const PAGES = copy.cards.length;
const DOT = 8;
const DOT_ACTIVE = 24;

/**
 * A2 Welcome. Three licence-card faces the driver pages through at their own pace — swipe, or the
 * Next button that stands in for the swipe — and nothing advances by itself. Skip and the returning
 * driver's quiet action go straight to sign-in. Under reduce motion a page change is a cut, not a
 * slide.
 */
export function WelcomeScreen() {
  const router = useRouter();
  const th = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const pager = useRef<ScrollView>(null);
  // Until the pager measures itself, the window less the screen's side padding is its width.
  const [pageWidth, setPageWidth] = useState(Math.max(windowWidth - th.space.lg * 2, 0));
  const [page, setPage] = useState(0);
  const last = page === PAGES - 1;

  // Both routes land on the same screen on purpose: Apple, Google and the magic link each create
  // the account on first use, so there is no separate sign-up to send anyone to.
  const toSignIn = () => router.push('/(auth)/sign-in');

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && w !== pageWidth) setPageWidth(w);
  };

  const onSettle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (pageWidth <= 0) return;
    const n = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
    setPage(Math.min(Math.max(n, 0), PAGES - 1));
  };

  const next = () => {
    const n = Math.min(page + 1, PAGES - 1);
    pager.current?.scrollTo({ x: n * pageWidth, y: 0, animated: !th.reduceMotion });
    setPage(n);
  };

  return (
    <Screen scroll>
      <View style={{ minHeight: 44, alignItems: 'flex-end' }}>
        {last ? null : <Button label={copy.skip} variant="ghost" size="md" onPress={toSignIn} />}
      </View>

      <View style={{ flexGrow: 1, justifyContent: 'center', gap: th.space.xl }}>
        <Text variant="display" accessibilityRole="header">
          {t('welcome.headline')}
        </Text>

        <View style={{ gap: th.space.md }}>
          <ScrollView
            ref={pager}
            testID="welcome-pager"
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onLayout={onLayout}
            onMomentumScrollEnd={onSettle}
          >
            {copy.cards.map((card) => (
              <View key={card.title} style={{ width: pageWidth }}>
                <Card variant="license" style={{ flexGrow: 1 }}>
                  <Text variant="title2" accessibilityRole="header">
                    {card.title}
                  </Text>
                  <Text variant="body">{card.body}</Text>
                </Card>
              </View>
            ))}
          </ScrollView>

          {/* Position by shape as well as colour: the current page's dot is the long one. */}
          <View
            accessible
            accessibilityLabel={copy.page(page + 1, PAGES)}
            style={{ flexDirection: 'row', justifyContent: 'center', gap: th.space.xs }}
          >
            {copy.cards.map((card, i) => (
              <View
                key={card.title}
                testID={`welcome-dot-${i}`}
                style={{
                  height: DOT,
                  width: i === page ? DOT_ACTIVE : DOT,
                  borderRadius: DOT / 2,
                  backgroundColor: i === page ? th.colors.accent : th.colors.borderStrong,
                }}
              />
            ))}
          </View>
        </View>
      </View>

      <View style={{ gap: th.space.sm }}>
        <View style={{ gap: th.space.xs }}>
          <Text variant="footnote" tone="subtle">
            {copy.noVideo}
          </Text>
          <Text variant="footnote" tone="subtle">
            {t('welcome.privacy')}
          </Text>
        </View>
        {last ? (
          <Button label={t('welcome.getStarted')} onPress={toSignIn} />
        ) : (
          <Button label={copy.next} onPress={next} />
        )}
        <Button label={t('welcome.signIn')} variant="ghost" onPress={toSignIn} />
      </View>
    </Screen>
  );
}
