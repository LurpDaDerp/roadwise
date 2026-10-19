import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, type ReactNode } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, Ellipse, RadialGradient, Rect, Stop } from 'react-native-svg';

import { relativeLuminance } from '../contrast';
import { useTheme } from '../theme';
import { opaque, parseColor, withAlpha } from './color';
import type { SkyMood } from './palette';
import type { WeatherIntensity, WeatherKind } from './weather';

/** How much of the window the painted sky covers, from the top, before it has faded into the page. */
export const SKY_BAND = 0.45;
/**
 * Where the backdrop's colours sit down the band: the three text-safe stops, the horizon band, then
 * the page ground. Titles and the greeting sit in the top half, where every stop reads white at AA.
 */
export const SKY_LOCATIONS = [0, 0.3, 0.58, 0.8, 1] as const;
/** A storm's lightning wash: a long quiet gap, then a soft rise and a slower fall. Never a flash. */
export const STORM_WASH = { gapMs: 8000, upMs: 700, downMs: 1400 } as const;

/**
 * The page's sky, drawn behind the tab screens the way the iOS Weather app paints its backgrounds:
 * the hour's sky across the top of the window (deep azure by day, indigo to rose at dawn, deep blue
 * to magenta at dusk, navy with stars at night, slate under cloud) fading through a lighter band
 * near the horizon into the page ground, a soft sun or moon glow in the top-right corner, and a
 * weather layer (soft drifting clouds, low fog bands, thin slanted rain, swaying snow, a storm's
 * slow lightning wash, twinkling stars).
 *
 * Rules it keeps:
 * - Behind everything, never over content; nothing in it is touchable or spoken.
 * - Text drawn straight on it uses the white `onSky` inks, which read at AA on every stop and
 *   through everything drawn over it (the palette repairs the stops against `skyVeils`). For that
 *   to hold, nothing here is denser than its palette colour: the glow peaks at `halo`, and all the
 *   cloud puffs (or fog bands) sit in one group faded to `cloud`, so where they overlap the layer
 *   is still no denser than `cloud`. Particles are thinned over the left side, where titles sit.
 * - Never on the driving screen: the drive route has its own HUD and draws none of this.
 * - The weather layer runs only while its screen is in front (`active`); under Reduce Motion it
 *   holds still. The status bar turns light over the sky while the sky is in front (`front`,
 *   default `active`) and falls back to the scheme's when it is not.
 * - Every loop runs on the UI thread; nothing re-renders React per frame.
 */
export function SkyBackdrop({
  height,
  active = true,
  front,
}: {
  /** The painted band's height. Defaults to {@link SKY_BAND} of the window. */
  height?: number;
  /** The weather layer moves (its screen is in front and no drive records). */
  active?: boolean;
  /** The sky is the screen in front, so the status bar sits on it. Defaults to `active`; false in a preview. */
  front?: boolean;
}) {
  const t = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const h = height ?? Math.round(windowHeight * SKY_BAND);
  const s = t.sky;
  const onTop = front ?? active;
  const lightBar = relativeLuminance(opaque(s.backdrop[0])) < 0.18;
  return (
    <View
      testID="sky-backdrop"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.bg }]}
    >
      <LinearGradient
        colors={[s.backdrop[0], s.backdrop[1], s.backdrop[2], s.horizon, t.colors.bg]}
        locations={SKY_LOCATIONS}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: h }}
      />
      {parseColor(s.cover).a > 0 ? (
        <LinearGradient
          colors={[s.cover, withAlpha(s.cover, 0)]}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: h * 0.75 }}
        />
      ) : null}
      <Glow />
      {t.mood && active ? <Ambient mood={t.mood} height={h} still={t.reduceMotion} /> : null}
      {onTop ? <StatusBar style={lightBar ? 'light' : 'dark'} animated /> : null}
    </View>
  );
}

