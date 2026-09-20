import { useEffect, useRef } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { fontFamilies } from '../fonts';
import { Text } from '../primitives/Text';
import { useTheme } from '../theme';
import { useFontScale } from './scale';

export type StampKind = 'provisional' | 'safeDay' | 'passenger' | 'disputed' | 'A' | 'B' | 'C';
type Grade = 'A' | 'B' | 'C';
type StateKind = Exclude<StampKind, Grade>;

export type StampProps = {
  kind: StampKind;
  /** Replaces the printed word on a state stamp, or the caption under the letter on a grade stamp. */
  label?: string;
  size?: 'sm' | 'md';
  /**
   * Off renders the stamp at rest with no thump, for a stamp that re-mounts as a list recycles
   * its rows: the slam is for a stamp that has just landed, not one scrolling back into view.
   */
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Every stamp lands at this angle. The slam settles into it once, on mount, and never replays. */
export const STAMP_ROTATION_DEG = -8;
const SLAM_SCALE = 1.15;
const SLAM_ROTATION_DEG = STAMP_ROTATION_DEG - 6;

const STATE_TEXT: Record<StateKind, { printed: string; spoken: string }> = {
  provisional: { printed: 'PROVISIONAL', spoken: 'Provisional' },
  safeDay: { printed: 'SAFE DAY', spoken: 'Safe day' },
  passenger: { printed: 'PASSENGER', spoken: 'Passenger' },
  disputed: { printed: 'DISPUTED', spoken: 'Disputed' },
};
const GRADE_CAPTION = 'DATA QUALITY';

function isGrade(kind: StampKind): kind is Grade {
  return kind === 'A' || kind === 'B' || kind === 'C';
}

/**
 * A rubber stamp on the licence: a double-ruled box, inked in the state magenta (or ID blue for a
 * data-quality grade), pressed at eight degrees. The wash behind the letters is the ink bleeding
 * into the paper, and it is what keeps the word legible when the stamp lands across a printed
 * line such as the score ring. Motion is a single thump on mount; with reduce motion on the
 * stamp is simply there.
 */
export function Stamp({ kind, label, size = 'md', animate = true, style, testID }: StampProps) {
  const t = useTheme();
  const fs = useFontScale();
  // Sizes are steps of the M0 scale; the face stays B612 Bold from the `title` variants.
  const steps =
    size === 'md'
      ? { word: t.type.callout, letter: t.type.title2, caption: t.type.caption }
      : { word: t.type.caption, letter: t.type.headline, caption: t.type.caption };

  const text = isGrade(kind)
    ? {
        grade: true,
        printed: kind,
        caption: label ?? GRADE_CAPTION,
        spoken: `Data quality ${kind}${label ? `, ${label}` : ''}`,
      }
    : {
        grade: false,
        printed: label ?? STATE_TEXT[kind].printed,
        caption: null,
        spoken: label ?? STATE_TEXT[kind].spoken,
      };
  const ink = text.grade ? t.colors.accent : t.colors.stamp;
  const wash = text.grade ? t.colors.accentFaint : t.colors.stampFaint;

  const still = t.reduceMotion || !animate;
  const scale = useSharedValue(still ? 1 : SLAM_SCALE);
  const rotation = useSharedValue(still ? STAMP_ROTATION_DEG : SLAM_ROTATION_DEG);
  const opacity = useSharedValue(still ? 1 : 0);
  const slammed = useRef(false);

  useEffect(() => {
    if (still) {
      scale.value = 1;
      rotation.value = STAMP_ROTATION_DEG;
      opacity.value = 1;
      return;
    }
    if (slammed.current) return;
    slammed.current = true;
    const spring = { damping: t.motion.springDamping, stiffness: t.motion.springStiffness };
    opacity.value = withTiming(1, { duration: t.motion.fast });
    scale.value = withSpring(1, spring);
    rotation.value = withSpring(STAMP_ROTATION_DEG, spring);
  }, [
    still,
    scale,
    rotation,
    opacity,
    t.motion.fast,
    t.motion.springDamping,
    t.motion.springStiffness,
  ]);

  const slam = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ rotate: `${rotation.value}deg` }, { scale: scale.value }],
  }));

  const step = text.grade ? steps.letter : steps.word;
  const face = (
    <View
      style={{
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: ink,
        borderRadius: t.radius.sm - 2,
        paddingHorizontal: size === 'md' ? t.space.md : t.space.sm,
        paddingVertical: size === 'md' ? t.space.xs : 2,
        alignItems: 'center',
      }}
    >
      <Text
        variant={text.grade ? 'title1' : 'title2'}
        style={{
          color: ink,
          fontSize: step.fontSize * fs,
          lineHeight: step.lineHeight * fs,
          letterSpacing: text.grade ? 0 : 1.5,
          textTransform: 'uppercase',
        }}
      >
        {text.printed}
      </Text>
      {text.caption ? (
        <Text
          variant="caption"
          style={{
            color: ink,
            fontFamily: fontFamilies.field,
            fontSize: steps.caption.fontSize * fs,
            lineHeight: steps.caption.lineHeight * fs,
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          {text.caption}
        </Text>
      ) : null}
    </View>
  );

  const frame: ViewStyle = {
    alignSelf: 'flex-start',
    borderWidth: 2,
    borderColor: ink,
    borderRadius: t.radius.sm,
    backgroundColor: wash,
    padding: 2,
  };
  const a11y = {
    accessible: true,
    accessibilityRole: 'text' as const,
    accessibilityLabel: text.spoken,
    testID,
  };

  if (still) {
    return (
      <View {...a11y} style={[frame, { transform: [{ rotate: `${STAMP_ROTATION_DEG}deg` }] }, style]}>
        {face}
      </View>
    );
  }
  return (
    <Animated.View {...a11y} style={[frame, slam, style]}>
      {face}
    </Animated.View>
  );
}
