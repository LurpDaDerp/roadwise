import type { Ionicons } from '@expo/vector-icons';
import { ACHIEVEMENTS, type Achievement, type AchievementId } from '@scoring';

import { profileCopy } from './copy';

export const ACHIEVEMENT_ICON: Record<AchievementId, keyof typeof Ionicons.glyphMap> = {
  first_drive: 'car-sport',
  clean_100: 'sparkles',
  perfect_week: 'calendar',
  better_speed: 'speedometer',
  better_braking: 'stop-circle',
  better_acceleration: 'leaf',
  better_turning: 'return-up-forward',
  better_phone: 'phone-portrait',
  better_attention: 'eye',
  spot_cleared: 'checkmark-done-circle',
};

export interface AchievementView extends Achievement {
  unlocked: boolean;
  hint: string;
}

/** Every badge, in the spec's order, with what this driver has and how to get the rest. */
export function achievementViews(unlocked: readonly string[]): AchievementView[] {
  const hints = profileCopy.achievementHints;
  return ACHIEVEMENTS.map((a) => {
    const got = unlocked.includes(a.id);
    return { ...a, unlocked: got, hint: got ? a.description : hints[a.id] };
  });
}

/** Profile's card shows this many badges (two rows of three); the Achievements screen shows them all. */
export const PROFILE_BADGES = 6;

/** The badges a row shows: unlocked ones first (each group in the spec's order), then at most `limit` of them. */
export function badgeOrder(unlocked: readonly string[], limit?: number): Achievement[] {
  const got = ACHIEVEMENTS.filter((a) => unlocked.includes(a.id));
  const rest = ACHIEVEMENTS.filter((a) => !unlocked.includes(a.id));
  const all = [...got, ...rest];
  return limit === undefined ? all : all.slice(0, limit);
}
