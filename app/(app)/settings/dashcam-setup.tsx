import { useLocalSearchParams } from 'expo-router';

import { SetupScreen, setupTargetOf } from '@/dashcam/ui/SetupScreen';

/** `/settings/dashcam-setup[?found=<peripheral>][&again=1]`: set up a DashPal with one tap (Set up again: the paired one). */
export default function DashcamSetupRoute() {
  const params = useLocalSearchParams<{ found?: string | string[]; again?: string | string[] }>();
  return <SetupScreen target={setupTargetOf(params)} />;
}
