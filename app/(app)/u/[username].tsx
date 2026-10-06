import { useLocalSearchParams } from 'expo-router';

import { PublicProfileScreen } from '@/features/profile/PublicProfileScreen';

/** `/u/<username>`: another driver's public profile (also where `roadwise://add/<username>` lands). */
export default function PublicProfileRoute() {
  const { username } = useLocalSearchParams<{ username?: string | string[] }>();
  return <PublicProfileScreen username={typeof username === 'string' ? username : ''} />;
}
