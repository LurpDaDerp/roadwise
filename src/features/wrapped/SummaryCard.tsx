import { LinearGradient } from 'expo-linear-gradient';
import { forwardRef, type ReactNode } from 'react';
import { Text as RNText, StyleSheet, View, type TextStyle } from 'react-native';

import type { PercentileKey, WrappedCore } from '@/data/server/wrapped';
import { formatDistance, type Units } from '@/lib/units';
import { useTheme, withAlpha, type TypeVariant } from '@/ui';

import { ArchetypeIcon } from './ArchetypeIcon';
import { archetypeName, archetypePattern, archetypeStops, CHIP_ALPHA, SOFT_INK_ALPHA } from './archetypes';
import { wrappedCopy as copy } from './copy';
import { percent, percentileText, rateParts } from './format';
import { monthYear } from './month';

/** The card's design size: a 9:16 story image, captured at 1080 × 1920 (`CARD_EXPORT`). */
export const CARD_W = 270;
export const CARD_H = 480;
export const CARD_EXPORT = { width: 1080, height: 1920 } as const;

const WHITE = '#FFFFFF';

/** Text on the captured card: a fixed-size image, so its type never follows Dynamic Type; `k` scales it with the card. */
function CardText({ children, variant, k, style, numberOfLines, testID }: { children: ReactNode; variant: TypeVariant; k: number; style?: TextStyle; numberOfLines?: number; testID?: string }) {
  const t = useTheme();
  const s = t.type[variant];
  return (
    <RNText
      allowFontScaling={false}
      maxFontSizeMultiplier={1}
      numberOfLines={numberOfLines}
      style={[
        {
          fontFamily: s.fontFamily,
          fontSize: s.fontSize * k,
          lineHeight: s.lineHeight * k,
          color: WHITE,
          ...(s.fontWeight ? { fontWeight: s.fontWeight } : null),
          ...(s.letterSpacing !== undefined ? { letterSpacing: s.letterSpacing * k } : null),
          ...(s.fontVariant ? { fontVariant: s.fontVariant } : null),
          ...(s.textTransform ? { textTransform: s.textTransform } : null),
        },
        style,
      ]}
      testID={testID}
    >
      {children}
    </RNText>
  );
}

/** The card's four numbers, each with its "Better than" chip when it has one. */
export function cardStats(core: WrappedCore, units: Units): { key: PercentileKey; value: string; label: string; chip: string | null }[] {
  const p = core.percentiles;
  const hard = rateParts(core.hardPer100, units);
  return [
    { key: 'miles', value: formatDistance(core.miles, units, { digits: 0 }), label: copy.summary.distance, chip: percentileText('miles', p.miles) },
    { key: 'avgScore', value: core.avgScore === null ? '—' : String(core.avgScore), label: copy.summary.avgScore, chip: percentileText('avgScore', p.avgScore) },
    { key: 'cleanShare', value: percent(core.cleanShare), label: copy.summary.clean, chip: percentileText('cleanShare', p.cleanShare) },
    { key: 'hardPer100', value: hard.value, label: `${copy.summary.hard} ${hard.per}`, chip: percentileText('hardPer100', p.hardPer100) },
  ];
}

/**
 * The Wrapped's shareable summary: the month, the "RoadWise" wordmark, the archetype's icon and name
 * on its gradient, then four numbers (distance, average drive score, clean drives, hard events per
 * 100 mi) with their "Better than" chips. Plain views, SVG and a gradient only, so it captures
 * cleanly; no routes, places, speeds or clock times. `width` sizes it (9:16), everything scaled
 * with it.
 */
export const SummaryCard = forwardRef<View, { core: WrappedCore; units: Units; width: number; testID?: string }>(function SummaryCard({ core, units, width, testID = 'wrapped-card' }, ref) {
  const k = width / CARD_W;
  const stops = archetypeStops(core.archetype);
  const soft = withAlpha(WHITE, SOFT_INK_ALPHA);
  const stats = cardStats(core, units);
  return (
    <View ref={ref} collapsable={false} testID={testID} style={{ width, height: (width * CARD_H) / CARD_W, borderRadius: 24 * k, overflow: 'hidden', padding: 18 * k }}>
      <LinearGradient colors={stops} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <CardText variant="title3" k={k} style={{ fontStyle: 'italic' }} testID={`${testID}-wordmark`}>
          RoadWise
        </CardText>
        <CardText variant="footnote" k={k} style={{ color: soft }} testID={`${testID}-month`}>
          {monthYear(core.month)}
        </CardText>
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 * k }}>
        <ArchetypeIcon pattern={archetypePattern(core.archetype)} size={96 * k} disc={withAlpha(WHITE, 0.16)} testID={`${testID}-icon`} />
        <CardText variant="title2" k={k} style={{ textAlign: 'center' }} numberOfLines={2} testID={`${testID}-name`}>
          {archetypeName(core.archetype)}
        </CardText>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 12 * k }}>
        {stats.map((s) => (
          <View key={s.key} style={{ width: '50%', paddingRight: 6 * k, gap: 2 * k }} testID={`${testID}-${s.key}`}>
            <CardText variant="stat" k={k * 0.86} numberOfLines={1}>
              {s.value}
            </CardText>
            <CardText variant="caption" k={k} style={{ color: soft }} numberOfLines={2}>
              {s.label}
            </CardText>
            {s.chip ? (
              <View style={{ alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 6 * k, paddingVertical: 2 * k, backgroundColor: withAlpha(WHITE, CHIP_ALPHA) }}>
                <CardText variant="caption" k={k * 0.8} numberOfLines={2} testID={`${testID}-${s.key}-chip`}>
                  {s.chip}
                </CardText>
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
});
