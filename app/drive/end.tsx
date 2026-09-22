import { useLocalSearchParams } from 'expo-router';

import { EndScreen } from '@/features/drive/EndScreen';

/**
 * C8 — `/drive/end`. The HUD and the stopped panel route here at `finalizing`; passing the trip's
 * `clientTripId` as a param lets the screen find its own outcome even when the finalize has
 * already answered by the time it mounts.
 */
export default function DriveEndRoute() {
  const { clientTripId } = useLocalSearchParams<{ clientTripId?: string }>();
  return <EndScreen clientTripId={clientTripId || undefined} />;
}
