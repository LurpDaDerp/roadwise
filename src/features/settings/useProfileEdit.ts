/**
 * `update_profile` for one field at a time, shown as made while it saves: the screen reads
 * `value(field, serverValue)`, which is the value being saved until the summary refetches, and
 * falls back to the server's on a failure.
 */
import { useCallback, useState } from 'react';

import type { HeatmapVisibility, LicenseStage } from '@/data/server/summary';
import { useServerAction } from '@/features/social/api';

export interface ProfileFields {
  license_stage: LicenseStage;
  units: 'mi' | 'km';
  /** Two-letter code, or '' to clear. */
  state: string;
  heatmap_visibility: HeatmapVisibility;
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
