import { useLocalSearchParams } from 'expo-router';

import { DashcamScreen } from '@/features/settings/DashcamScreen';

/**
 * `/settings/dashcam`: the paired DashPal dashcam, its status and its controls; or how to set one up.
 * `aim=1` (Home's reminder that the camera needs adjusting) opens its camera view at once.
 */
export default function DashcamRoute() {
  const { aim } = useLocalSearchParams<{ aim?: string }>();
  return <DashcamScreen openAim={aim === '1'} />;
}
