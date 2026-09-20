import { useLocalSearchParams } from 'expo-router';

import { TipScreen } from '@/features/trips';

/** D6 — `/(app)/trips/<clientTripId>/tip`, the coaching tip in full. */
export default function TripTipRoute() {
  const { clientTripId } = useLocalSearchParams<{ clientTripId: string }>();
  return <TipScreen clientTripId={clientTripId ?? ''} />;
}
