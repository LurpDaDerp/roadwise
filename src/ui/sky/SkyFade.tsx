import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { SKY_BLEND_MS, useSkyFades } from '../theme';

/**
 * A layer of the sky that fades to its new colours when the sky changes: the old look stays drawn
 * underneath while the new one fades in over it on the UI thread (Animated's native driver), so a
 * change costs one extra drawing and no work per frame on the JS thread. `look` is compared by
 * identity (the theme's bundles are cached, so an equal sky is the same object), and `paint` draws a
 * look from that look's own values only, never from the theme. Outside a fade (Reduce Motion, a
 * static look, the first sky) the new look lands at once. A new look mid-fade starts over from the
 * one that was fading in.
 */
export function SkyFade<T>({ look, paint }: { look: T; paint: (look: T) => ReactNode }) {
  const fades = useSkyFades();
  const [layers, setLayers] = useState<{ top: T; under: T | null; n: number }>({ top: look, under: null, n: 0 });
  if (layers.top !== look) setLayers({ top: look, under: fades ? layers.top : null, n: layers.n + 1 });
  const settle = useCallback(() => setLayers((l) => (l.under === null ? l : { ...l, under: null })), []);
  return (
    <>
      {layers.under !== null ? (
        <View key={`under-${layers.n}`} pointerEvents="none" style={StyleSheet.absoluteFill}>
          {paint(layers.under)}
        </View>
      ) : null}
      <FadeLayer key={layers.n} fading={layers.under !== null} onDone={settle}>
        {paint(layers.top)}
      </FadeLayer>
    </>
  );
}

function FadeLayer({ fading, onDone, children }: { fading: boolean; onDone: () => void; children: ReactNode }) {
  const [opacity] = useState(() => new Animated.Value(fading ? 0 : 1));
  useEffect(() => {
    if (!fading) return;
    const fade = Animated.timing(opacity, { toValue: 1, duration: SKY_BLEND_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: true });
    fade.start(({ finished }) => {
      if (finished) onDone();
    });
    return () => fade.stop();
  }, [fading, opacity, onDone]);
  return (
    <Animated.View
      testID={fading ? 'sky-fading' : undefined}
      pointerEvents="none"
      needsOffscreenAlphaCompositing={fading}
      style={[StyleSheet.absoluteFill, { opacity }]}
    >
      {children}
    </Animated.View>
  );
}
