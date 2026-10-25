// DEMO ONLY (temporary): the driving screen's sky, cross-fading to each new theme's sky over the
// same time the rest of the app takes to blend.
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';

import { SKY_BLEND_MS } from '@/ui/theme';

type Stops = readonly [string, string, ...string[]];

export function DemoSkyFade({ stops }: { stops: Stops }) {
  const [layers, setLayers] = useState<{ from: Stops; to: Stops }>({ from: stops, to: stops });
  const [fade] = useState(() => new Animated.Value(1));
  const key = stops.join();
  const shown = useRef(key);
  useEffect(() => {
    if (shown.current === key) return;
    shown.current = key;
    setLayers((l) => ({ from: l.to, to: stops }));
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: SKY_BLEND_MS, useNativeDriver: true }).start();
    // `stops` is named by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fade]);
  return (
    <>
      <LinearGradient testID="hud-sky" pointerEvents="none" colors={layers.from} style={StyleSheet.absoluteFill} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: fade }]}>
        <LinearGradient colors={layers.to} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </>
  );
}
