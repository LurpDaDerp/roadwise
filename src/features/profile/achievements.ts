import type { Ionicons } from '@expo/vector-icons';
import { ACHIEVEMENTS, type Achievement, type AchievementId } from '@scoring';

import { profileCopy } from './copy';

export const ACHIEVEMENT_ICON: Record<AchievementId, keyof typeof Ionicons.glyphMap> = {
  first_drive: 'car-sport',
  clean_100: 'sparkles',
  perfect_week: 'calendar',
};

export interface AchievementView extends Achievement {
  unlocked: boolean;
  hint: string;
}

/** The three badges, in the spec's order, with what this driver has and how to get the rest. */
export function achievementViews(unlocked: readonly string[]): AchievementView[] {
  const hints = profileCopy.achievementHints;
  return ACHIEVEMENTS.map((a) => {
    const got = unlocked.includes(a.id);
    return { ...a, unlocked: got, hint: got ? a.description : hints[a.id] };
  });
}
