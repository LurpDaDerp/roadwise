import { useLocalSearchParams } from 'expo-router';

import { ChallengeDetailScreen } from '@/features/rewards/challenges/ChallengeDetailScreen';

/** `/rewards/challenges/<def id | enrolment id>` — one challenge: join, progress, leave, or how it finished. */
export default function ChallengeDetailRoute() {
  const { challengeId } = useLocalSearchParams<{ challengeId?: string }>();
  return <ChallengeDetailScreen challengeId={typeof challengeId === 'string' ? challengeId : ''} />;
}
