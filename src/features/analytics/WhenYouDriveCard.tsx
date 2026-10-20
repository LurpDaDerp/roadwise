import { View } from 'react-native';

import { Card, Text, useFontScale, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import { BAND_LABELS, BAND_TICKS, WEEKDAY_LABELS, type DriveGrid } from './model';
import { sizeAt } from './textSize';

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const CELL_H = 20;
const GAP = 4;
/** The weekday column at 1×; it widens with the text so a large "M" or "W" is never clipped. */
const LABEL_COL = 16;
/** The ticks fall on every other band, so each tick spans two columns. */
const BANDS_PER_TICK = 2;

/** The busiest weekday × band (the earliest on a tie), or null for an empty grid. */
export function busiest(grid: DriveGrid): { day: number; band: number; count: number } | null {
  if (grid.max === 0) return null;
  for (let day = 0; day < grid.cells.length; day++) {
    const band = grid.cells[day]!.indexOf(grid.max);
    if (band >= 0) return { day, band, count: grid.max };
  }
  return null;
}

/** "3p–6p" for band 5. */
export const bandSpan = (band: number): string => `${BAND_LABELS[band]}–${BAND_LABELS[(band + 1) % BAND_LABELS.length]}`;

/**
 * The colour steps, fewest to most drives: teal through blue to deep violet on the light card,
 * blue through teal to lime on the dark one (a viridis-like order), so the busiest cell always
 * stands out most. Even the first step stands at 3:1 against its card; empty cells are an outline
 * instead, so they differ by shape too.
 */
export const HEAT_STEPS = 5;
export const HEAT_RAMP = {
  light: ['#2A9D8F', '#2B83BA', '#3B5BA9', '#4A2F8F', '#2A0F5C'],
  dark: ['#2B83BA', '#2FA3B5', '#4CC0A8', '#8FD98C', '#D9F07A'],
} as const satisfies Record<'light' | 'dark', readonly string[]>;

/** A cell's step: 0 for no drives, then 1–5 by its share of the busiest cell (a single drive is at least 1). */
export const cellLevel = (count: number, max: number): number =>
  count <= 0 || max <= 0 ? 0 : Math.max(1, Math.min(HEAT_STEPS, Math.ceil((count / max) * HEAT_STEPS)));

/**
 * When the range's drives start: weekdays down the side (Monday first), 3-hour bands across,
 * each cell coloured on a five-step scale by how many drives started there, with a Fewer–More key.
 */
export function WhenYouDriveCard({ grid }: { grid: DriveGrid }) {
  const t = useTheme();
  const labelCol = Math.max(LABEL_COL, Math.ceil(sizeAt('caption', useFontScale()).fontSize * 1.1));
  const top = busiest(grid);
  const ramp = HEAT_RAMP[t.scheme === 'dark' ? 'dark' : 'light'];
  const spoken = top
    ? `${analyticsCopy.grid.title}. ${grid.total} ${grid.total === 1 ? 'drive' : 'drives'}. ${analyticsCopy.grid.busiest}: ${WEEKDAY_NAMES[top.day]} ${bandSpan(top.band)}, ${top.count} ${top.count === 1 ? 'drive' : 'drives'}.`
    : `${analyticsCopy.grid.title}. ${analyticsCopy.grid.empty}.`;

  return (
    <Card testID="analytics-grid">
      <Text variant="title3" accessibilityRole="header">
        {analyticsCopy.grid.title}
      </Text>
      {grid.total === 0 ? (
        <Text variant="subhead" tone="muted" testID="analytics-grid-empty">
          {analyticsCopy.grid.empty}
        </Text>
      ) : (
        <View accessible accessibilityRole="image" accessibilityLabel={spoken} style={{ gap: GAP }}>
          {grid.cells.map((row, day) => (
            <View key={day} style={{ flexDirection: 'row', alignItems: 'center', gap: GAP }}>
              <Text variant="caption" tone="muted" style={{ width: labelCol, textAlign: 'center' }} testID={`grid-day-${day}`}>
                {WEEKDAY_LABELS[day]}
              </Text>
              {row.map((count, band) => {
                const level = cellLevel(count, grid.max);
                return (
                  <View
                    key={band}
                    testID={`grid-${day}-${band}`}
                    style={{
                      flex: 1,
                      height: CELL_H,
                      borderRadius: 5,
                      borderCurve: 'continuous',
                      backgroundColor: level > 0 ? ramp[level - 1] : 'transparent',
                      borderWidth: level > 0 ? 0 : 1,
                      borderColor: t.colors.border,
                    }}
                  />
                );
              })}
            </View>
          ))}
          <View style={{ flexDirection: 'row', gap: GAP }}>
            <View style={{ width: labelCol }} />
            {BAND_TICKS.map((b) => (
              <Text key={b} variant="caption" tone="muted" style={{ flex: BANDS_PER_TICK }} testID={`grid-tick-${b}`}>
                {b}
              </Text>
            ))}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.sm, marginTop: GAP }}>
            {top ? (
              <Text variant="footnote" tone="subtle" style={{ flexShrink: 1 }} testID="analytics-grid-busiest">
                {`${analyticsCopy.grid.busiest}: ${WEEKDAY_SHORT[top.day]} ${bandSpan(top.band)}`}
              </Text>
            ) : (
              <View />
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }} testID="analytics-grid-key">
              <Text variant="caption" tone="muted">
                {analyticsCopy.grid.fewer}
              </Text>
              {ramp.map((c) => (
                <View key={c} style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: c }} />
              ))}
              <Text variant="caption" tone="muted">
                {analyticsCopy.grid.more}
              </Text>
            </View>
          </View>
        </View>
      )}
    </Card>
  );
}
