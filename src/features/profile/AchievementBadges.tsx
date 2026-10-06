import { Ionicons } from '@expo/vector-icons';
import { ACHIEVEMENTS, type AchievementId } from '@scoring';
import { View } from 'react-native';

import { Text, useFontScale, useTheme } from '@/ui';

import { ACHIEVEMENT_ICON } from './achievements';
import { profileCopy } from './copy';

/**
 * One achievement as a medal: gold with its glyph when unlocked, an outline with a lock when not.
 * The state is in the glyph and the label as well as the colour.
 */
export function AchievementMedal({ id, unlocked, size = 52 }: { id: AchievementId; unlocked: boolean; size?: number }) {
  const th = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: unlocked ? th.colors.primary : th.colors.surfaceRaised,
        borderWidth: unlocked ? 0 : 2,
        borderColor: th.colors.border,
        borderStyle: unlocked ? 'solid' : 'dashed',
      }}
    >
      <Ionicons
        name={unlocked ? ACHIEVEMENT_ICON[id] : 'lock-closed'}
        size={Math.round(size * 0.46)}
        color={unlocked ? th.colors.onPrimary : th.colors.textSubtle}
      />
    </View>
  );
}

/** The five medals in a row, each named under it. */
export function AchievementBadges({ unlocked, testID }: { unlocked: readonly string[]; testID?: string }) {
  const th = useTheme();
  const scale = useFontScale();
  const stacked = scale > 1.35;
  return (
    <View
      testID={testID}
      style={{ flexDirection: 'row', flexWrap: stacked ? 'wrap' : 'nowrap', justifyContent: 'space-between', rowGap: th.space.md }}
    >
      {ACHIEVEMENTS.map((a) => {
        const got = unlocked.includes(a.id);
        return (
          <View
            key={a.id}
            accessible
            accessibilityLabel={`${a.title}, ${got ? profileCopy.achievements.unlocked : profileCopy.achievements.locked}`}
            testID={`achievement-${a.id}-${got ? 'unlocked' : 'locked'}`}
            style={{ alignItems: 'center', gap: th.space.xs, width: stacked ? '33%' : '19%' }}
          >
            <AchievementMedal id={a.id} unlocked={got} />
            <Text variant="caption" tone={got ? 'default' : 'muted'} numberOfLines={2} style={{ textAlign: 'center' }}>
              {a.title}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