/** The sun's soft glow (or the moon and its glow), in the top-right corner behind the avatar. */
function Glow() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const halo = parseColor(t.sky.halo);
  const disc = parseColor(t.sky.disc);
  if (halo.a <= 0 && disc.a <= 0) return null;
  const size = Math.min(440, width * 1.1);
  const haloRgb = `rgb(${halo.r}, ${halo.g}, ${halo.b})`;
  const discRgb = `rgb(${disc.r}, ${disc.g}, ${disc.b})`;
  return (
    <Svg
      width={size}
      height={size}
      style={{ position: 'absolute', left: width - 56 - size / 2, top: insets.top + 34 - size / 2 }}
    >
      <Defs>
        <RadialGradient id="sky-halo" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={haloRgb} stopOpacity={halo.a} />
          <Stop offset="0.45" stopColor={haloRgb} stopOpacity={halo.a * 0.6} />
          <Stop offset="1" stopColor={haloRgb} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="sky-moon" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={discRgb} stopOpacity={disc.a} />
          <Stop offset="0.07" stopColor={discRgb} stopOpacity={disc.a} />
          <Stop offset="0.095" stopColor={discRgb} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {halo.a > 0 ? <Rect x="0" y="0" width={size} height={size} fill="url(#sky-halo)" /> : null}
      {disc.a > 0 ? <Rect x="0" y="0" width={size} height={size} fill="url(#sky-moon)" /> : null}
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

type Counts = Record<WeatherIntensity, number>;

/** Cloud puffs (fog: haze bands) per kind; none under a clear sky. */
const PUFFS: Record<WeatherKind, Counts> = {
  clear: { light: 0, moderate: 0, heavy: 0 },
  cloudy: { light: 3, moderate: 4, heavy: 5 },
  fog: { light: 3, moderate: 4, heavy: 5 },
  rain: { light: 2, moderate: 3, heavy: 3 },
  snow: { light: 2, moderate: 2, heavy: 3 },
  storm: { light: 3, moderate: 3, heavy: 4 },
};

/** Rain streaks or snowflakes per kind. */
const FALLING: Record<WeatherKind, Counts> = {
  clear: { light: 0, moderate: 0, heavy: 0 },
  cloudy: { light: 0, moderate: 0, heavy: 0 },
  fog: { light: 0, moderate: 0, heavy: 0 },
  rain: { light: 24, moderate: 36, heavy: 52 },
  snow: { light: 16, moderate: 26, heavy: 36 },
  storm: { light: 30, moderate: 40, heavy: 52 },
};

const STARS = 44;

/** Particles thin out toward the left, where titles and greetings sit. */
const fadeLeft = (x: number, width: number) => (x < width * 0.45 ? 0.5 + (0.5 * Math.max(0, x)) / (width * 0.45) : 1);

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
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height, overflow: 'hidden' }}
    >
      {stars ? <Stars height={height} still={still} /> : null}
      {kind === 'fog' ? <Fog count={PUFFS.fog[intensity]} height={height} still={still} /> : null}
      {kind !== 'fog' && PUFFS[kind][intensity] > 0 ? <Clouds count={PUFFS[kind][intensity]} height={height} still={still} /> : null}
      {kind === 'rain' || kind === 'storm' ? <Rain count={FALLING[kind][intensity]} height={height} still={still} /> : null}
      {kind === 'snow' ? <Snow count={FALLING.snow[intensity]} height={height} still={still} /> : null}
      {kind === 'storm' ? <StormWash height={height} still={still} /> : null}
    </Animated.View>
  );
}

/** A looping shared value; under Reduce Motion it holds at 0.5 and no animation starts. */
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

/**
 * The cloud layer: puffs (or fog bands) drawn at full strength inside one group, and the group
 * faded to the palette's `cloud` alpha as a whole. Composited offscreen, so overlapping puffs
 * saturate inside the group instead of stacking: the layer is never denser than `cloud`, the
 * density the backdrop's stops were repaired to carry white text through.
 */
function CloudLayer({ testID, children }: { testID: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <View testID={testID} needsOffscreenAlphaCompositing style={[StyleSheet.absoluteFill, { opacity: parseColor(t.sky.cloud).a }]}>
      {children}
    </View>
  );
}

