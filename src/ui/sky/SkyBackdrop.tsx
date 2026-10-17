import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useTheme } from '../theme';
import { parseColor } from './color';
import type { SkyMood } from './palette';
import type { WeatherIntensity, WeatherKind } from './weather';

/**
 * The page's sky, drawn behind the tab screens: the hour's tint fading into the page ground, a
 * sun or moon halo in the top corner, and a light ambient layer for the weather (falling rain or
 * snow, drifting cloud or fog, a slow storm glow, twinkling stars on a clear night).
 *
 * Rules it keeps:
 * - Behind everything, never over content; nothing in it is touchable or spoken.
 * - Text keeps AA on the tint (the palette repairs it). Particles are thin, translucent, and
 *   thinned out over the left side where the screen titles sit.
 * - Never on the driving screen: the drive route has its own HUD and draws none of this.
 * - It runs only while its screen is in front (`active`); under Reduce Motion it holds still.
 * - Every loop runs on the UI thread; nothing re-renders React per frame.
 */
export function SkyBackdrop({ height = 360, active = true }: { height?: number; active?: boolean }) {
  const t = useTheme();
  const s = t.sky;
  return (
    <View
      testID="sky-backdrop"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.bg }]}
    >
      <LinearGradient
        colors={[s.top, s.horizon, t.colors.bg]}
        locations={[0, 0.5, 1]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height }}
      />
      <Halo />
      {t.mood && active ? <Ambient mood={t.mood} height={height} still={t.reduceMotion} /> : null}
    </View>
  );
}

/** The sun or moon: a soft halo and a disc low in the top-right corner, under the avatar. */
function Halo() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const size = Math.min(320, width * 0.8);
  const halo = parseColor(t.sky.halo);
  const disc = parseColor(t.sky.disc);
  const haloHex = `rgb(${halo.r}, ${halo.g}, ${halo.b})`;
  const discHex = `rgb(${disc.r}, ${disc.g}, ${disc.b})`;
  return (
    <Svg width={size} height={size} style={{ position: 'absolute', top: -size * 0.42, right: -size * 0.32 }}>
      <Defs>
        <RadialGradient id="sky-halo" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={haloHex} stopOpacity={halo.a} />
          <Stop offset="0.35" stopColor={haloHex} stopOpacity={halo.a * 0.45} />
          <Stop offset="1" stopColor={haloHex} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="sky-disc" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={discHex} stopOpacity={disc.a} />
          <Stop offset="0.16" stopColor={discHex} stopOpacity={disc.a} />
          <Stop offset="0.2" stopColor={discHex} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width={size} height={size} fill="url(#sky-halo)" />
      <Rect x="0" y="0" width={size} height={size} fill="url(#sky-disc)" />
    </Svg>
  );
}

/** A tiny seeded generator, so particles sit in the same places on every render and in tests. */
function seeded(seed: number) {
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  return () => {
    x = (x * 16807) % 2147483647;
    return (x - 1) / 2147483646;
  };
}

const COUNT: Record<WeatherKind, Record<WeatherIntensity, number>> = {
  clear: { light: 0, moderate: 0, heavy: 0 },
  cloudy: { light: 2, moderate: 3, heavy: 3 },
  fog: { light: 3, moderate: 3, heavy: 4 },
  rain: { light: 8, moderate: 13, heavy: 18 },
  snow: { light: 10, moderate: 16, heavy: 22 },
  storm: { light: 14, moderate: 16, heavy: 20 },
};

/** Particles thin out toward the left, where titles and greetings sit. */
const fadeLeft = (x: number, width: number) => (x < width * 0.45 ? 0.35 + (0.65 * x) / (width * 0.45) : 1);

