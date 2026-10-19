import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { Card, Text, useTheme } from '@/ui';

import { AXIS_LABEL, LEVEL_ICON, LEVEL_LABEL, LEVEL_TONE, type Coaching } from './model';

/**
 * The 30-day verdict in one line: the level's icon (its colour plus its shape, with the word for a
 * screen reader), a short title and one tip, or a compliment when the driving is good. Under the
 * tip, any other weak areas as small level icons with their axis names; the row wraps at large text.
 */
export function SummaryCard({ coaching }: { coaching: Coaching }) {
  const t = useTheme();
  const { level, also } = coaching;
  const icon = level ? LEVEL_ICON[level] : 'time-outline';
  const color = level ? t.colors[LEVEL_TONE[level]] : t.colors.textMuted;
  const verdict = [level ? LEVEL_LABEL[level] : null, coaching.title, coaching.tip].filter(Boolean).join('. ');
  const spoken = also.length > 0 ? `${verdict} Also watch: ${also.map((a) => `${AXIS_LABEL[a.axis]}, ${LEVEL_LABEL[a.level].toLowerCase()}.`).join(' ')}` : verdict;
  return (
    <Card testID="analytics-summary">
      <View accessible accessibilityLabel={spoken} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <Ionicons name={icon} size={t.size.iconLg} color={color} testID="analytics-summary-icon" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline">{coaching.title}</Text>
          <Text variant="subhead" tone="muted">
            {coaching.tip}
          </Text>
          {also.length > 0 ? (
            <View testID="analytics-summary-also" style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: t.space.md, rowGap: t.space.xs, marginTop: t.space.xs }}>
              {also.map((a) => (
                <View key={a.axis} testID={`analytics-summary-also-${a.axis}`} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs, flexShrink: 1 }}>
                  <Ionicons name={LEVEL_ICON[a.level]} size={t.size.iconSm} color={t.colors[LEVEL_TONE[a.level]]} testID={`analytics-summary-also-${a.axis}-icon`} />
                  <Text variant="footnote" tone="muted" style={{ flexShrink: 1 }}>
                    {AXIS_LABEL[a.axis]}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
