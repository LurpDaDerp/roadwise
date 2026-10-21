import type { MeritTier } from '@scoring';
import { useEffect } from 'react';
import { Text as RNText, View, type TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';

import { formatDistance, type Units } from '@/lib/units';
import { ensureContrast, MeritIcon, useCountUp, useFontScale, useTheme, withAlpha, type TypeVariant } from '@/ui';
import { opaque, over } from '@/ui/sky/color';

import { recapCopy } from './copy';
import { formatDuration, spokenDuration } from './format';
import { MERIT_MIN_CONTRAST, meritInk } from './merit';

export interface MeritFactsProps {
  /** `card` = the 320 × 400 share image's fixed type; `hero` = the same families at 0.8×, following Dynamic Type. */
  size: 'card' | 'hero';
  /** The drive score; "—" when null, then no icon and the plain ink. */
  score: number | null;
  miles: number;
  durationS: number;
  units: Units;
  /** `driveMerit(score, miles)`. */
  tier: MeritTier | null;
  /** What the text sits on (the sky scene's stops for the card; the card and its wash for the hero): every ink reads at 4.5:1 on each. */
  surfaces: readonly string[];
  /** The surface's ordinary text ink (white on the card, `colors.text` on the hero). */
  plainInk: string;
  /** Count the score up from 0 and land it with one soft pulse (a fresh recap; never under reduce motion). */
  countUp?: boolean;
  testID?: string;
}

/** The type size factor for the hero, the recap's smaller sibling of the share card. */
export const HERO_FACTOR = 0.8;
/** The hero's labels never shrink under this. */
const MIN_LABEL_PT = 12;
const ICON_PT: Record<MeritFactsProps['size'], number> = { card: 28, hero: 22 };

/** The three facts in words for a screen reader: "Score 92 out of 100, 12.0 miles, 24 minutes, merit 4 of 5." */
export function spokenFacts(score: number | null, miles: number, durationS: number, units: Units, tier: MeritTier | null): string {
  return recapCopy.facts.spoken(score, formatDistance(miles, units, { spoken: true }), spokenDuration(durationS), tier);
}

/** The inks the facts are drawn in: the tier's for the three values (the plain ink without a tier), the labels at 70 % of the plain ink. */
export function factInks(tier: MeritTier | null, surfaces: readonly string[], plainInk: string): { value: string; label: string } {
  const on = surfaces.map(opaque);
  const value = tier === null ? plainInk : meritInk(tier, on);
  // 70 % of the plain ink, as an opaque colour over the first surface, repaired to AA on all of them.
  const label = on.length === 0 ? plainInk : ensureContrast(over(on[0]!, withAlpha(opaque(plainInk), 0.7)), on, MERIT_MIN_CONTRAST);
  return { value, label };
}

/**
 * The drive's facts as the share card shows them, and as the recap's hero mirrors them: the tier's
 * icon beside the score, then distance and time, the three values in the tier's ink, each labelled
 * ("score", "distance", "time") in the plain ink. ONE component draws both, so they can't drift.
 * No tier name anywhere: a tier is its icon and its colour. One element for a screen reader.
 */
export function MeritFacts({ size, score, miles, durationS, units, tier, surfaces, plainInk, countUp = false, testID }: MeritFactsProps) {
  const t = useTheme();
  const hero = size === 'hero';
  const inks = factInks(score === null ? null : tier, surfaces, plainInk);
  const shownTier = score === null ? null : tier;
  // The card is a fixed image: its type never follows Dynamic Type. The hero does, capped per style.
  const displayScale = useFontScale(t.type.display.maxScale);
  const statScale = useFontScale(t.type.stat.maxScale);
  const labelScale = useFontScale(1.5);
  const style = (variant: TypeVariant, scale: number, color: string, min = 0): TextStyle => {
    const s = t.type[variant];
    const f = hero ? Math.max(min, s.fontSize * HERO_FACTOR * scale) / s.fontSize : 1;
    return {
      fontFamily: s.fontFamily,
      fontSize: s.fontSize * f,
      lineHeight: s.lineHeight * f,
      color,
      ...(s.fontWeight ? { fontWeight: s.fontWeight } : null),
      ...(s.letterSpacing !== undefined ? { letterSpacing: s.letterSpacing } : null),
      ...(s.fontVariant ? { fontVariant: s.fontVariant } : null),
    };
  };
  const label = style('label', labelScale, inks.label, MIN_LABEL_PT);
  const animate = hero && countUp && !t.reduceMotion && score !== null;
  const shownScore = useCountUp(score ?? 0, { from: 0, duration: t.motion.countUp, enabled: animate });
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (!animate) return;
    const id = setTimeout(() => {
      pulse.set(withSequence(withTiming(1.1, { duration: t.motion.pulse / 2 }), withSpring(1, t.motion.spring.bouncy)));
    }, t.motion.countUp);
    return () => clearTimeout(id);
  }, [animate, pulse, t.motion.countUp, t.motion.pulse, t.motion.spring.bouncy]);
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.get() }] }));

  const id = (part: string) => (testID ? `${testID}-${part}` : undefined);
  const fact = (value: string, word: string, part: string) => (
    <View style={{ flex: 1, minWidth: 0 }}>
      <RNText allowFontScaling={false} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={style('stat', statScale, inks.value)} testID={id(part)}>
        {value}
      </RNText>
      <RNText allowFontScaling={false} style={label} testID={id(`${part}-label`)}>
        {word}
      </RNText>
    </View>
  );

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={spokenFacts(score, miles, durationS, units, shownTier)}
      style={{ gap: hero ? t.space.sm : t.space.md }}
    >
      <View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
          {shownTier !== null ? (
            <MeritIcon tier={shownTier} size={ICON_PT[size] * (hero ? Math.min(displayScale, 1.3) : 1)} color={inks.value} testID={id('icon')} />
          ) : null}
          <Animated.View style={pulseStyle}>
            <RNText allowFontScaling={false} style={style('display', displayScale, inks.value)} testID={id('score')}>
              {score === null ? '—' : String(animate ? shownScore : score)}
            </RNText>
          </Animated.View>
        </View>
        <RNText allowFontScaling={false} style={label} testID={id('score-label')}>
          {recapCopy.facts.score}
        </RNText>
      </View>
      <View style={{ flexDirection: 'row', gap: t.space.lg }}>
        {fact(formatDistance(miles, units), recapCopy.facts.distance, 'distance')}
        {fact(formatDuration(durationS), recapCopy.facts.time, 'time')}
      </View>
    </View>
  );
}
