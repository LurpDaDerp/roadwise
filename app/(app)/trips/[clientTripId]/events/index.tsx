import { useLocalSearchParams } from 'expo-router';

import { EventListScreen } from '@/features/trips';

/** D3 list — `/(app)/trips/<clientTripId>/events`, where "Something wrong?" lands. */
export default function TripEventsRoute() {
  const { clientTripId } = useLocalSearchParams<{ clientTripId: string }>();
  return <EventListScreen clientTripId={clientTripId ?? ''} />;
}
