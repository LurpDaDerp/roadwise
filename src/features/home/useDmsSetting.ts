/**
 * The DMS chip's state: `dms.enabled` and whether DMS has ever been calibrated
 * (`dms.calibratedAt`), read from the device settings (plan §10). Re-read whenever Home regains
 * focus, so turning DMS on in its setup screen shows here on the way back.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';

export const DMS_ENABLED_KEY = 'dms.enabled';
export const DMS_CALIBRATED_KEY = 'dms.calibratedAt';
const QUERY_KEY = ['settings', 'dms-chip'] as const;

export interface DmsSetting {
  enabled: boolean;
  calibrated: boolean;
}

export function useDmsSetting(): { setting: DmsSetting; setEnabled: (on: boolean) => Promise<void> } {
  const db = useDb();
  const qc = useQueryClient();
  const query = useQuery<DmsSetting>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const repo = createSettingsRepo(db);
      const values = await repo.getMany([DMS_ENABLED_KEY, DMS_CALIBRATED_KEY]);
      return { enabled: values[DMS_ENABLED_KEY] === true, calibrated: typeof values[DMS_CALIBRATED_KEY] === 'number' };
    },
  });
  const { refetch } = query;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch])
  );
  const mutation = useMutation({
    mutationFn: (on: boolean) => createSettingsRepo(db).set(DMS_ENABLED_KEY, on),
    onMutate: (on) => {
      qc.setQueryData<DmsSetting>(QUERY_KEY, (cur) => ({ calibrated: cur?.calibrated ?? false, enabled: on }));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  return {
    setting: query.data ?? { enabled: false, calibrated: false },
    setEnabled: async (on) => {
      await mutation.mutateAsync(on);
    },
  };
}
