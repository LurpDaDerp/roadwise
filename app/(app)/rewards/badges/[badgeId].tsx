import { useLocalSearchParams } from 'expo-router';

import { BadgeDetailScreen } from '@/features/rewards/badges/BadgeDetailScreen';

/** `/rewards/badges/<id>` — F3, one badge. An id this build doesn't know shows "not in RoadWise". */
export default function BadgeRoute() {
  const { badgeId } = useLocalSearchParams<{ badgeId?: string | string[] }>();
  const id = Array.isArray(badgeId) ? badgeId[0] : badgeId;
  return <BadgeDetailScreen badgeId={id ?? ''} />;
}
