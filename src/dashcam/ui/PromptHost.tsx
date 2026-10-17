import { usePathname } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ALERT_GLOW_MS } from '@/core/alerts/policy';
import type { AppStateLike } from '@/data/foreground';
import { Banner, useTheme } from '@/ui';

import type { DashcamVisual } from '../alerts';
import { dashpalCopy } from '../copy';
import type { DashcamState } from '../runtime';
import { useDashcamRuntime, useDashcamSelector } from './useDashcam';

/** The DashPal alert banner shows this long per alert start or level change (plan §7.8): 1.5 s. */
export const VISUAL_MS = ALERT_GLOW_MS;

const onDriveRoute = (path: string): boolean => path === '/drive' || path.startsWith('/drive/');

const selectVisual = (s: DashcamState | null): DashcamVisual | null => s?.link.visual ?? null;

export interface PromptHostDeps {
  appState?: AppStateLike;
  now?: () => number;
}

/**
 * Mounted once in the root layout (plan §7.8): outside the drive screen it shows a DashPal alert
 * for 1.5 s per start or level change (the HUD shows its own).
 */
export function DashpalPromptHost({ deps = {} }: { deps?: PromptHostDeps }) {
  // Nothing at all (no provider read, no listener) until a runtime with DashPal exists.
  const runtime = useDashcamRuntime();
  return runtime ? <PromptHostInner deps={deps} /> : null;
}

function PromptHostInner({ deps }: { deps: PromptHostDeps }) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname() ?? '';
  const visual = useDashcamSelector(selectVisual);
  const [expiredVisual, setExpiredVisual] = useState<string | null>(null);
  const now = deps.now ?? Date.now;

  // The alert banner: 1.5 s per start or level change (from when the dashcam raised it).
  useEffect(() => {
    if (!visual) return;
    const timer = setTimeout(() => setExpiredVisual(visual.key), Math.max(0, VISUAL_MS - (now() - visual.at)));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visual]);
  const shownVisual = visual && visual.key !== expiredVisual ? visual : null;

  if (onDriveRoute(pathname) || !shownVisual) return null;

  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + th.space.sm, left: th.space.lg, right: th.space.lg, gap: th.space.sm }}>
      <Banner tone={shownVisual.tier >= 3 ? 'danger' : 'warning'} message={`${dashpalCopy.name}: ${dashpalCopy.alert[shownVisual.sound] ?? dashpalCopy.name}`} testID="dashpal-alert-banner" />
    </View>
  );
}
