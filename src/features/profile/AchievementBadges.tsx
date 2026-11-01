import { Ionicons } from '@expo/vector-icons';
import type { AchievementId } from '@scoring';
import { View } from 'react-native';

import { Text, useFontScale, useTheme } from '@/ui';

import { ACHIEVEMENT_ICON, badgeOrder } from './achievements';
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
        backgroundColor: unlocked ? th.colors.gold : th.colors.surfaceRaised,
        borderWidth: unlocked ? 0 : 2,
        borderColor: th.colors.border,
        borderStyle: unlocked ? 'solid' : 'dashed',
      }}
    >
      <Ionicons
        name={unlocked ? ACHIEVEMENT_ICON[id] : 'lock-closed'}
        size={Math.round(size * 0.46)}
        color={unlocked ? th.colors.onGold : th.colors.textSubtle}
      />
    </View>
  );
}

/**
 * The medals, each named under it, three to a row (two with very large text), wrapping onto more
 * rows. Unlocked ones come first; `limit` caps how many show (Profile's card), the rest are on the
 * Achievements screen.
 */
export function AchievementBadges({ unlocked, limit, testID }: { unlocked: readonly string[]; limit?: number; testID?: string }) {
  const th = useTheme();
  const scale = useFontScale();
  const stacked = scale > 1.35;
  return (
    <View testID={testID} style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: th.space.md }}>
      {badgeOrder(unlocked, limit).map((a) => {
        const got = unlocked.includes(a.id);
        return (
          <View
            key={a.id}
            accessible
            accessibilityLabel={`${a.title}, ${got ? profileCopy.achievements.unlocked : profileCopy.achievements.locked}`}
            testID={`achievement-${a.id}-${got ? 'unlocked' : 'locked'}`}
            style={{ alignItems: 'center', gap: th.space.xs, width: stacked ? '50%' : '33.33%', paddingHorizontal: th.space.xs }}
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
