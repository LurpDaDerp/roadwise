import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { Card, Text, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import { timeComment, type DriveGrid } from './model';

/**
 * Under When you drive: a short, friendly line about when the drives start, all time
 * (`timeComment`, with the share of all the miles after dark). It is a comment, not a score: time
 * of day never costs points or moves the rating. Nothing shows with no drives (the grid already
 * says so).
 */
export function TimeOfDayCard({ grid, nightPct }: { grid: DriveGrid; nightPct: number | null }) {
  const t = useTheme();
  const comment = timeComment(grid, nightPct);
  if (comment === null) return null;
  return (
    <Card testID="analytics-time-of-day">
      <View accessible accessibilityLabel={`${analyticsCopy.timeOfDay.title}. ${comment.text}`} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <Ionicons name="partly-sunny-outline" size={t.size.iconLg} color={t.colors.textMuted} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline">{analyticsCopy.timeOfDay.title}</Text>
          <Text variant="subhead" tone="muted" testID="analytics-time-of-day-text">
            {comment.text}
          </Text>
        </View>
      </View>
    </Card>
  );
}
