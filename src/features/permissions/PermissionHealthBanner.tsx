import { useRouter, type Href } from 'expo-router';
import { Pressable } from 'react-native';

import type { PermissionSnapshot } from '@/core/permissions';
import { Banner, type BannerTone } from '@/ui';

import { permissionsCopy } from './copy';
import { usePermissionHealth, type PermissionHealthDeps } from './usePermissionHealth';

const copy = permissionsCopy.banner;

export const PERMISSIONS_HREF = '/settings/permissions' as Href;

/** The banner for a reading, or null: only for what stops or spoils a drive. */
export function bannerMessage(s: PermissionSnapshot): { message: string; tone: BannerTone } | null {
  if (s.location === 'denied') return { message: copy.locationOff, tone: 'danger' };
  if ((s.location === 'foreground' || s.location === 'always') && s.precise === false) {
    return { message: copy.approximate, tone: 'warning' };
  }
  return null;
}

/** A calm "fix it" banner for Home; tapping it opens the permission screen. */
export function PermissionHealthBanner({ deps }: { deps?: PermissionHealthDeps }) {
  const router = useRouter();
  const health = usePermissionHealth(deps);
  if (health.status !== 'ready') return null;
  const shown = bannerMessage(health.snapshot);
  if (shown === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={shown.message}
      accessibilityHint={copy.hint}
      onPress={() => router.push(PERMISSIONS_HREF)}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
      testID="banner-permission-health"
    >
      <Banner tone={shown.tone} message={shown.message} />
    </Pressable>
  );
}
