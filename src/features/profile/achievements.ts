import type { Ionicons } from '@expo/vector-icons';
import { ACHIEVEMENTS, type Achievement, type AchievementId } from '@scoring';

import { profileCopy } from './copy';

export const ACHIEVEMENT_ICON: Record<AchievementId, keyof typeof Ionicons.glyphMap> = {
  first_drive: 'car-sport',
  clean_100: 'sparkles',
  perfect_week: 'calendar',
  phone_free_25: 'phone-portrait',
  streak_10: 'flame',
};

export interface AchievementView extends Achievement {
  unlocked: boolean;
  hint: string;
  /** 0–1 where the summary can say how far along it is. */
  progress: number | null;
}

/** The five, in the spec's order, with what this driver has and how close they are to the rest. */
export function achievementViews(
  unlocked: readonly string[],
  progress: { streak: number; phone_free_run: number } | null
): AchievementView[] {
  const hints = profileCopy.achievementHints;
  return ACHIEVEMENTS.map((a) => {
    const got = unlocked.includes(a.id);
    let hint: string;
    let p: number | null = null;
    switch (a.id) {
      case 'phone_free_25': {
        const run = progress?.phone_free_run ?? 0;
        hint = hints.phone_free_25(Math.min(run, 25));
        p = Math.min(1, run / 25);
        break;
      }
      case 'streak_10': {
        const streak = progress?.streak ?? 0;
        hint = hints.streak_10(streak);
        p = Math.min(1, streak / 10);
        break;
      }
      default:
        hint = hints[a.id];
    }
    return { ...a, unlocked: got, hint: got ? a.description : hint, progress: got ? 1 : p };
  });
}
