import { useLocalSearchParams } from 'expo-router';

import { EventDetailScreen } from '@/features/trips';

/** D3 — `/(app)/trips/<clientTripId>/events/<eventId>`, one moment and the report form. */
export default function TripEventRoute() {
  const { clientTripId, eventId } = useLocalSearchParams<{
    clientTripId: string;
    eventId: string;
  }>();
  return <EventDetailScreen clientTripId={clientTripId ?? ''} eventId={eventId ?? ''} />;
}
