// The driving screen's halo ring (drive-screen design §2): one thick ring with a soft outer glow and an
// empty centre, where the speed sits. Everything moves on the UI thread: JS only writes targets (at
// most once a row, and on a flash), and one frame clock advances two phases, so a change of speed,
// depth or colour never restarts an animation.
//
// - Glow: four static radial gradients (calm, yellow, orange, red), cross-faded by view opacity.
// - Ring: one stroked circle whose colour follows the severity (Reanimated's OKLab interpolation).
// - Flow (no warning showing): a light-and-shade gradient over the ring turning once every 18 s.
// - Pulse: opacity and scale from the pulse phase; a burst is its own value, combined in one style.
// - Shake: an event moves the ring and its glow sideways a few times, fading out, more for a more
//   serious one (`shakeAmplitudePt`), once per key; the compass and the speed never move with it.
// - Compass (`HaloCompass`): outside the pulse view, so it never grows, fades or shakes.
// - The speed is a sibling of the ring views: the ring is hidden from screen readers, the speed not.
// - Reduce Motion (live): no frame clock, no flow, no pulse, no shake; colours still change (250 ms
//   fades) and the compass snaps to each course.
import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { StyleSheet, View, type TextStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  interpolateColor,
  useAnimatedProps,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type AnimatedStyle,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Stop } from 'react-native-svg';

import { glowStops, glowWeight, haloGeometry, numeralRamp, ringRamp, shakeAmplitudePt, shakeOffsets, type HaloVisual } from './halo';
import { HaloCompass } from './HaloCompass';
import { HALO_TIMINGS } from './haloMotion';
import { HALO_BURST, HALO_DIM_OPACITY, HALO_FLOW_MS, HALO_RAMP_STOPS, type HudPalette } from './hudTokens';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const STOPS = [...HALO_RAMP_STOPS];
const LAYERS = [0, 1, 2, 3] as const;

export type HaloProps = {
  visual: HaloVisual;
  /** the halo's square box, pt (with no ring: the numerals' box width) */
  size: number;
  /** with no ring: the numerals' box height (default `size`) */
  height?: number;
  /** false: bare numerals (a window too small for the ring) */
  ring: boolean;
  palette: HudPalette;
  /** the screen is dimmed (the halo shows at reduced strength unless a warning shows) */
  dimmed: boolean;
  reduceMotion: boolean;
  /** the car's GPS course for the compass (degrees clockwise from north), null before the first */
  heading?: number | null;
  /** the speed, given the animated colour style for its numerals */
  numerals: (numeralStyle: AnimatedStyle<TextStyle>) => ReactNode;
};