/** Soft volumetric clouds: puffs of radial-gradient lobes in two layers drifting at their own pace. */
function Clouds({ count, height, still }: { count: number; height: number; still: boolean }) {
  const { width } = useWindowDimensions();
  const puffs = useMemo(() => {
    const rnd = seeded(113 + count);
    return Array.from({ length: count }, (_, i) => {
      const near = i % 2 === 1;
      const w = width * (near ? 0.75 + rnd() * 0.35 : 0.5 + rnd() * 0.25);
      return {
        x: -width * 0.25 + rnd() * width * 0.95,
        y: near ? height * (0.12 + rnd() * 0.3) : rnd() * height * 0.25,
        w,
        h: w * 0.45,
        ms: near ? 45_000 + rnd() * 15_000 : 70_000 + rnd() * 20_000,
        travel: near ? 40 + rnd() * 25 : 18 + rnd() * 12,
        depth: near ? 1 : 0.7,
      };
    });
  }, [count, width, height]);
  return (
    <CloudLayer testID="sky-clouds">
      {puffs.map((p, i) => (
        <Puff key={i} id={i} {...p} still={still} width={width} />
      ))}
    </CloudLayer>
  );
}

function Puff({
  id,
  x,
  y,
  w,
  h,
  ms,
  travel,
  depth,
  still,
  width,
}: {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  ms: number;
  travel: number;
  depth: number;
  still: boolean;
  width: number;
}) {
  const t = useTheme();
  const c = parseColor(t.sky.cloud);
  const rgb = `rgb(${c.r}, ${c.g}, ${c.b})`;
  const v = useLoop(still, (sv) => {
    sv.value = withRepeat(withTiming(1, { duration: ms, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [ms]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: (v.value - 0.5) * 2 * travel }] }));
  const grad = `sky-puff-${id}`;
  // Lobes overlap at full strength inside the drawing; the cloud layer fades every puff as one.
  const lobes: [number, number, number, number][] = [
    [100, 70, 96, 28],
    [64, 56, 40, 32],
    [108, 44, 46, 40],
    [146, 58, 36, 30],
  ];
  return (
    <Animated.View
      style={[{ position: 'absolute', left: x, top: y, width: w, height: h, opacity: depth * fadeLeft(x + w / 2, width) }, style]}
    >
      <Svg width="100%" height="100%" viewBox="0 0 200 100" preserveAspectRatio="none">
        <Defs>
          <RadialGradient id={grad} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={rgb} stopOpacity={1} />
            <Stop offset="0.55" stopColor={rgb} stopOpacity={0.85} />
            <Stop offset="1" stopColor={rgb} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        {lobes.map(([cx, cy, rx, ry], i) => (
          <Ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} fill={`url(#${grad})`} />
        ))}
      </Svg>
    </Animated.View>
  );
}

/** Fog: wide, soft haze bands low in the sky, drifting slowly sideways. */
function Fog({ count, height, still }: { count: number; height: number; still: boolean }) {
  const { width } = useWindowDimensions();
  const bands = useMemo(() => {
    const rnd = seeded(211 + count);
    return Array.from({ length: count }, (_, i) => ({
      x: -width * 0.3 + rnd() * width * 0.1,
      y: height * (0.3 + (0.5 * i) / Math.max(1, count - 1)) - 50,
      h: 80 + rnd() * 40,
      ms: 50_000 + rnd() * 20_000,
      travel: 30 + rnd() * 30,
    }));
  }, [count, width, height]);
  return (
    <CloudLayer testID="sky-fog">
      {bands.map((b, i) => (
        <Band key={i} {...b} w={width * 1.6} still={still} />
      ))}
    </CloudLayer>
  );
}

