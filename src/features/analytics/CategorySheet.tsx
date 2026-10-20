import { Ionicons } from '@expo/vector-icons';
import { useWindowDimensions, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';
import { SegmentedControl, Sheet, Text, useFontScale, useTheme } from '@/ui';

import { BestsCard, type BestKey } from './BestsCard';
import { analyticsCopy } from './copy';
import { countMetric, percentMetric, rateMetric, timeMetric } from './format';
import { metricsLayout, metricsText, NumberCard, type MetricGroup } from './MetricsCards';
import {
  AXIS_LABEL,
  axisCoaching,
  LEVEL_ICON,
  LEVEL_LABEL,
  LEVEL_TONE,
  RANGE_LABEL,
  RANGES,
  type AxisKey,
  type PersonalBests,
  type Range,
  type WindowSums,
} from './model';

const c = analyticsCopy.category;
const m = analyticsCopy.metrics;
const SEGMENTS = RANGES.map((value) => ({ value, label: RANGE_LABEL[value] }));

/**
 * A category's numbers over the range, never points: an event axis's count and its rate per 100 of
 * the driver's units, Phone use's pickups and phone time, or the clean drives and their share.
 */
export function categoryGroup(axis: AxisKey, s: WindowSums, range: Range, units: Units): MetricGroup {
  const events = (key: string, caption: string, n: number): MetricGroup['cells'] => [
    { key, caption, metric: countMetric(n) },
    { key: `${key}-rate`, caption: c.rate, metric: rateMetric(n, s.miles, units) },
  ];
  const cells = ((): MetricGroup['cells'] => {
    switch (axis) {
      case 'speeding':
        return events('speeding', m.speeding, s.speeding);
      case 'braking':
        return events('brakes', m.hardBrakes, s.hardBrake);
      case 'accel':
        return events('starts', m.hardStarts, s.hardAccel);
      case 'cornering':
        return events('turns', m.sharpTurns, s.hardCorner);
      case 'phone':
        return [
          { key: 'pickups', caption: m.pickups, metric: countMetric(s.pickups) },
          { key: 'phone-time', caption: m.phoneTime, metric: timeMetric(s.handlingS) },
        ];
      case 'clean':
        return [
          { key: 'clean', caption: m.cleanDrives, metric: countMetric(s.cleanDrives) },
          { key: 'clean-share', caption: c.cleanShare, metric: percentMetric(s.cleanPct) },
        ];
    }
  })();
  return { key: axis, title: c.range[range], cells };
}

/** The all-time best that belongs to a category, if any. */
export const CATEGORY_BEST: Partial<Record<AxisKey, BestKey>> = { phone: 'phone-free', clean: 'clean' };

/** The sheet's title: the category and its 30-day score ("Speeding · 82", "Speeding · —"). */
export const categoryTitle = (axis: AxisKey, score: number | null): string => `${AXIS_LABEL[axis]} · ${score === null ? '—' : score}`;

export interface CategorySheetProps {
  axis: AxisKey;
  visible: boolean;
  onClose: () => void;
  /** The axis's 30-day score. */
  score: number | null;
  /** The 30-day window's scored drives and miles: under 3 drives or 10 mi there is no verdict yet. */
  last30: { drives: number; miles: number };
  sums: WindowSums;
  bests: PersonalBests;
  range: Range;
  onRange: (range: Range) => void;
  onOpenDrive: (clientTripId: string) => void;
}

/**
 * One radar category's details in a sheet, under its name and score: its own verdict (the level
 * icon and word, a title and a tip), the page's time range, the range's numbers for it, and its
 * all-time best when it has one. The numbers follow the metrics block's rule: never more than three
 * quarters of the window's height.
 */
export function CategorySheet({ axis, visible, onClose, score, last30, sums, bests, range, onRange, onOpenDrive }: CategorySheetProps) {
  const t = useTheme();
  const units = useUnits();
  const { height } = useWindowDimensions();
  const group = categoryGroup(axis, sums, range, units);
  const l = metricsLayout(height, useFontScale(), [group.cells.length], false);
  const verdict = axisCoaching(axis, score, last30);
  const icon = verdict.level ? LEVEL_ICON[verdict.level] : 'time-outline';
  const color = verdict.level ? t.colors[LEVEL_TONE[verdict.level]] : t.colors.textMuted;
  const spoken = [verdict.level ? LEVEL_LABEL[verdict.level] : null, verdict.title, verdict.tip].filter(Boolean).join('. ');
  const best = CATEGORY_BEST[axis];
  return (
    <Sheet visible={visible} onClose={onClose} title={categoryTitle(axis, score)} subtitle={c.subtitle} scroll testID="category-sheet">
      <View accessible accessibilityLabel={spoken} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }} testID="category-coaching">
        <Ionicons name={icon} size={t.size.iconLg} color={color} testID="category-coaching-icon" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline">{verdict.title}</Text>
          <Text variant="subhead" tone="muted">
            {verdict.tip}
          </Text>
        </View>
      </View>
      <SegmentedControl accessibilityLabel={analyticsCopy.range} segments={SEGMENTS} value={range} onChange={onRange} testID="category-range" />
      <NumberCard group={group} layout={l} text={metricsText(l)} variant="raised" />
      {best ? <BestsCard bests={bests} show={[best]} onOpen={onOpenDrive} variant="raised" testID="category-best" /> : null}
    </Sheet>
  );
}
