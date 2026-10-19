import { View } from 'react-native';

import { Card, Text, useFontScale, useTheme, withAlpha } from '@/ui';

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
 * How strong a cell's ink is: nothing for no drives, then a ramp up to the busiest that starts
 * dark enough for a one-drive cell to stand at 3:1 against the card. Empty cells are an outline
 * as well, so they differ by shape and not only by shade.
 */
export const CELL_ALPHA_MIN = 0.45;
export const cellAlpha = (count: number, max: number): number =>
  count <= 0 || max <= 0 ? 0 : CELL_ALPHA_MIN + (1 - CELL_ALPHA_MIN) * (count / max);

/**
 * When the range's drives start: weekdays down the side (Monday first), 3-hour bands across,
 * each cell shaded in the page ink by how many drives started there.
 */
export function WhenYouDriveCard({ grid }: { grid: DriveGrid }) {
  const t = useTheme();
  const labelCol = Math.max(LABEL_COL, Math.ceil(sizeAt('caption', useFontScale()).fontSize * 1.1));
  const top = busiest(grid);
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
                const a = cellAlpha(count, grid.max);
                return (
                  <View
                    key={band}
                    testID={`grid-${day}-${band}`}
                    style={{
                      flex: 1,
                      height: CELL_H,
                      borderRadius: 5,
                      borderCurve: 'continuous',
                      backgroundColor: a > 0 ? withAlpha(t.colors.text, a) : 'transparent',
                      borderWidth: a > 0 ? 0 : 1,
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
          {top ? (
            <Text variant="footnote" tone="subtle" testID="analytics-grid-busiest">
              {`${analyticsCopy.grid.busiest}: ${WEEKDAY_SHORT[top.day]} ${bandSpan(top.band)}`}
            </Text>
          ) : null}
        </View>
      )}
    </Card>
  );
}
