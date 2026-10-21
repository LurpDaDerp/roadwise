/**
 * `update_profile` for one field at a time, shown as made while it saves: the screen reads
 * `value(field, serverValue)`, which is the value being saved until the summary refetches, and
 * falls back to the server's on a failure.
 */
import { useCallback, useState } from 'react';

import type { HeatmapVisibility } from '@/data/server/summary';
import { useServerAction } from '@/features/social/api';

export interface ProfileFields {
  units: 'mi' | 'km';
  heatmap_visibility: HeatmapVisibility;
  /** What friends can see (Settings › Privacy). */
  share_rating: boolean;
  share_categories: boolean;
  share_achievements: boolean;
  share_stats: boolean;
}

export function useProfileEdit() {
  const action = useServerAction();
  const [shown, setShown] = useState<Partial<ProfileFields>>({});

  const save = useCallback(
    async <K extends keyof ProfileFields>(field: K, next: ProfileFields[K]): Promise<boolean> => {
      setShown((s) => ({ ...s, [field]: next }));
      const ok = await action.run('update_profile', { [`p_${field}`]: next });
      if (!ok) {
        setShown((s) => {
          const rest = { ...s };
          delete rest[field];
          return rest;
        });
      }
      return ok;
    },
    [action]
  );

  const value = <K extends keyof ProfileFields>(field: K, server: ProfileFields[K] | null | undefined) =>
    (shown[field] as ProfileFields[K] | undefined) ?? server ?? null;

  return { save, value, saving: action.pending !== null, error: action.error, clearError: action.clearError };
}