function Band({ x, y, w, h, ms, travel, still }: { x: number; y: number; w: number; h: number; ms: number; travel: number; still: boolean }) {
  const t = useTheme();
  // Full strength here: the cloud layer fades all the bands as one.
  const haze = opaque(t.sky.cloud);
  const v = useLoop(still, (sv) => {
    sv.value = withRepeat(withTiming(1, { duration: ms, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [ms]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: (v.value - 0.5) * 2 * travel }] }));
  return (
    <Animated.View style={[{ position: 'absolute', left: x, top: y, width: w, height: h }, style]}>
      <LinearGradient colors={[withAlpha(haze, 0), haze, withAlpha(haze, 0)]} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

/** Rain: thin, long, slanted streaks, many of them. */
function Rain({ count, height, still }: { count: number; height: number; still: boolean }) {
  const { width } = useWindowDimensions();
  const drops = useMemo(() => {
    const rnd = seeded(7 + count);
    return Array.from({ length: count }, () => ({
      x: rnd() * width * 1.1,
      len: 28 + rnd() * 28,
      ms: 550 + rnd() * 350,
      delay: rnd() * 1200,
      start: rnd(),
      dim: 0.6 + rnd() * 0.4,
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

function Drop({
  x,
  len,
  ms,
  delay,
  start,
  dim,
  height,
  still,
  width,
}: {
  x: number;
  len: number;
  ms: number;
  delay: number;
  start: number;
  dim: number;
  height: number;
  still: boolean;
  width: number;
}) {
  const t = useTheme();
  const v = useLoop(still, (sv) => {
    sv.value = withDelay(delay, withRepeat(withTiming(1, { duration: ms, easing: Easing.linear }), -1, false));
  }, [delay, ms]);
  const style = useAnimatedStyle(() => {
    const p = still ? start : v.value;
    return { transform: [{ translateY: -len + p * (height + len) }, { translateX: -p * 30 }, { rotate: '14deg' }] };
  });
  return (
    <Animated.View
      style={[
        { position: 'absolute', top: 0, left: x, width: 1, height: len, borderRadius: 0.5, backgroundColor: t.sky.particle, opacity: dim * fadeLeft(x, width) },
        style,
      ]}
    />
  );
}

/** Snow: soft flakes of a few sizes, falling slowly with a sway. */
function Snow({ count, height, still }: { count: number; height: number; still: boolean }) {
  const { width } = useWindowDimensions();
  const flakes = useMemo(() => {
    const rnd = seeded(31 + count);
    return Array.from({ length: count }, () => ({
      x: rnd() * width,
      size: 2.5 + rnd() * 3.5,
      ms: 8000 + rnd() * 5000,
      delay: rnd() * 6000,
      sway: 8 + rnd() * 10,
      start: rnd(),
      dim: 0.55 + rnd() * 0.45,
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

function Flake({
  x,
  size,
  ms,
  delay,
  sway,
  start,
  dim,
  height,
  still,
  width,
}: {
  x: number;
  size: number;
  ms: number;
  delay: number;
  sway: number;
  start: number;
  dim: number;
  height: number;
  still: boolean;
  width: number;
}) {
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
        {
          position: 'absolute',
          top: 0,
          left: x,
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: t.sky.particle,
          opacity: dim * fadeLeft(x, width),
        },
        style,
      ]}
    />
  );
}

/** A clear night: many small stars twinkling at their own pace. */
function Stars({ height, still }: { height: number; still: boolean }) {
  const { width } = useWindowDimensions();
  const stars = useMemo(() => {
    const rnd = seeded(97);
    return Array.from({ length: STARS }, () => ({
      x: rnd() * width,
      y: rnd() * height * 0.75,
      size: 1 + rnd() * 1.2,
      ms: 2200 + rnd() * 3000,
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
  const style = useAnimatedStyle(() => ({ opacity: 0.2 + 0.7 * v.value }));
  return (
    <Animated.View
      style={[{ position: 'absolute', left: x, top: y, width: size, height: size, borderRadius: size / 2, backgroundColor: t.sky.particle }, style]}
    />
  );
}

/**
 * A storm's lightning: the top of the sky brightens softly and fades, once every ten seconds or so.
 * The ramps are long (never a flash), and at its peak the wash is no brighter than the palette's
 * `wash`, which the backdrop was repaired to carry white text through.
 */
function StormWash({ height, still }: { height: number; still: boolean }) {
  const t = useTheme();
  const v = useLoop(still, (sv) => {
    sv.value = withRepeat(
      withSequence(
        withDelay(STORM_WASH.gapMs, withTiming(1, { duration: STORM_WASH.upMs, easing: Easing.inOut(Easing.sin) })),
        withTiming(0, { duration: STORM_WASH.downMs, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: still ? 0 : v.value }));
  return (
    <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: height * 0.8 }, style]}>
      <LinearGradient colors={[t.sky.wash, withAlpha(t.sky.wash, 0)]} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}
