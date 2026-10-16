import { useLocalSearchParams } from 'expo-router';

import { DashpalLink } from '@/dashcam/ui/DashpalLink';

/**
 * `/dashpal[?d=<dashcam id>]` (a DashPal's pairing-code link, its code already moved to SecureStore
 * by `+native-intent`): the Pair screen, or later if a drive is open.
 */
export default function DashpalRoute() {
  const { d } = useLocalSearchParams<{ d?: string | string[] }>();
  return <DashpalLink d={typeof d === 'string' ? d : null} />;
}
