import { Ionicons } from '@expo/vector-icons';
import { useWindowDimensions, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';
import { EmptyState, SegmentedControl, Sheet, Text, useFontScale, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import { countMetric, distanceMetric, timeMetric } from './format';
import { metricsLayout, metricsText, NumberCard, type MetricGroup } from './MetricsCards';
import {
  AXIS_LABEL,
  axisCoaching,
  DASHPAL_AXIS,
  LEVEL_ICON,
  LEVEL_LABEL,
  LEVEL_TONE,
  RANGE_LABEL,
  RANGES,
  type AxisKey,
  type Range,
  type WindowSums,
} from './model';

const c = analyticsCopy.category;
const m = analyticsCopy.metrics;
const SEGMENTS = RANGES.map((value) => ({ value, label: RANGE_LABEL[value] }));

/**
 * A category's numbers over the range: its events against its chances to slip (hard brakes and
 * slowdowns, hard starts and speed-ups, sharp turns and turns), Speed's events with the time over
 * the limit and the time with a known limit, or Attention's eyes-off and drowsy counts and the
 * distance DashPal watched.
 */
export function categoryGroup(axis: AxisKey, s: WindowSums, range: Range, units: Units): MetricGroup {
  const cells = ((): MetricGroup['cells'] => {
    switch (axis) {
      case 'speed':
        return [
          { key: 'speeding', caption: m.speeding, metric: countMetric(s.speeding) },
          { key: 'over-limit', caption: m.overLimit, metric: timeMetric(s.speedingS) },
          { key: 'with-limit', caption: m.withLimit, metric: timeMetric(s.limitS) },
        ];
      case 'braking':
        return [
          { key: 'brakes', caption: m.hardBrakes, metric: countMetric(s.hardBrake) },
          { key: 'slowdowns', caption: m.slowdowns, metric: countMetric(s.slowdowns) },
        ];
      case 'acceleration':
        return [
          { key: 'starts', caption: m.hardStarts, metric: countMetric(s.hardAccel) },
          { key: 'speedups', caption: m.speedups, metric: countMetric(s.speedups) },
        ];
      case 'turning':
        return [
          { key: 'sharp-turns', caption: m.sharpTurns, metric: countMetric(s.hardCorner) },
          { key: 'turns', caption: m.turns, metric: countMetric(s.turns) },
        ];
      case 'attention':
        return [
          { key: 'eyes-off', caption: c.eyesOff, metric: countMetric(s.eyesOff) },
          { key: 'drowsy', caption: c.drowsy, metric: countMetric(s.drowsy) },
          { key: 'watched', caption: c.watched, metric: distanceMetric(s.watchedMiles, units) },
        ];
    }
  })();
  return { key: axis, title: c.range[range], cells };
}

/**
 * The line under a category's numbers: how often it slipped per chance ("1 hard brake per 137
 * slowdowns", "Over the limit 2% of the time"), marked "(estimated)" while the range holds drives
 * recorded before the chances were counted. Null for Attention and a range with no chances.
 */
export function rateLine(axis: AxisKey, s: WindowSums): string | null {
  const r = c.rate;
  const line = (() => {
    switch (axis) {
      case 'braking':
        return r.braking(s.hardBrake, s.slowdowns);
      case 'acceleration':
        return r.acceleration(s.hardAccel, s.speedups);
      case 'turning':
        return r.turning(s.hardCorner, s.turns);
      case 'speed':
        return r.speed(s.speedingS, s.limitS);
      case 'attention':
        return null;
    }
  })();
  return line !== null && s.exposureEstimated ? r.estimated(line) : line;
}

/** The sheet's title: the category and its 90-day score ("Speed · 82", "Speed · —"); a locked one its name alone. */
export const categoryTitle = (axis: AxisKey, score: number | null, locked = false): string =>
  locked ? AXIS_LABEL[axis] : `${AXIS_LABEL[axis]} · ${score === null ? '—' : score}`;

export interface CategorySheetProps {
  axis: AxisKey;
  visible: boolean;
  onClose: () => void;
  /** The axis's 90-day score. */
  score: number | null;
  /** The 90-day window's scored drives and miles: under 3 drives or 10 mi there is no verdict yet. */
  last90: { drives: number; miles: number };
  sums: WindowSums;
  range: Range;
  onRange: (range: Range) => void;
  /** A DashPal is paired: without one Attention is locked and offers to set one up. */
  dashpalPaired: boolean;
  onPairDashpal: () => void;
}

/**
 * One radar category's details in a sheet, under its name and score: its own verdict (the level
 * icon and word, a title and a tip), the page's time range, the range's numbers for it, and one
 * line on how often it slipped per chance. The numbers follow the metrics block's rule: never more than three
 * quarters of the window's height. A range with no drives shows "No data yet" in their place (and
 * no verdict either when the 30 days have no score), so the sheet always opens to something.
 * Attention without a paired DashPal says where it comes from and offers to set one up; with one
 * but no watched drives in the range, it says so.
 */
export function CategorySheet({ axis, visible, onClose, score, last90, sums, range, onRange, dashpalPaired, onPairDashpal }: CategorySheetProps) {
  const t = useTheme();
  const units = useUnits();
  const { height } = useWindowDimensions();
  const group = categoryGroup(axis, sums, range, units);
  const l = metricsLayout(height, useFontScale(), [group.cells.length], false);
  const verdict = axisCoaching(axis, score, last90);
  const icon = verdict.level ? LEVEL_ICON[verdict.level] : 'time-outline';
  const color = verdict.level ? t.colors[LEVEL_TONE[verdict.level]] : t.colors.textMuted;
  const spoken = [verdict.level ? LEVEL_LABEL[verdict.level] : null, verdict.title, verdict.tip].filter(Boolean).join('. ');
  const rate = rateLine(axis, sums);
  const attention = axis === DASHPAL_AXIS;
  if (attention && !dashpalPaired) {
    return (
      <Sheet visible={visible} onClose={onClose} title={categoryTitle(axis, null, true)} scroll testID="category-sheet">
        <EmptyState icon="lock-closed-outline" title={c.locked.title} body={c.locked.body} action={{ label: c.locked.action, onPress: onPairDashpal }} testID="category-locked" />
      </Sheet>
    );
  }
  const empty = attention ? sums.watchedMiles <= 0 : sums.drives === 0;
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
        <EmptyState
          icon="analytics-outline"
          title={attention ? c.noDashpal : c.empty}
          body={attention ? c.noDashpalBody(c.range[range]) : c.emptyBody(c.range[range])}
          testID="category-empty"
        />
      ) : (
        <>
          <NumberCard group={group} layout={l} text={metricsText(l)} variant="raised" />
          {rate ? (
            <Text variant="subhead" tone="muted" testID="category-rate">
              {rate}
            </Text>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