export function Halo({ visual, size, height, ring, palette, dimmed, reduceMotion, heading = null, numerals }: HaloProps) {
  const g = useMemo(() => haloGeometry(size), [size]);
  const stops = useMemo(() => glowStops(g), [g]);
  const ringColors = useMemo(() => [...ringRamp(palette)], [palette]);
  const numeralColors = useMemo(() => [...numeralRamp(palette)], [palette]);
  const ramp = useMemo(() => ringRamp(palette), [palette]);
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');

  const colorS = useSharedValue(visual.colorSeverity);
  const depth = useSharedValue(visual.pulseDepth);
  const amp = useSharedValue(visual.pulseScale);
  const period = useSharedValue(visual.pulsePeriodMs > 0 ? visual.pulsePeriodMs : 2000);
  const flowOn = useSharedValue(visual.flow ? 1 : 0);
  const layer = useSharedValue(1);
  const burstP = useSharedValue(0);
  const shakeX = useSharedValue(0);
  const pulsePhase = useSharedValue(0);
  const flowPhase = useSharedValue(0);

  // One clock for both phases; elapsed ms, so 120 Hz screens run at the same speed.
  const clock = useFrameCallback((frame) => {
    'worklet';
    const dt = Math.min(64, Math.max(0, frame.timeSincePreviousFrame ?? 0));
    if (depth.get() > 0 || amp.get() > 0) pulsePhase.set((pulsePhase.get() + dt / Math.max(1, period.get())) % 1);
    if (flowOn.get() > 0) flowPhase.set((flowPhase.get() + dt / HALO_FLOW_MS) % 1);
  }, false);
  // Nothing to advance under Reduce Motion.
  const moving = !reduceMotion && (visual.flow || visual.pulsePeriodMs > 0);
  const setClock = clock.setActive;
  useEffect(() => {
    setClock(moving);
  }, [moving, setClock]);

  // Sustained targets: the pulse's speed, depth and size, the flow.
  useEffect(() => {
    if (visual.pulsePeriodMs > 0) period.set(visual.pulsePeriodMs);
    depth.set(withTiming(visual.pulseDepth, HALO_TIMINGS.target));
    amp.set(withTiming(visual.pulseScale, HALO_TIMINGS.target));
    flowOn.set(withTiming(visual.flow ? 1 : 0, HALO_TIMINGS.target));
  }, [visual.pulsePeriodMs, visual.pulseDepth, visual.pulseScale, visual.flow, period, depth, amp, flowOn]);

  // Colour: a critically damped spring (keeps its velocity on a retarget); quick into a burst,
  // eased out of it; a plain fade under Reduce Motion.
  const bursting = visual.mode === 'burst';
  const wasBursting = useRef(bursting);
  useEffect(() => {
    const target = visual.colorSeverity;
    if (reduceMotion) colorS.set(withTiming(target, HALO_TIMINGS.reduceColor));
    else if (bursting) colorS.set(withTiming(target, HALO_TIMINGS.intoBurst));
    else if (wasBursting.current) colorS.set(withTiming(target, HALO_TIMINGS.outOfBurst));
    else colorS.set(withSpring(target, HALO_TIMINGS.colorSpring));
    wasBursting.current = bursting;
  }, [visual.colorSeverity, bursting, reduceMotion, colorS]);

  // A burst: `pulses` quick pulses, once per key (from wherever the last one left off).
  const burstKey = visual.burst?.key ?? null;
  const burstPulses = visual.burst?.pulses ?? 0;
  useEffect(() => {
    if (burstKey === null || burstPulses <= 0) return;
    const steps = [];
    for (let i = 0; i < burstPulses; i += 1) steps.push(withTiming(1, HALO_TIMINGS.burstHalf), withTiming(0, HALO_TIMINGS.burstHalf));
    burstP.set(withSequence(...steps));
    // keyed on the burst alone: a re-render of the same burst never replays it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burstKey]);

  // An event: a few sideways swings, fading out, once per key (never under Reduce Motion:
  // `visual.shake` is then null).
  const shakeKey = visual.shake?.key ?? null;
  const shakeTier = visual.shake?.tier ?? 'moderate';
  useEffect(() => {
    if (shakeKey === null) return;
    const a = shakeAmplitudePt(shakeTier, size);
    shakeX.set(withSequence(...shakeOffsets(a, shakeTier).map((x) => withTiming(x, HALO_TIMINGS.shakeSwing))));
    // keyed on the shake alone: a re-render of the same one never replays it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shakeKey]);

  // Dimmed with no warning showing: reduced strength, still flowing (a tint under the speeding line
  // included). Any warning: full strength.
  const quiet = !visual.warning;
  useEffect(() => {
    layer.set(withTiming(dimmed && quiet ? HALO_DIM_OPACITY : 1, HALO_TIMINGS.layer));
  }, [dimmed, quiet, layer]);

  useEffect(
    () => () => {
      for (const v of [colorS, depth, amp, flowOn, layer, burstP, shakeX]) cancelAnimation(v);
    },
    [colorS, depth, amp, flowOn, layer, burstP, shakeX]
  );

  const layerStyle = useAnimatedStyle(() => ({ opacity: layer.get() }));
  const pulseStyle = useAnimatedStyle(() => {
    const p = 0.5 - 0.5 * Math.cos(2 * Math.PI * pulsePhase.get());
    const b = burstP.get();
    return {
      opacity: Math.min(1 - depth.get() * p, 1 - HALO_BURST.depth * b),
      transform: [{ translateX: shakeX.get() }, { scale: 1 + Math.max(amp.get() * p, HALO_BURST.scale * b) }],
    };
  });
  const flowStyle = useAnimatedStyle(() => ({ opacity: flowOn.get(), transform: [{ rotate: `${flowPhase.get() * 360}deg` }] }));
  const glow0 = useAnimatedStyle(() => ({ opacity: glowWeight(0, colorS.get()) }));
  const glow1 = useAnimatedStyle(() => ({ opacity: glowWeight(1, colorS.get()) }));
  const glow2 = useAnimatedStyle(() => ({ opacity: glowWeight(2, colorS.get()) }));
  const glow3 = useAnimatedStyle(() => ({ opacity: glowWeight(3, colorS.get()) }));
  const glowStyles = [glow0, glow1, glow2, glow3];
  const ringProps = useAnimatedProps(() => ({ stroke: interpolateColor(colorS.get(), STOPS, ringColors, 'LAB') }));
  const numeralStyle = useAnimatedStyle(() => ({ color: interpolateColor(colorS.get(), STOPS, numeralColors, 'LAB') }));

  // Android: cache the pulse view as a texture only while its own opacity and scale move and nothing
  // inside it does (a pulse or a burst, the flow stopped). While calm the flow turns inside it every
  // frame, which would redraw the texture each frame.
  const pulseTexture = !reduceMotion && !visual.flow;
  const c = size / 2;
  return (
    <Animated.View testID="hud-halo-layer" pointerEvents="none" style={[{ width: size, height: ring ? size : (height ?? size) }, layerStyle]}>
      {ring ? (
        <View
          testID="hud-halo"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        >
          <Animated.View testID="hud-halo-pulse" renderToHardwareTextureAndroid={pulseTexture} style={[StyleSheet.absoluteFill, pulseStyle]}>
            {LAYERS.map((i) => (
              <Animated.View key={i} style={[StyleSheet.absoluteFill, glowStyles[i]]}>
                <Svg width={size} height={size}>
                  <Defs>
                    <RadialGradient id={`${id}g${i}`} cx={c} cy={c} r={g.Ro} fx={c} fy={c} gradientUnits="userSpaceOnUse">
                      {stops.map((s, k) => (
                        <Stop key={k} offset={s.offset} stopColor={ramp[i]} stopOpacity={s.opacity} />
                      ))}
                    </RadialGradient>
                  </Defs>
                  <Circle cx={c} cy={c} r={g.Ro} fill={`url(#${id}g${i})`} />
                </Svg>
              </Animated.View>
            ))}
            <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
              <AnimatedCircle cx={c} cy={c} r={g.r} strokeWidth={g.W} fill="none" stroke={ramp[0]} animatedProps={ringProps} />
            </Svg>
            {reduceMotion ? null : (
              <Animated.View testID="hud-halo-flow" renderToHardwareTextureAndroid style={[StyleSheet.absoluteFill, flowStyle]}>
                <Svg width={size} height={size}>
                  <Defs>
                    <LinearGradient id={`${id}f`} x1="0" y1="0.5" x2="1" y2="0.5">
                      <Stop offset={0} stopColor="#000000" stopOpacity={0.3} />
                      <Stop offset={0.35} stopColor="#000000" stopOpacity={0} />
                      <Stop offset={0.65} stopColor="#FFFFFF" stopOpacity={0} />
                      <Stop offset={1} stopColor="#FFFFFF" stopOpacity={0.2} />
                    </LinearGradient>
                  </Defs>
                  <Circle cx={c} cy={c} r={g.r} strokeWidth={g.W} fill="none" stroke={`url(#${id}f)`} />
                </Svg>
              </Animated.View>
            )}
          </Animated.View>
          <HaloCompass size={size} heading={heading} palette={palette} reduceMotion={reduceMotion} />
        </View>
      ) : null}
      <View style={[StyleSheet.absoluteFill, styles.centre]} pointerEvents="none">
        {numerals(numeralStyle)}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  centre: { alignItems: 'center', justifyContent: 'center' },
});
