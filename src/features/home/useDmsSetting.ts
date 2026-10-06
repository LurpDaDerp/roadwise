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
import { enableStep, type EnableStep } from '@/features/camera/dmsSettings';
import { cameraBridge } from '@/features/camera/runtime';

export const DMS_ENABLED_KEY = 'dms.enabled';
export const DMS_CALIBRATED_KEY = 'dms.calibratedAt';
const QUERY_KEY = ['settings', 'dms-chip'] as const;

export interface DmsSetting {
  enabled: boolean;
  calibrated: boolean;
}

/**
 * Turning DMS on asks for the camera permission first (WP8's `enableStep`, the same path as the settings switch), so a
 * permission revoked after setup is noticed here rather than at the drive: the chip then stays off and the caller
 * sends the driver to the DMS settings, which explain. Off is written at once.
 */
export function useDmsSetting(): { setting: DmsSetting; setEnabled: (on: boolean) => Promise<EnableStep | 'disabled'> } {
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
      if (!on) {
        await mutation.mutateAsync(false);
        return 'disabled';
      }
      const permission = (await cameraBridge()?.requestPermission()) ?? 'unavailable';
      const step = enableStep(permission, query.data?.calibrated ?? false);
      if (step === 'enabled') await mutation.mutateAsync(true);
      return step;
    },
  };
}