function Ambient({ mood, height, still }: { mood: SkyMood; height: number; still: boolean }) {
  const { kind, intensity } = mood.weather;
  const stars = kind === 'clear' && mood.phase === 'night';
  const key = `${kind}-${intensity}-${stars ? 'stars' : 'sky'}-${still ? 'still' : 'live'}`;
  if (kind === 'clear' && !stars) return null;
  return (
    <Animated.View
      key={key}
      testID="sky-ambient"
      entering={FadeIn.duration(1600)}
      exiting={FadeOut.duration(1200)}
      style={[StyleSheet.absoluteFill, { height }]}
    >
      {stars ? <Stars height={height} still={still} /> : null}
      {kind === 'rain' || kind === 'storm' ? <Rain count={COUNT[kind][intensity]} height={height} still={still} /> : null}
      {kind === 'storm' ? <StormGlow height={height} still={still} /> : null}
      {kind === 'snow' ? <Snow count={COUNT.snow[intensity]} height={height} still={still} /> : null}
      {kind === 'cloudy' || kind === 'fog' ? <Drift fog={kind === 'fog'} count={COUNT[kind][intensity]} height={height} still={still} /> : null}
    </Animated.View>
  );
}

function useLoop(still: boolean, start: (v: { value: number }) => void, deps: readonly unknown[]) {
  const v = useSharedValue(0);
  useEffect(() => {
    if (still) {
      v.value = 0.5;
      return;
    }
    start(v);
    return () => cancelAnimation(v);
    // `start` is rebuilt every render; the deps passed in say when it really changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still, ...deps]);
  return v;
}

function Rain({ count, height, still }: { count: number; height: number; still: boolean }) {
  const { width } = useWindowDimensions();
  const drops = useMemo(() => {
    const rnd = seeded(7 + count);
    return Array.from({ length: count }, () => ({
      x: rnd() * width,
      len: 12 + rnd() * 12,
      ms: 900 + rnd() * 700,
      delay: rnd() * 1400,
      start: rnd(),
    }));
  }, [count, width]);
  return (
    <>
      {drops.map((d, i) => (
        <Drop key={i} {...d} height={height} still={still} width={width} />
      ))}
    </>
  );
}

function Drop({ x, len, ms, delay, start, height, still, width }: { x: number; len: number; ms: number; delay: number; start: number; height: number; still: boolean; width: number }) {
  const t = useTheme();
  const v = useLoop(still, (sv) => {
    sv.value = withDelay(delay, withRepeat(withTiming(1, { duration: ms, easing: Easing.linear }), -1, false));
  }, [delay, ms]);
  const style = useAnimatedStyle(() => {
    const p = still ? start : v.value;
    return { transform: [{ translateY: -len + p * (height + len) }, { translateX: -p * 18 }, { rotate: '12deg' }] };
  });
  return (
    <Animated.View
      style={[
        { position: 'absolute', top: 0, left: x, width: 1.5, height: len, borderRadius: 1, backgroundColor: t.sky.particle, opacity: fadeLeft(x, width) },
        style,
      ]}
    />
  );
}

function Snow({ count, height, still }: { count: number; height: number; still: boolean }) {
  const { width } = useWindowDimensions();
  const flakes = useMemo(() => {
    const rnd = seeded(31 + count);
    return Array.from({ length: count }, () => ({
      x: rnd() * width,
      size: 3 + rnd() * 3,
      ms: 7000 + rnd() * 5000,
      delay: rnd() * 6000,
      sway: 6 + rnd() * 10,
      start: rnd(),
    }));
  }, [count, width]);
  return (
    <>
      {flakes.map((f, i) => (
        <Flake key={i} {...f} height={height} still={still} width={width} />
      ))}
    </>
  );
}

function Flake({ x, size, ms, delay, sway, start, height, still, width }: { x: number; size: number; ms: number; delay: number; sway: number; start: number; height: number; still: boolean; width: number }) {
  const t = useTheme();
  const v = useLoop(still, (sv) => {
    sv.value = withDelay(delay, withRepeat(withTiming(1, { duration: ms, easing: Easing.linear }), -1, false));
  }, [delay, ms]);
  const style = useAnimatedStyle(() => {
    const p = still ? start : v.value;
    return { transform: [{ translateY: -size + p * (height + size) }, { translateX: Math.sin(p * Math.PI * 4) * sway }] };
  });
  return (
    <Animated.View
      style={[
        { position: 'absolute', top: 0, left: x, width: size, height: size, borderRadius: size / 2, backgroundColor: t.sky.particle, opacity: fadeLeft(x, width) },
        style,
      ]}
    />
  );
}

function Stars({ height, still }: { height: number; still: boolean }) {
  const { width } = useWindowDimensions();
  const stars = useMemo(() => {
    const rnd = seeded(97);
    return Array.from({ length: 16 }, () => ({
      x: width * 0.3 + rnd() * width * 0.7,
      y: rnd() * height * 0.6,
      size: 1.5 + rnd() * 1.5,
      ms: 2400 + rnd() * 2600,
      delay: rnd() * 2000,
    }));
  }, [width, height]);
  return (
    <>
      {stars.map((s, i) => (
        <Star key={i} {...s} still={still} />
      ))}
    </>
  );
}

function Star({ x, y, size, ms, delay, still }: { x: number; y: number; size: number; ms: number; delay: number; still: boolean }) {
  const t = useTheme();
  const v = useLoop(still, (sv) => {
    sv.value = withDelay(delay, withRepeat(withTiming(1, { duration: ms, easing: Easing.inOut(Easing.sin) }), -1, true));
  }, [delay, ms]);
  const style = useAnimatedStyle(() => ({ opacity: 0.3 + 0.6 * v.value }));
  return (
    <Animated.View
      style={[{ position: 'absolute', left: x, top: y, width: size, height: size, borderRadius: size / 2, backgroundColor: t.sky.particle }, style]}
    />
  );
}

/** Cloud or fog: big soft shapes drifting slowly sideways. */
function Drift({ fog, count, height, still }: { fog: boolean; count: number; height: number; still: boolean }) {
  const { width } = useWindowDimensions();
  const shapes = useMemo(() => {
    const rnd = seeded(fog ? 211 : 113);
    return Array.from({ length: count }, (_, i) => ({
      x: -width * 0.2 + rnd() * width * 0.8,
      y: fog ? height * (0.15 + i * 0.22) : rnd() * height * 0.45,
      w: fog ? width * 1.4 : width * (0.5 + rnd() * 0.35),
      h: fog ? 46 + rnd() * 24 : 70 + rnd() * 40,
      ms: 40_000 + rnd() * 30_000,
      travel: 30 + rnd() * 40,
    }));
  }, [fog, count, width, height]);
  return (
    <>
      {shapes.map((s, i) => (
        <Puff key={i} {...s} still={still} />
      ))}
    </>
  );
}

function Puff({ x, y, w, h, ms, travel, still }: { x: number; y: number; w: number; h: number; ms: number; travel: number; still: boolean }) {
  const t = useTheme();
  const v = useLoop(still, (sv) => {
    sv.value = withRepeat(withTiming(1, { duration: ms, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [ms]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: (v.value - 0.5) * 2 * travel }] }));
  return (
    <Animated.View
      style={[{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: h / 2, backgroundColor: t.sky.particle }, style]}
    />
  );
}

/** A storm's slow brightening: about 2.5 s up and down every 10 s, never a flash. */
function StormGlow({ height, still }: { height: number; still: boolean }) {
  const t = useTheme();
  const v = useLoop(still, (sv) => {
    sv.value = withRepeat(
      withSequence(withDelay(7000, withTiming(1, { duration: 1300, easing: Easing.inOut(Easing.sin) })), withTiming(0, { duration: 1300, easing: Easing.inOut(Easing.sin) })),
      -1,
      false
    );
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: still ? 0 : v.value }));
  // Light grounds brighten and dark grounds barely lift, so the glow never costs text contrast.
  const glow = t.scheme === 'light' ? 'rgba(255, 255, 255, 0.55)' : 'rgba(200, 185, 255, 0.08)';
  return (
    <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: height * 0.6 }, style]}>
      <LinearGradient colors={[glow, 'transparent']} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}
