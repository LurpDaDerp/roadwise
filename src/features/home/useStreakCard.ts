import { useCallback, useEffect, useMemo, useState } from 'react';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import type { LocalDrive } from '@/features/drives/model';

import { latestStreakNews, type StreakNews } from './ActionCards';

/** The clientTripId whose streak card the driver put away (settings repo). */
export const STREAK_CARD_DISMISSED_KEY = 'home.streakCard.dismissed';

/**
 * Home's streak card: the latest kept drive's news (streak lost, or a freeze saved it) until the
 * driver dismisses it. The dismissal is stored by drive, so the next drive's news shows again.
 * Nothing shows until the stored dismissal is read, so a dismissed card never flashes back.
 */
export function useStreakCard(drives: readonly LocalDrive[] | undefined): { news: StreakNews | null; dismiss: () => void } {
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  // undefined while the stored dismissal is read.
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    settings
      .get<string>(STREAK_CARD_DISMISSED_KEY)
      .then((v) => {
        if (alive) setDismissed(v ?? null);
      })
      .catch(() => {
        if (alive) setDismissed(null);
      });
    return () => {
      alive = false;
    };
  }, [settings]);

  const latest = useMemo(() => (drives ? latestStreakNews(drives) : null), [drives]);
  const news = latest && dismissed !== undefined && dismissed !== latest.clientTripId ? latest : null;
  const dismiss = useCallback(() => {
    if (!latest) return;
    setDismissed(latest.clientTripId);
    void settings.set(STREAK_CARD_DISMISSED_KEY, latest.clientTripId).catch(() => {});
  }, [latest, settings]);
  return { news, dismiss };
}
