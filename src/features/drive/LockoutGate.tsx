import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { usePathname, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

import { useDrive } from '@/drive/useDrive';

import { DRIVE_HREF, DRIVE_SCREEN } from './hudCopy';
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
 * - brings the driving screen back if another route is on top of it while a drive records: while
 *   the car moves (`lockedOut`; a notification tap mid-drive), and each time RoadWise comes to the
 *   front (opened any way during a drive: the Live Activity, the recap, the app icon). Nothing but
 *   End, "Not driving?", the navigation button (under 35 mph; with its list of apps, part of the
 *   driving screen) and the weather banner's ✕ takes a touch while moving.
 *
 * It never brings RoadWise to the foreground: it acts only on what is already shown.
 */
export function LockoutGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { recording, lockedOut, waiting } = useDrive((s) => ({
    recording: s.status === 'recording',
    lockedOut: s.status === 'recording' && s.lockedOut,
    waiting: s.waiting !== null,
  }));
  const onDriveScreen = pathname === DRIVE_SCREEN;
  const active = useAppActive();

  useEffect(() => {
    if (lockedOut && !onDriveScreen) router.dismissTo(DRIVE_HREF);
  }, [lockedOut, onDriveScreen, router]);

  // RoadWise just came to the front during a drive: the driving screen, whatever was showing.
  const wasActive = useRef(active);
  useEffect(() => {
    const justBecameActive = active && !wasActive.current;
    wasActive.current = active;
    if (justBecameActive && recording && !onDriveScreen) router.dismissTo(DRIVE_HREF);
  }, [active, recording, onDriveScreen, router]);

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
