import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { LEVEL_ICON, LEVEL_LABEL, LEVEL_TONE, type Coaching, type Level } from '@/features/analytics/model';
import { Card, Text, useTheme } from '@/ui';

/** The round icon at the left of an action card. */
function IconDisc({ name, color, background }: { name: keyof typeof Ionicons.glyphMap; color: string; background: string }) {
  const t = useTheme();
  return (
    <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: background }}>
      <Ionicons name={name} size={t.size.iconLg} color={color} accessible={false} />
    </View>
  );
}

const FAINT: Record<Level, 'successFaint' | 'warningFaint' | 'dangerFaint'> = { good: 'successFaint', fair: 'warningFaint', poor: 'dangerFaint' };

/**
 * The coaching tip: the 90-day level's icon at the left, the weakest area's title and one line of
 * advice. Only for a Fair or Poor level; one tap opens Analytics.
 */
export function CoachTipCard({ coaching, onOpen }: { coaching: Coaching & { level: Level }; onOpen: () => void }) {
  const t = useTheme();
  const { level } = coaching;
  return (
    <Card
      onPress={onOpen}
      accessibilityLabel={`${LEVEL_LABEL[level]}. ${coaching.title}. ${coaching.tip}`}
      accessibilityHint="Opens Analytics"
      testID="home-tip"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <View testID={`home-tip-${level}`}>
          <IconDisc name={LEVEL_ICON[level]} color={t.colors[LEVEL_TONE[level]]} background={t.colors[FAINT[level]]} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline">{coaching.title}</Text>
          <Text variant="subhead" tone="muted">
            {coaching.tip}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={t.size.icon} color={t.colors.textSubtle} accessible={false} />
      </View>
    </Card>
  );
}
