import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { Card, Text, useTheme } from '@/ui';

import { LEVEL_ICON, LEVEL_LABEL, LEVEL_TONE, type Coaching } from './model';

/**
 * The 30-day verdict in one line: the level's icon (its colour plus its shape, with the word for a
 * screen reader), a short title and one tip, or a compliment when the driving is good.
 */
export function SummaryCard({ coaching }: { coaching: Coaching }) {
  const t = useTheme();
  const { level } = coaching;
  const icon = level ? LEVEL_ICON[level] : 'time-outline';
  const color = level ? t.colors[LEVEL_TONE[level]] : t.colors.textMuted;
  const spoken = [level ? LEVEL_LABEL[level] : null, coaching.title, coaching.tip].filter(Boolean).join('. ');
  return (
    <Card testID="analytics-summary">
      <View accessible accessibilityLabel={spoken} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <Ionicons name={icon} size={t.size.iconLg} color={color} testID="analytics-summary-icon" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline">{coaching.title}</Text>
          <Text variant="subhead" tone="muted">
            {coaching.tip}
          </Text>
        </View>
      </View>
    </Card>
  );
}
