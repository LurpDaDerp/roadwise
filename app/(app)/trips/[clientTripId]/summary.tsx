import { useLocalSearchParams } from 'expo-router';

import { TripSummaryScreen } from '@/features/trips';

/** D1 — `/(app)/trips/<clientTripId>/summary`, the card back. */
export default function TripSummaryRoute() {
  const { clientTripId } = useLocalSearchParams<{ clientTripId: string }>();
  return <TripSummaryScreen clientTripId={clientTripId ?? ''} />;
}
