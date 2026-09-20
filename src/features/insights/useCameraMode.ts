import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';

/**
 * Where camera mode's on/off switch lives (§7.H H5). Nothing writes it yet — the settings screen
 * lands in a later milestone — so today it reads as off everywhere, which is the honest default:
 * camera mode is opt-in (§13) and must never appear to be running unless the driver turned it on.
 */
export const CAMERA_MODE_SETTING_KEY = 'camera.mode';

/**
 * Is camera mode on? Used by E2 to decide whether "Focus and alertness" can have anything to say.
 *
 * Its own query root rather than one of `QUERY_ROOTS`: a device preference is not refreshed by a
 * sync, so sweeping it after one would only throw away a read the driver already paid for. The
 * stored value is compared to `true` rather than cast, because `settings.get` parses JSON written
 * by any past version of the app and casts it blindly.
 */
export function useCameraMode(): UseQueryResult<boolean> {
  const db = useDb();
  return useQuery({
    queryKey: ['settings', CAMERA_MODE_SETTING_KEY] as const,
    queryFn: async () => (await createSettingsRepo(db).get<unknown>(CAMERA_MODE_SETTING_KEY)) === true,
  });
}
