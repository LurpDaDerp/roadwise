import { useLocalSearchParams } from 'expo-router';

import { PlaceScreen } from '@/features/family';

/** `/family/place` (add) and `/family/place?id=<id>` (edit) — a family place. */
export default function FamilyPlaceRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <PlaceScreen id={typeof id === 'string' && id !== '' ? id : undefined} />;
}
