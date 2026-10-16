import { useLocalSearchParams } from 'expo-router';

import { setupTargetOf } from '@/dashcam/ui/links';
import { SetupScreen } from '@/dashcam/ui/SetupScreen';

/**
 * `/settings/dashcam-setup[?found=<peripheral>][&link=<dashcam id>][&again=1]`: scan or type a
 * DashPal's pairing code and pair (a link's Pair screen; Set up again with the stored code).
 */
export default function DashcamSetupRoute() {
  const params = useLocalSearchParams<{ found?: string | string[]; link?: string | string[]; again?: string | string[] }>();
  return <SetupScreen target={setupTargetOf(params)} />;
}
