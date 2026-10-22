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
 * The shading steps, fewest to most drives: neutral greys evenly spaced in OKLab lightness, so each
 * step looks as far from the next as any other. On the light card light grey to near-black (L 0.86
 * down to 0.18), on the dark card mirrored, dark grey to near-white (L 0.36 up to 0.96), so the
 * busiest cell always stands out most. Empty cells are an outline instead of a fill, so they differ
 * from the faintest step by shape too.
 */
export const HEAT_STEPS = 5;
export const HEAT_RAMP = {
  light: ['#D1D1D1', '#9B9B9B', '#696969', '#3A3A3A', '#121212'],
  dark: ['#3D3D3D', '#666666', '#929292', '#C1C1C1', '#F2F2F2'],
} as const satisfies Record<'light' | 'dark', readonly string[]>;

/** A cell's step: 0 for no drives, then 1–5 by its share of the busiest cell (a single drive is at least 1). */
export const cellLevel = (count: number, max: number): number =>
  count <= 0 || max <= 0 ? 0 : Math.max(1, Math.min(HEAT_STEPS, Math.ceil((count / max) * HEAT_STEPS)));

/**
 * When every scored drive (all time) started: weekdays down the side (Monday first), 3-hour bands across,
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
