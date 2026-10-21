import { Ionicons } from '@expo/vector-icons';
import { useWindowDimensions, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';
import { EmptyState, SegmentedControl, Sheet, Text, useFontScale, useTheme } from '@/ui';

import { BestsCard, type BestKey } from './BestsCard';
import { analyticsCopy } from './copy';
import { countMetric, distanceMetric, percentMetric, timeMetric } from './format';
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
 * A category's numbers over the range, never points or rates: an event axis's total count and the
 * distance driven, Phone use's pickups and phone time, or Time of day's distance after dark and its
 * share of the driving.
 */
export function categoryGroup(axis: AxisKey, s: WindowSums, range: Range, units: Units): MetricGroup {
  const events = (key: string, caption: string, n: number): MetricGroup['cells'] => [
    { key, caption, metric: countMetric(n) },
    { key: `${key}-distance`, caption: m.distance, metric: distanceMetric(s.miles, units) },
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
      case 'night':
        return [
          { key: 'after-dark', caption: c.afterDark, metric: distanceMetric(s.nightMiles, units) },
          { key: 'dark-share', caption: c.darkShare, metric: percentMetric(s.nightPct) },
        ];
    }
  })();
  return { key: axis, title: c.range[range], cells };
}

/** The all-time best that belongs to a category, if any. */
export const CATEGORY_BEST: Partial<Record<AxisKey, BestKey>> = { phone: 'phone-free' };

/** The sheet's title: the category and its 30-day score ("Speed · 82", "Speed · —"). */
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
 * quarters of the window's height. A range with no drives shows "No data yet" in their place (and
 * no verdict either when the 30 days have no score), so the sheet always opens to something.
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
  const empty = sums.drives === 0;
  return (
    <Sheet visible={visible} onClose={onClose} title={categoryTitle(axis, score)} subtitle={c.subtitle} scroll testID="category-sheet">
      {empty && score === null ? null : (
        <View accessible accessibilityLabel={spoken} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }} testID="category-coaching">
          <Ionicons name={icon} size={t.size.iconLg} color={color} testID="category-coaching-icon" />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="headline">{verdict.title}</Text>
            <Text variant="subhead" tone="muted">
              {verdict.tip}
            </Text>
          </View>
        </View>
      )}
      <SegmentedControl accessibilityLabel={analyticsCopy.range} segments={SEGMENTS} value={range} onChange={onRange} testID="category-range" />
      {empty ? (
        <EmptyState icon="analytics-outline" title={c.empty} body={c.emptyBody(c.range[range])} testID="category-empty" />
      ) : (
        <>
          <NumberCard group={group} layout={l} text={metricsText(l)} variant="raised" />
          {best ? <BestsCard bests={bests} show={[best]} onOpen={onOpenDrive} variant="raised" testID="category-best" /> : null}
        </>
      )}
    </Sheet>
  );
}
