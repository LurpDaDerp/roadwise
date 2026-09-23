import { StyleSheet, View } from 'react-native';

import { ListRow, Text, useTheme } from '@/ui';

/**
 * A day key (`YYYY-MM-DD`) as "September 24". A day key names a calendar day, not an instant, so
 * it is printed in UTC, where it is exactly that day.
 */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
  );
}

/** An instant as "September 20" on the driver's calendar. */
export function formatInstant(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: tz }).format(new Date(iso));
}

/** `day` moved by `n` calendar days (`YYYY-MM-DD` in and out). */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/**
 * Counted days as a printed line and a bar under it, read as one progress bar. The words carry the
 * whole meaning (the bar only repeats them), so nothing rides on the fill alone; the screen reader
 * hears the value's own sentence.
 */
export function DayBar({
  value,
  max,
  text,
  spoken,
  label,
  testID,
}: {
  value: number;
  max: number;
  text: string;
  spoken: string;
  label: string;
  testID?: string;
}) {
  const th = useTheme();
  const now = Math.max(0, Math.min(value, max));
  const fraction = max > 0 ? now / max : 0;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max, now, text: spoken }}
      testID={testID}
      style={{ gap: th.space.sm }}
    >
      <Text variant="headline" style={{ fontVariant: ['tabular-nums'] }}>
        {text}
      </Text>
      <View
        style={{
          height: 8,
          borderRadius: th.radius.pill,
          backgroundColor: th.colors.surfaceRaised,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: th.colors.borderStrong,
          overflow: 'hidden',
        }}
      >
        <View style={{ width: `${fraction * 100}%`, height: '100%', backgroundColor: th.colors.accent }} />
      </View>
    </View>
  );
}

/**
 * One challenge on a list: its name, what it asks, and one printed line (the points, its progress,
 * or how it finished), with an optional stamp — "Suggested for you", "Running". The stamp is a
 * word, never a colour alone, and it leads the row's spoken label.
 */
export function ChallengeRow({
  name,
  sentence,
  line,
  stamp,
  onPress,
  testID,
}: {
  name: string;
  sentence: string;
  line: string;
  stamp?: string;
  onPress: () => void;
  testID?: string;
}) {
  const th = useTheme();
  const spoken = [stamp, name, sentence, line].filter(Boolean).join(', ');
  return (
    <ListRow
      title={name}
      subtitle={sentence}
      onPress={onPress}
      accessibilityLabel={spoken}
      testID={testID}
      detail={
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: th.space.sm, paddingTop: 2 }}>
          <Text variant="footnote" style={{ fontVariant: ['tabular-nums'] }}>
            {line}
          </Text>
          {stamp ? (
            <Text
              variant="caption"
              style={{
                color: th.colors.stamp,
                borderWidth: 1,
                borderColor: th.colors.stamp,
                borderRadius: th.radius.sm,
                paddingHorizontal: th.space.xs + 2,
                paddingVertical: 1,
                textTransform: 'uppercase',
                letterSpacing: 1,
              }}
            >
              {stamp}
            </Text>
          ) : null}
        </View>
      }
    />
  );
}
