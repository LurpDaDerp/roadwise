import { useLocalSearchParams } from 'expo-router';

import { SetupScreen } from '@/dashcam/ui/SetupScreen';

/** `/settings/dashcam-setup[?found=<peripheral>]`: find, identify, pair and save a DashPal. */
export default function DashcamSetupRoute() {
  const { found } = useLocalSearchParams<{ found?: string | string[] }>();
  return <SetupScreen found={typeof found === 'string' && found.length > 0 ? found : undefined} />;
}
