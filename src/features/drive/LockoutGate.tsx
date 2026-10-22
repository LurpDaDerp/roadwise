import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { usePathname, useRouter, useSegments } from 'expo-router';
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, BackHandler } from 'react-native';

import { useDrive } from '@/drive/useDrive';
import { HOME_HREF } from '@/features/drives/routes';

import { DRIVE_HREF, DRIVE_SCREEN } from './hudCopy';
import { driveScreenEnteredFor, subscribeDriveScreen } from './hudPresence';
import { useAppActive } from './useHaloBurst';

/** The keep-awake tag held while a drive records (or a Start drive swipe waits for the car). */
export const KEEP_AWAKE_TAG = 'roadwise-drive';

/**
 * The drive's hold on the app, wrapped around the root `Stack`. It renders its children unchanged
 * and:
 * - keeps the screen awake while a drive records, or a Start drive swipe waits for the car to move,
 *   whatever route shows;
 * - swallows Android back on the driving screen while a drive records, so a drive is left only
 *   through End or "Not driving?";
 * - holds the app on the driving screen once the drive owns it: a manual drive (the Start drive
 *   swipe) from its start, an automatic one once the driving screen has been shown during it (the
 *   Live Activity or Dynamic Island, Home's Drive in progress strip, a recording or phone-pickup
 *   notification). Then another route on top goes back to the driving screen while the car moves
 *   (`lockedOut`; a notification tap mid-drive), and each time RoadWise comes to the front. Nothing
 *   but End, "Not driving?", the navigation button (under 35 mph; with its list of apps, part of
 *   the driving screen) and the weather banner's ✕ takes a touch while moving;
 * - leaves an automatic drive whose driving screen has not been shown to the driver: RoadWise
 *   opens on Home, where the Drive in progress strip leads to the driving screen. A screen of the
 *   app left open when RoadWise went behind during such a drive (or that was open when the drive
 *   started behind) gives way to Home there and then, while nobody sees it, so the app icon opens
 *   Home. Nothing is moved on the way back to the front: the Live Activity's own link
 *   (`roadwise://drive`) opens the driving screen by itself, and racing it could close it again.
 *
 * It never brings RoadWise to the foreground: it acts only on what is already shown.
 */
export function LockoutGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const where = useSegments().join('/');
  const { recording, lockedOut, waiting, origin, tripId } = useDrive((s) => ({
    recording: s.status === 'recording',
    lockedOut: s.status === 'recording' && s.lockedOut,
    waiting: s.waiting !== null,
    origin: s.status === 'recording' ? s.origin : null,
    tripId: s.status === 'recording' ? s.clientTripId : null,
  }));
  const entered = useSyncExternalStore(subscribeDriveScreen, () => driveScreenEnteredFor(tripId));
  // Only a drive known to have started on its own waits for the driver to open its screen.
  const automatic = origin === 'auto';
  const held = recording && (!automatic || entered);
  const onDriveScreen = pathname === DRIVE_SCREEN;
  const active = useAppActive();
  const behind = useAppBehind();

  useEffect(() => {
    if (lockedOut && held && !onDriveScreen) router.dismissTo(DRIVE_HREF);
  }, [lockedOut, held, onDriveScreen, router]);

  // RoadWise just came to the front during a drive that owns it: the driving screen, whatever was showing.
  const wasActive = useRef(active);
  useEffect(() => {
    const justBecameActive = active && !wasActive.current;
    wasActive.current = active;
    if (justBecameActive && held && !onDriveScreen) router.dismissTo(DRIVE_HREF);
  }, [active, held, onDriveScreen, router]);

  // An automatic drive nobody has opened the driving screen of, with RoadWise behind: Home, so the
  // app opens there with its Drive in progress strip. Only the app's own screens give way (never
  // sign-in, onboarding, the update screen or the launch router).
  const toHome = recording && automatic && !entered && behind && !onDriveScreen;
  useEffect(() => {
    if (!toHome) return;
    const [group, screen] = where.split('/');
    // A tab: the tabs navigator jumps to Home (it has no dismiss).
    if (group === '(tabs)' && screen !== 'home') router.navigate(HOME_HREF);
    // A screen over the tabs: back down to them, on Home (a second copy of the tabs never stacks).
    else if (group === '(app)') router.dismissTo(HOME_HREF);
  }, [toHome, where, router]);

  const awake = recording || waiting;
  useEffect(() => {
    if (!awake) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [awake]);

  const blockBack = recording && onDriveScreen;
  useEffect(() => {
    if (!blockBack) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [blockBack]);

  return <>{children}</>;
}

/** RoadWise is in the background (AppState `background`; `inactive`, such as Control Center over it, is not), live. */
function useAppBehind(): boolean {
  const [behind, setBehind] = useState(() => AppState.currentState === 'background');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setBehind(next === 'background'));
    return () => sub.remove();
  }, []);
  return behind;
}
