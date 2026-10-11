import { usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PermissionsAdapter } from '@/core/permissions';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import type { AppStateLike } from '@/data/foreground';
import { isBusyStatus } from '@/drive/policy';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { mpsToMph } from '@/lib/units';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { Banner, Button, Card, Text, useTheme } from '@/ui';

import type { DashcamVisual } from '../alerts';
import { dashpalCopy } from '../copy';
import { createDetector, snoozed, type Detector, type Found } from '../detector';
import { SNOOZES_KEY } from '../keys';
import { PAIRING_SERVICE } from '../protocol';
import type { DashcamRuntime, DashcamState } from '../runtime';
import { PENDING_SETUP_KEY, PENDING_SETUP_MAX_AGE_MS, setupHref } from './links';
import { useDashcamRuntime, useDashcamSelector } from './useDashcam';

/** The DashPal alert banner shows this long per alert start or level change (plan §7.8). */
export const VISUAL_MS = 1500;

const TAB_ROUTES = new Set(['/home', '/leagues', '/clan', '/profile', '/']);
const onDriveRoute = (path: string): boolean => path === '/drive' || path.startsWith('/drive/');


const selectVisual = (s: DashcamState | null): DashcamVisual | null => s?.link.visual ?? null;

export interface PromptHostDeps {
  adapter?: PermissionsAdapter;
  appState?: AppStateLike;
  speedMph?: () => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Mounted once in the root layout (plan §7.9, §7.8): outside the drive screen it
 * - offers a DashPal found nearby in pairing mode (the detector's rules: opted in, Bluetooth already
 *   allowed, never while a drive is open or on the drive route, speed known under 3 mph, ≤ once per
 *   2 min), as a small non-blocking banner, dropped when a drive starts; "Not now" snoozes it 7 days;
 * - replays a `roadwise://dashpal` link that came during a drive, once the drive is over;
 * - shows a DashPal alert for 1.5 s per start or level change (the HUD shows its own).
 */
export function DashpalPromptHost({ deps = {} }: { deps?: PromptHostDeps }) {
  // Nothing at all (no provider read, no listener) until a runtime with DashPal exists.
  const runtime = useDashcamRuntime();
  return runtime ? <PromptHostInner runtime={runtime} deps={deps} /> : null;
}

function PromptHostInner({ runtime, deps }: { runtime: DashcamRuntime; deps: PromptHostDeps }) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const host = useDriveHost();
  const busy = useDrive((s) => isBusyStatus(s.status));
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const visual = useDashcamSelector(selectVisual);
  const [offer, setOffer] = useState<Found | null>(null);
  const [expiredVisual, setExpiredVisual] = useState<string | null>(null);
  const now = deps.now ?? Date.now;
  const setupOpen = pathname.startsWith(String(SETTINGS_HREFS.dashcamSetup));
  const pathRef = useRef(pathname);
  const setupRef = useRef(setupOpen);
  useEffect(() => {
    pathRef.current = pathname;
    setupRef.current = setupOpen;
  });

