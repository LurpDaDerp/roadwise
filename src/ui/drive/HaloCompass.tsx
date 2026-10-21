// The compass around the halo (product spec "Driving screen"): heading-up, so the direction of travel
// always sits at 12 o'clock under a fixed mark, and the card (ticks and N/E/S/W) turns the short way
// round as the car's GPS course changes, in about 700 ms (it snaps under Reduce Motion). The letters
// stay upright. Before the drive's first course it shows its ticks with the letters dimmed. It sits
// outside everything that pulses or shakes, so it never grows, fades or moves with the ring. Quiet
// HUD inks: the ticks and letters muted, N and the mark in the halo's ink (never red: red is the
// severe tier). Drawn inside the halo's view, which screen readers skip.
import { memo, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import Svg, { Line, Polygon } from 'react-native-svg';

import { fontFamilies } from '../fonts';
import { COMPASS_LETTERS, COMPASS_TICK_DEG, compassGeometry, nextCompassAngle } from './halo';
import { HALO_TIMINGS } from './haloMotion';
import type { HudPalette } from './hudTokens';

/** The letters' strength before the drive's first course. */
export const COMPASS_DIM_LETTERS = 0.3;

export type HaloCompassProps = {
  /** the halo's square box, pt */
  size: number;
  /** the car's course, degrees clockwise from true north; null before the first (held while slow) */
  heading: number | null;
  palette: HudPalette;
  reduceMotion: boolean;
};

const known = (h: number | null): h is number => h !== null && Number.isFinite(h);

export const HaloCompass = memo(function HaloCompass({ size, heading, palette, reduceMotion }: HaloCompassProps) {
  const cg = useMemo(() => compassGeometry(size), [size]);
  const c = size / 2;
  const hasCourse = known(heading);
  // The card's rotation, degrees clockwise, unwrapped (so a turn through north never spins back).
  const start = hasCourse ? -heading : 0;
  const rot = useSharedValue(start);
  const last = useRef(start);
  useEffect(() => {
    if (!known(heading)) return; // no course: the card holds where it is
    const target = nextCompassAngle(last.current, -heading);
    last.current = target;
    if (reduceMotion) {
      cancelAnimation(rot);
      rot.set(target);
    } else rot.set(withTiming(target, HALO_TIMINGS.compass));
  }, [heading, reduceMotion, rot]);
  useEffect(() => () => cancelAnimation(rot), [rot]);

  const cardStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.get()}deg` }] }));
  const ticks = useMemo(() => {
    const out: { key: number; x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
    for (let b = 0; b < 360; b += COMPASS_TICK_DEG) {
      const major = b % 90 === 0;
      const len = major ? cg.tick : cg.minorTick;
      const a = (b * Math.PI) / 180;
      const sin = Math.sin(a);
      const cos = Math.cos(a);
      out.push({ key: b, x1: c + cg.outer * sin, y1: c - cg.outer * cos, x2: c + (cg.outer - len) * sin, y2: c - (cg.outer - len) * cos, major });
    }
    return out;
  }, [cg, c]);
  const mark = `${c - cg.markW / 2},${c - cg.outer} ${c + cg.markW / 2},${c - cg.outer} ${c},${c - cg.outer + cg.markH}`;

  return (
    <View testID="hud-compass" pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View testID="hud-compass-card" style={[StyleSheet.absoluteFill, cardStyle]}>
        <Svg width={size} height={size}>
          {ticks.map((t) => (
            <Line
              key={t.key}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={palette.haloInkMuted}
              strokeWidth={t.major ? 2 : 1.25}
              strokeLinecap="round"
            />
          ))}
        </Svg>
      </Animated.View>
      {COMPASS_LETTERS.map((l) => (
        <CompassLetter
          key={l.label}
          label={l.label}
          bearing={l.bearing}
          rot={rot}
          centre={c}
          radius={cg.letterR}
          pt={cg.letterPt}
          color={l.label === 'N' ? palette.haloInk : palette.haloInkMuted}
          dim={!hasCourse}
        />
      ))}
      <Svg testID="hud-compass-mark" width={size} height={size} style={StyleSheet.absoluteFill}>
        <Polygon points={mark} fill={palette.haloInk} />
      </Svg>
    </View>
  );
});

/** One upright letter, placed on the turning card by its bearing. */
function CompassLetter({
  label,
  bearing,
  rot,
  centre,
  radius,
  pt,
  color,
  dim,
}: {
  label: string;
  bearing: number;
  rot: SharedValue<number>;
  centre: number;
  radius: number;
  pt: number;
  color: string;
  dim: boolean;
}) {
  const box = Math.ceil(pt * 1.5);
  const style = useAnimatedStyle(() => {
    const a = ((bearing + rot.get()) * Math.PI) / 180;
    return { transform: [{ translateX: radius * Math.sin(a) }, { translateY: -radius * Math.cos(a) }] };
  });
  return (
    <Animated.View
      testID={`hud-compass-${label}`}
      style={[styles.letter, { left: centre - box / 2, top: centre - box / 2, width: box, height: box, opacity: dim ? COMPASS_DIM_LETTERS : 1 }, style]}
    >
      <Text allowFontScaling={false} style={[styles.letterText, { color, fontSize: pt, lineHeight: Math.round(pt * 1.2) }]}>
        {label}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  letter: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  letterText: { fontFamily: fontFamilies.fieldBold, textAlign: 'center', includeFontPadding: false },
});
