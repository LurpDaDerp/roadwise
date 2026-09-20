import { useLocalSearchParams } from 'expo-router';

import { EditTripScreen } from '@/features/trips';

/** D5 — `/(app)/trips/<clientTripId>/edit`: who was driving, and delete. */
export default function EditTripRoute() {
  const { clientTripId } = useLocalSearchParams<{ clientTripId: string }>();
  return <EditTripScreen clientTripId={clientTripId ?? ''} />;
}
