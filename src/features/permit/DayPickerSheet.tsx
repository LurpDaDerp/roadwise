// A month calendar in a sheet, for the log's start date: one month at a time, days after `max`
// (today) can't be picked, and a tap picks the day. Plain views, no native picker.
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { IconButton, Sheet, Text, useTheme } from '@/ui';

import { permitCopy } from './copy';

const copy = permitCopy.startDay;
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" for a day of a month (`month` 0–11). */
export const dayOf = (year: number, month: number, day: number): string => `${year}-${pad(month + 1)}-${pad(day)}`;

/** The year and month (0–11) of a "YYYY-MM-DD" day. */
export function monthOf(day: string): { year: number; month: number } {
  const [y, m] = day.split('-').map(Number);
  return { year: y ?? 1970, month: (m ?? 1) - 1 };
}

/** A month's cells, Sunday first: null before the 1st and after the last day, to whole weeks. */
export function monthGrid(year: number, month: number): (number | null)[] {
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [...Array<null>(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const monthTitle = (year: number, month: number) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(year, month, 1));

export function DayPickerSheet({
  visible,
  value,
  max,
  onPick,
  onClose,
}: {
  visible: boolean;
  value: string;
  /** The last day that can be picked (today). */
  max: string;
  onPick: (day: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={copy.sheetTitle} subtitle={copy.body} testID="permit-day-sheet">
      {visible ? <Calendar key={value} value={value} max={max} onPick={onPick} /> : null}
    </Sheet>
  );
}

function Calendar({ value, max, onPick }: { value: string; max: string; onPick: (day: string) => void }) {
  const t = useTheme();
  const [shown, setShown] = useState(() => monthOf(value));
  const top = monthOf(max);
  const atMax = shown.year > top.year || (shown.year === top.year && shown.month >= top.month);
  const step = (by: -1 | 1) => setShown(({ year, month }) => ({ year: month + by < 0 ? year - 1 : month + by > 11 ? year + 1 : year, month: (month + by + 12) % 12 }));
  const cells = monthGrid(shown.year, shown.month);
  const title = monthTitle(shown.year, shown.month);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));

  return (
    <View style={{ gap: t.space.md, paddingBottom: t.space.lg }} testID="permit-calendar">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <IconButton icon="chevron-back" accessibilityLabel={copy.prevMonth} onPress={() => step(-1)} variant="surface" testID="permit-calendar-prev" />
        <Text variant="headline" style={{ flex: 1, textAlign: 'center' }} accessibilityRole="header" testID="permit-calendar-month">
          {title}
        </Text>
        <IconButton icon="chevron-forward" accessibilityLabel={copy.nextMonth} onPress={() => step(1)} variant="surface" disabled={atMax} testID="permit-calendar-next" />
      </View>
      <View style={{ flexDirection: 'row' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {WEEKDAYS.map((d, i) => (
          <Text key={i} variant="caption" tone="muted" style={{ flex: 1, textAlign: 'center' }}>
            {d}
          </Text>
        ))}
      </View>
      {weeks.map((week, w) => (
        <View key={w} style={{ flexDirection: 'row' }}>
          {week.map((n, i) => {
            if (n === null) return <View key={i} style={{ flex: 1, aspectRatio: 1 }} />;
            const day = dayOf(shown.year, shown.month, n);
            const off = day > max;
            const on = day === value;
            return (
              <Pressable
                key={i}
                onPress={() => onPick(day)}
                disabled={off}
                accessibilityRole="button"
                accessibilityState={{ disabled: off, selected: on }}
                accessibilityLabel={`${WEEKDAY_NAMES[i]}, ${title.split(' ')[0]} ${n}`}
                testID={`permit-day-${day}`}
                style={{ flex: 1, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' }}
              >
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: on ? t.colors.accent : 'transparent',
                  }}
                >
                  <Text variant="body" style={{ color: on ? t.colors.accentText : off ? t.colors.textSubtle : t.colors.text }}>
                    {n}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
