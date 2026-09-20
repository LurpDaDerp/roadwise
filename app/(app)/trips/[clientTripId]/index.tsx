import { useLocalSearchParams } from 'expo-router';

import { TripDetailScreen } from '@/features/trips';

/** D2 — `/(app)/trips/<clientTripId>`, the whole drive: map and timeline. */
export default function TripDetailRoute() {
  const { clientTripId } = useLocalSearchParams<{ clientTripId: string }>();
  return <TripDetailScreen clientTripId={clientTripId ?? ''} />;
}
