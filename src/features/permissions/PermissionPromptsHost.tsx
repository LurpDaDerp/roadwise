import { useRouter, useSegments, type Href } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';

import {
  ALWAYS_OFFER_KEY,
  canPrompt,
  MANUAL_BY_CHOICE_KEY,
  offerPrompt,
  readPromptHistory,
  type LocationAccess,
  type PermissionPlatform,
  type PermissionsAdapter,
} from '@/core/permissions';
import { useAppConfig, type UseAppConfigDeps } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db';
import { useDb, useTrips } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { useDrive } from '@/drive/useDrive';

import { completedDrives, defaultPermissionsAdapter } from './usePermissionHealth';

/** The two one-shot upgrade offers. After both, B2 is the only place background location is raised. */
export type AlwaysOffer = 'first-drive' | 'third-drive';

/** `ALWAYS_OFFER_KEY`: when each offer was made (epoch ms). */
export type AlwaysOffers = Partial<Record<AlwaysOffer, number>>;

export interface OfferInput {
  platform: PermissionPlatform;
  /** A driver's account; a non-driver is never offered anything. */
  driver: boolean;
  /** The server makes auto-record available (`auto_detect`). */
  autoDetectAvailable: boolean;
  completedDrives: number;
  offers: AlwaysOffers;
  manualByChoice: boolean;
  /** The 14-day window allows an app-started background-location prompt. */
  canPromptAlways: boolean;
  /** Null until the phone has been read. */
  location: LocationAccess | null;
}

/**
 * Which offer is due, if any. iOS: once after the first completed drive (design §5.3). Both
 * platforms: once more after the third drive. Only while location is While Using, never for a
 * driver who chose manual, never inside the 14-day window, never for a non-driver, and never for a
 * feature the server has switched off. Busy and route checks are the host's.
 */
export function offerDue(i: OfferInput): AlwaysOffer | null {
  if (!i.driver || !i.autoDetectAvailable || i.manualByChoice || !i.canPromptAlways) return null;
  if (i.location !== null && i.location !== 'foreground') return null;
  if (i.platform === 'ios' && i.completedDrives >= 1 && i.offers['first-drive'] === undefined) return 'first-drive';
  if (i.completedDrives >= 3 && i.offers['third-drive'] === undefined) return 'third-drive';
  return null;
}

/**
 * Nothing can ever be due again (review m5, n1): every offer this platform makes is stamped (iOS:
 * both; Android: the third-drive offer, its only one), or the driver chose manual — which only a
 * grant clears, and a grant leaves nothing to offer.
 */
export function offersFinished(
  platform: PermissionPlatform,
  offers: AlwaysOffers,
  manualByChoice: boolean
): boolean {
  if (manualByChoice) return true;
  const third = offers['third-drive'] !== undefined;
  return platform === 'ios' ? third && offers['first-drive'] !== undefined : third;
}

export const offerHref = (offer: AlwaysOffer): Href =>
  `/permissions/background?reason=${offer}` as Href;

export interface PermissionPromptsHostDeps {
  adapter?: PermissionsAdapter;
  platform?: PermissionPlatform;
  now?: () => number;
  appConfig?: UseAppConfigDeps;
}

/**
 * Makes the one-shot post-drive offers to allow background location (the upgrade from manual
 * drives to auto-record). Mounted once in the root layout inside `DriveProvider`. It acts only
 * when something it depends on changes — the drive count, the route, the host going idle — never
 * on a timer, and it reads the phone only once an offer is otherwise due. Never while the host is
 * busy, never outside `(tabs)`. The offer is an app-started prompt, so it goes through
 * `offerPrompt` (the 14-day window); it opens the disclosure, never the OS prompt itself.
 */
export function PermissionPromptsHost({
  isBusy,
  segments,
  deps = {},
}: {
  isBusy: () => boolean;
  segments?: readonly string[];
  deps?: PermissionPromptsHostDeps;
}) {
  const router = useRouter();
  const routeSegments = useSegments();
  const where = segments ?? routeSegments;
  const inTabs = where[0] === '(tabs)';
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const { profile } = useSession();
  const { config } = useAppConfig(deps.appConfig);
  const trips = useTrips();
  // Re-evaluated when the engine changes state, so an offer waits for the drive to finish.
  const status = useDrive((s) => s.status);
  const adapter = deps.adapter ?? defaultPermissionsAdapter();
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android');
  const inFlight = useRef(false);
  // Nothing is ever due again (`offersFinished`): the host stops reading settings (review m5, n1).
  const finished = useRef(false);
  // The route as it is when the phone read comes back: the driver may have left (tabs) meanwhile.
  const inTabsNow = useRef(inTabs);

  const drives = trips.data ? completedDrives(trips.data) : null;
  const driver = profile !== null && profile.driving_stage !== 'non_driver';
  const available = config.flags.auto_detect;

  useEffect(() => {
    inTabsNow.current = inTabs;
  }, [inTabs]);

  useEffect(() => {
    if (finished.current || inFlight.current || drives === null || drives < 1 || !driver || !available || !inTabs) return;
    if (isBusy()) return;
    inFlight.current = true;
    void (async () => {
      try {
        const base = {
          platform,
          driver,
          autoDetectAvailable: available,
          completedDrives: drives,
          offers: (await settings.get<AlwaysOffers>(ALWAYS_OFFER_KEY)) ?? {},
        };
        const manualByChoice = (await settings.get<boolean>(MANUAL_BY_CHOICE_KEY)) === true;
        if (offersFinished(platform, base.offers, manualByChoice)) {
          finished.current = true;
          return;
        }
        const more = {
          manualByChoice,
          canPromptAlways: canPrompt('locationAlways', await readPromptHistory(settings), now()),
        };
        const input = { ...base, ...more };
        // Cheap checks first: nothing native is read unless an offer could be due.
        if (offerDue({ ...input, location: null }) === null) return;
        const snapshot = await adapter.snapshot();
        const due = offerDue({ ...input, location: snapshot.location });
        if (due === null || isBusy() || !inTabsNow.current) return;
        await offerPrompt(settings, 'locationAlways', now(), async () => {
          await settings.set(ALWAYS_OFFER_KEY, { ...base.offers, [due]: now() });
          router.push(offerHref(due));
        });
      } catch {
        // A phone that cannot be read is not offered anything; the next change tries again.
      } finally {
        inFlight.current = false;
      }
    })();
  }, [drives, driver, available, inTabs, status, isBusy, settings, adapter, now, platform, router]);

  return null;
}
