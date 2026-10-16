// Every timing and spring the halo runs, in one place. Each passes `ReduceMotion.Never`: Reanimated
// reads the OS setting once at load and would otherwise snap every animation to its end, also the
// colour changes Reduce Motion keeps. The halo gates its movement itself, live (`useOsReduceMotion`).
import { Easing, ReduceMotion, type WithSpringConfig, type WithTimingConfig } from 'react-native-reanimated';

import { HALO_BURST } from './hudTokens';

export const HALO_TIMINGS = {
  /** the colour following its target: critically damped, keeps its velocity on a retarget */
  colorSpring: { duration: 700, dampingRatio: 1, reduceMotion: ReduceMotion.Never } satisfies WithSpringConfig,
  /** into a burst's colour */
  intoBurst: { duration: 120, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.Never } satisfies WithTimingConfig,
  /** back from a burst's colour */
  outOfBurst: { duration: 400, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never } satisfies WithTimingConfig,
  /** a colour change under Reduce Motion (a fade, not movement) */
  reduceColor: { duration: 250, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never } satisfies WithTimingConfig,
  /** the pulse's depth and size, the flow fading in or out */
  target: { duration: 400, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never } satisfies WithTimingConfig,
  /** the whole halo's strength (dimmed and calm, or full) */
  layer: { duration: 400, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never } satisfies WithTimingConfig,
  /** each half of a burst pulse */
  burstHalf: { duration: HALO_BURST.periodMs / 2, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never } satisfies WithTimingConfig,
} as const;