  const detectorRef = useRef<Detector | null>(null);
  useEffect(() => {
    const adapter = deps.adapter ?? defaultPermissionsAdapter();
    const detector = createDetector({
      now,
      btOptIn: () => runtime.state().btOptIn,
      bluetoothReady: async () => (await adapter.bluetooth()) === 'granted',
      isBusy: () => host.isBusy(),
      onDriveRoute: () => onDriveRoute(pathRef.current),
      speedMph: deps.speedMph ?? defaultSpeedMph,
      setupRunning: () => setupRef.current,
      pairedPeripheralId: () => runtime.state().link.paired?.peripheralId ?? null,
      pairedConnected: () => runtime.state().link.lifecycle === 'connected',
      snoozes: async () => (await settings.get<Record<string, number>>(SNOOZES_KEY)) ?? {},
      scan: async (o) => {
        const t = runtime.transport();
        if (!t) throw new Error('no Bluetooth transport');
        return t.scan({ service: PAIRING_SERVICE, seconds: o.seconds, onHit: o.onHit });
      },
      sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    });
    detectorRef.current = detector;
    return () => {
      void detector.abort();
      if (detectorRef.current === detector) detectorRef.current = null;
    };
    // `now` and the injected deps are fixed for the host's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, host, settings]);

  const check = useCallback(() => {
    const detector = detectorRef.current;
    if (!detector) return;
    void detector.check().then((r) => {
      if (r.kind === 'found' && !host.isBusy()) setOffer(r.found);
    });
  }, [host]);

  // On each return to the foreground, and whenever the route lands on a tab.
  useEffect(() => {
    const appState = deps.appState ?? AppState;
    const sub = appState.addEventListener('change', (s) => {
      if (s === 'active') check();
      else void detectorRef.current?.abort();
    });
    return () => sub.remove();
  }, [check, deps.appState]);
  useEffect(() => {
    if (TAB_ROUTES.has(pathname)) check();
  }, [pathname, check]);

  // A drive starting drops the offer and any scan.
  useEffect(
    () =>
      host.subscribe((s) => {
        if (!isBusyStatus(s.status)) return;
        setOffer(null);
        void detectorRef.current?.abort();
      }),
    [host]
  );

  // A DashPal link that came during a drive, replayed once it is over.
  useEffect(() => {
    if (busy || onDriveRoute(pathname)) return;
    let live = true;
    void (async () => {
      const pending = await settings.get<{ at?: number }>(PENDING_SETUP_KEY).catch(() => null);
      if (!live || !pending) return;
      await settings.remove(PENDING_SETUP_KEY).catch(() => {});
      if (typeof pending.at === 'number' && now() - pending.at <= PENDING_SETUP_MAX_AGE_MS && !host.isBusy()) router.push(setupHref());
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, pathname, settings, router, host]);

  // The alert banner: 1.5 s per start or level change (from when the dashcam raised it).
  useEffect(() => {
    if (!visual) return;
    const timer = setTimeout(() => setExpiredVisual(visual.key), Math.max(0, VISUAL_MS - (now() - visual.at)));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visual]);
  const shownVisual = visual && visual.key !== expiredVisual ? visual : null;

  const notNow = async (f: Found) => {
    setOffer(null);
    const map = (await settings.get<Record<string, number>>(SNOOZES_KEY).catch(() => null)) ?? {};
    await settings.set(SNOOZES_KEY, snoozed(map, f.id, now())).catch(() => {});
  };

  if (onDriveRoute(pathname)) return null;
  const showOffer = offer !== null && !busy && !setupOpen;
  if (!showOffer && !shownVisual) return null;

  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + th.space.sm, left: th.space.lg, right: th.space.lg, gap: th.space.sm }}>
      {shownVisual ? (
        <Banner tone={shownVisual.tier >= 3 ? 'danger' : 'warning'} message={`${dashpalCopy.name}: ${dashpalCopy.alert[shownVisual.sound] ?? dashpalCopy.name}`} testID="dashpal-alert-banner" />
      ) : null}
      {showOffer && offer ? (
        <Card testID="dashpal-offer">
          <Text variant="callout">{dashpalCopy.prompt.found(offer.name)}</Text>
          <View style={{ flexDirection: 'row', gap: th.space.sm, marginTop: th.space.sm }}>
            <Button
              label={dashpalCopy.prompt.connect}
              size="sm"
              onPress={() => {
                setOffer(null);
                router.push(setupHref(offer.id));
              }}
              testID="dashpal-offer-connect"
            />
            <Button label={dashpalCopy.prompt.notNow} size="sm" variant="ghost" onPress={() => void notNow(offer)} testID="dashpal-offer-not-now" />
          </View>
        </Card>
      ) : null}
    </View>
  );
}

async function defaultSpeedMph(): Promise<number | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: expo-location
  const { currentSpeedMps } = require('@/features/drive/movingCheck') as typeof import('@/features/drive/movingCheck');
  const mps = await currentSpeedMps();
  return mps === null ? null : mpsToMph(mps);
}
