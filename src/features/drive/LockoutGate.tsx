import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { usePathname, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useRef } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';

import { useDrive } from '@/drive/useDrive';

import { DRIVE_GROUP_PREFIX, DRIVE_ROUTES, driveHref } from './hudCopy';
import { HudScreen } from './HudScreen';
import { ParkedOnlyCard } from './ParkedOnlyCard';
import { PocketScreen } from './PocketScreen';

/** The keep-awake tag the gate holds for a mounted trip. */
export const KEEP_AWAKE_TAG = 'roadwise-mounted-drive';

const HUD_ROUTE = DRIVE_ROUTES.hud;
const POCKET_ROUTE = DRIVE_ROUTES.pocket;

/** A recorded trip, whatever its screen: rows are being kept (`recording`) or may resume (`ending`). */
const tripRecords = (status: string): boolean => status === 'recording' || status === 'ending';

/**
 * The driving lockout (design §3.4, SR2, SR7, SR8), wrapped around the root `Stack` (H2).
 *
 * It always renders its children. While a driver's trip is locked out (`lockedOut`) and the route is
 * not already a drive screen, it lays the lockout surface over them — `HudScreen` for a mounted trip,
 * `ParkedOnlyCard` for a pocket or auto-detected one — and hides the app below from assistive tech
 * and from touch. On `/drive/hud` or `/drive/pocket` the route already is the lockout surface, so it
 * adds nothing (no second HUD).
 *
 * At the onset it clears what the overlay cannot cover:
 * - **RN Modals** (dispute sheet, delete sheet) close themselves through `useLockout()` (rev1: I12).
 * - **Routed screens above the app** are dismissed with `router.dismissAll()` — but never from a
 *   drive route: the drive group is itself a full-screen modal, and dismissing it would take the HUD
 *   and its stopped panel away mid-drive (review N-I1). The pre-drive sheet (or any other drive
 *   screen) is instead replaced by the trip's own screen.
 *
 * It also owns two things for the whole trip, whatever route shows:
 * - **Keep-awake** while a mounted trip records (rev1: I11), so a HUD route leaving the stack can
 *   never let the screen lock — which the mounted app-switch rule would otherwise have to judge.
 * - **Android back** is swallowed while a trip records (rev1: I11).
 *
 * It never brings RoadWise to the foreground (E1 review M6): it acts only on what is already shown.
 */
export function LockoutGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { lockedOut, mode, status } = useDrive((s) => ({
    lockedOut: s.lockedOut,
    mode: s.mode,
    status: s.status,
  }));

  const onDriveScreen = pathname === HUD_ROUTE || pathname === POCKET_ROUTE;
  const tripRoute: string = mode === 'mounted' ? HUD_ROUTE : POCKET_ROUTE;

  // The onset, once per lockout: the ref makes a later route change (or the dismissal itself)
  // re-run the effect without acting again.
  const wasLocked = useRef(false);
  useEffect(() => {
    const began = lockedOut && !wasLocked.current;
    wasLocked.current = lockedOut;
    if (!began) return;
    if (pathname === HUD_ROUTE || pathname === POCKET_ROUTE) return;
    if (pathname.startsWith(DRIVE_GROUP_PREFIX)) {
      router.replace(driveHref(tripRoute));
      return;
    }
    if (router.canDismiss()) router.dismissAll();
  }, [lockedOut, pathname, tripRoute, router]);

  const keepAwake = mode === 'mounted' && tripRecords(status);
  useEffect(() => {
    if (!keepAwake) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [keepAwake]);

  const blockBack = tripRecords(status);
  useEffect(() => {
    if (!blockBack) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [blockBack]);

  const covered = lockedOut && !onDriveScreen;

  return (
    <View style={styles.root}>
      <View
        testID="lockout-underlay"
        style={styles.root}
        pointerEvents={covered ? 'none' : 'auto'}
        accessibilityElementsHidden={covered}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
      {covered ? (
        <View style={StyleSheet.absoluteFill}>
          {mode === 'mounted' ? <HudScreen overlay /> : <ParkedOnlyCard />}
        </View>
      ) : null}
    </View>
  );
}

/**
 * What the `/drive/hud` route shows (ruling U2 m2, safety). The banner's *Open HUD* may open the
 * HUD on a pocket or auto-detected trip without changing its mode; the moment that trip is locked
 * out (a driver above the lockout speed, SR2) the pocket rule wins and the route shows the pocket
 * screen instead — never the mounted HUD at speed on a trip the engine treats as pocket. Back at a
 * stop the HUD returns. A mounted trip, and a passenger (never locked out), keep the HUD.
 */
export function HudRouteScreen() {
  const pocketAtSpeed = useDrive((s) => s.mode !== 'mounted' && s.lockedOut);
  return pocketAtSpeed ? <PocketScreen /> : <HudScreen />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
