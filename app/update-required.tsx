import { Platform } from 'react-native';

import { useAppConfig } from '@/data/config/appConfig';
import { UpdateRequiredScreen } from '@/features/auth/UpdateRequiredScreen';

/**
 * The forced-update route. The gate sends a driver here only for a known, required update, and
 * never during a drive; it moves them on again once the update no longer applies. The store link
 * is this platform's `store_urls` entry (already schema-checked by the config reader); absent, the
 * screen says where the update comes from instead.
 */
export default function UpdateRequiredRoute() {
  const { config } = useAppConfig();
  const url = Platform.OS === 'ios' ? config.store_urls.ios : config.store_urls.android;
  return <UpdateRequiredScreen storeUrl={url ?? null} />;
}
