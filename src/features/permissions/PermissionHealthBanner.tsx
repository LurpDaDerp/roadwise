import { useRouter, type Href } from 'expo-router';
import { Pressable } from 'react-native';

import type { HealthContext, HealthReport, PermissionSnapshot } from '@/core/permissions';
import { Banner, type BannerTone } from '@/ui';

import { permissionsCopy } from './copy';
import { usePermissionHealth, type PermissionHealthDeps } from './usePermissionHealth';

const copy = permissionsCopy.banner;

/** B2. Also where the permission-lapse push lands. Cast: typed routes are generated at `expo start`. */
export const PERMISSIONS_HREF = '/permissions' as Href;

/**
 * The banner's words for what the model flagged (`report.showBanner`), most serious first, each
 * naming the true cause: no location stops every drive; approximate location or a lost Always
 * limits what is recorded; lost motion stops drives ending on their own (and, for a driver who
 * wants auto-record, starting on their own — Ruling T8 r1 (3)). Null when there is no banner.
 */
export function bannerMessage(
  snapshot: PermissionSnapshot,
  report: HealthReport,
  context: HealthContext
): { message: string; tone: BannerTone } | null {
  if (!report.showBanner) return null;
  if (snapshot.location === 'denied') return { message: copy.recordingOff, tone: 'danger' };
  const alwaysLapsed = report.rows.some(
    (r) => r.id === 'locationAlways' && r.status === 'attention' && r.reason === 'lapsed'
  );
  if (snapshot.precise === false || alwaysLapsed) return { message: copy.locationLimited, tone: 'warning' };
  const autoRecordWanted =
    context.autoDetectAvailable !== false && context.autoDetectOn && !context.manualByChoice;
  return { message: autoRecordWanted ? copy.motionAuto : copy.motionManual, tone: 'warning' };
}

/**
 * Home's calm, persistent "Fix it" banner (product §7.B rule 6). It renders only when the health
 * model raises one (rev1: I12): never for a deliberate manual choice, a withdrawn feature, an
 * iPhone before its first drive, a non-driver, or while the phone cannot be read. Tapping it
 * opens B2.
 */
export function PermissionHealthBanner({ deps }: { deps?: PermissionHealthDeps }) {
  const router = useRouter();
  const health = usePermissionHealth(deps);
  if (health.status !== 'ready') return null;
  const shown = bannerMessage(health.snapshot, health.report, health.context);
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
