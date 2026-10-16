import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { usePathname, useRouter } from 'expo-router';
import { type ReactNode, useEffect } from 'react';
import { BackHandler } from 'react-native';

import { useDrive } from '@/drive/useDrive';

import { DRIVE_HREF, DRIVE_SCREEN } from './hudCopy';

/** The keep-awake tag held while a drive records. */
export const KEEP_AWAKE_TAG = 'roadwise-drive';

/**
 * The drive's hold on the app, wrapped around the root `Stack`. It renders its children unchanged
 * and, while a drive records:
 * - keeps the screen awake, whatever route shows;
 * - swallows Android back on the driving screen, so a drive is left only through hold-to-end;
 * - while the car moves (`lockedOut`), brings the driving screen back if another route is on top
 *   of it (a notification tap mid-drive): nothing but End and the navigation button (with its list
 *   of apps, part of the driving screen) takes a touch while moving.
 *
 * It never brings RoadWise to the foreground: it acts only on what is already shown.
 */
export function LockoutGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { recording, lockedOut } = useDrive((s) => ({
    recording: s.status === 'recording',
    lockedOut: s.status === 'recording' && s.lockedOut,
  }));
  const onDriveScreen = pathname === DRIVE_SCREEN;

  useEffect(() => {
    if (lockedOut && !onDriveScreen) router.dismissTo(DRIVE_HREF);
  }, [lockedOut, onDriveScreen, router]);

  useEffect(() => {
    if (!recording) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [recording]);

  const blockBack = recording && onDriveScreen;
  useEffect(() => {
    if (!blockBack) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [blockBack]);

  return <>{children}</>;
}
