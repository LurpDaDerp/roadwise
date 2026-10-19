import { memo, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { formatPointsValue, tokens } from '@/ui';
import { fontFamilies } from '@/ui/fonts';
import type { HudPalette } from '@/ui/drive';

import { hudCopy } from './hudCopy';

const m = tokens.motion;

/**
 * The points, shown only while stopped (the parent renders this only when `points` is non-null):
 * the running total and the change since the last stop, labelled as such. A gain is green with one brief pulse; a
 * loss is red with one small shake; reduce motion keeps the colour and drops the movement. It
 * plays when it appears and whenever the change moves while still stopped — never while moving,
 * because it does not exist then.
 */
function StoppedPointsView({ total, change, palette: p }: { total: number; change: number; palette: HudPalette }) {
  const still = useReducedMotion();
  const scale = useSharedValue(1);
  const x = useSharedValue(0);

  useEffect(() => {
    if (still || change === 0) return;
    if (change > 0) {
      scale.set(withSequence(withTiming(1.1, { duration: m.pulse / 2 }), withSpring(1, m.spring.bouncy)));
    } else {
      const d = m.shakeDistance;
      const step = m.shake / 5;
      x.set(
        withSequence(
          withTiming(-d, { duration: step }),
          withTiming(d, { duration: step }),
          withTiming(-d / 2, { duration: step }),
          withTiming(d / 2, { duration: step }),
          withTiming(0, { duration: step })
        )
      );
    }
  }, [change, still, scale, x]);

  const motion = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }, { scale: scale.get() }] }));

  const totalText = formatPointsValue(total);
  const changeText = formatPointsValue(change, true);
  const changeColor = change > 0 ? p.gain : change < 0 ? p.severe : p.inkMuted;

  return (
    <View
      testID="hud-points"
      accessible
      accessibilityLabel={hudCopy.points.label(totalText, changeText)}
      style={styles.row}
    >
      <Text allowFontScaling={false} style={[styles.total, { color: p.ink }]}>
        {totalText}
        <Text style={[styles.unit, { color: p.inkMuted }]}> {hudCopy.points.unit}</Text>
      </Text>
      <Animated.View style={[styles.changeBox, motion]}>
        <Text allowFontScaling={false} numberOfLines={1} adjustsFontSizeToFit>
          <Text testID="hud-points-change" style={[styles.change, { color: changeColor }]}>
            {changeText}
          </Text>
          <Text style={[styles.since, { color: p.inkMuted }]}> {hudCopy.points.since}</Text>
        </Text>
      </Animated.View>
    </View>
  );
}

export const StoppedPoints = memo(StoppedPointsView);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 14 },
  total: { fontFamily: fontFamilies.numeralsBold, fontSize: 40, lineHeight: 46, fontVariant: ['tabular-nums'] },
  unit: { fontFamily: fontFamilies.field, fontSize: 20 },
  changeBox: { flexShrink: 1 },
  change: { fontFamily: fontFamilies.numeralsBold, fontSize: 32, lineHeight: 38, fontVariant: ['tabular-nums'] },
  since: { fontFamily: fontFamilies.field, fontSize: 16 },
});
