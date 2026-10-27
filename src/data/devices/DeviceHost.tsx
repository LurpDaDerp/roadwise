/**
 * Keeps this install registered with the server (`register_device`): on sign-in, on every foreground
 * (throttled), and when the OS issues a new push token or a new Live Activity push-to-start token
 * (iOS 17.2+). Renders nothing; mounted once by the root
 * layout. Runs only while signed in and while this account is the device owner with no handover
 * pending, so nothing is ever registered for one driver from another's phone.
 *
 * Battery: no timer and no polling. The only triggers are the OS saying the app came forward, a
 * screen asking (`requestDeviceSync`) and a new token of either kind.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';

import { LAST_USER_KEY, PENDING_OWNER_KEY } from '@/boot/device';
import { createSettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';
import { useDataSource } from '@/data/queries/context';
import { useSession } from '@/data/supabase/session';

import { onDeviceSyncRequested } from './events';
import { getInstallId } from './installId';
import {
  createExpoPushPort,
  createLiveDriveTokenPort,
  easProjectId,
  pushAllowed,
  readLiveActivityToken,
  readPushToken,
  type LiveActivityTokenPort,
  type PushPort,
} from './pushToken';
import { registerDevice, registeredRecently, type Rpc } from './register';

export interface DeviceHostDeps {
  rpc: Rpc;
  push: PushPort;
  /** The Live Activity push-to-start token (iOS); its token is null elsewhere. */
  liveActivity: LiveActivityTokenPort;
  appState: AppStateLike & { currentState?: string | null };
  platform: 'ios' | 'android' | null;
  projectId: string | null;
  newId?: () => string;
}

export interface DeviceHostProps {
  /** Default true. The host also requires a signed-in account. */
  enabled?: boolean;
  /** Runs last on every foreground sync. */
  onForeground?: (userId: string) => unknown;
  onError?: (error: unknown, context: string) => void;
  /** Test seams; every one defaults to the device's own. */
  deps?: Partial<DeviceHostDeps>;
}

function resolveDeps(p: Partial<DeviceHostDeps> = {}): DeviceHostDeps {
  return {
    rpc:
      p.rpc ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only when mounted for real
      ((require('@/data/server/rpc') as typeof import('@/data/server/rpc')).callRpc as Rpc),
    push: p.push ?? createExpoPushPort(),
    liveActivity: p.liveActivity ?? createLiveDriveTokenPort(),
    appState: p.appState ?? AppState,
    platform: p.platform !== undefined ? p.platform : Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null,
    projectId: p.projectId !== undefined ? p.projectId : easProjectId(),
    newId: p.newId,
  };
}

export function DeviceHost(props: DeviceHostProps): null {
  const { db, now } = useDataSource();
  const { status, session } = useSession();
  const userId = status === 'signedIn' ? (session?.user.id ?? null) : null;
  const enabled = (props.enabled ?? true) && userId !== null;

  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  /** The account whose registration this launch has already forced (once per launch). */
  const forcedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || userId === null) return;
    let live = true;
    const cleanups: (() => void)[] = [];
    const d = resolveDeps(latest.current.deps);
    const settings = createSettingsRepo(db);
    const report = (error: unknown, context: string) => {
      if (live) latest.current.onError?.(error, context);
    };

    const ownerHolds = async (): Promise<boolean> => {
      const owner = await settings.get<string>(LAST_USER_KEY);
      const pending = await settings.get<string>(PENDING_OWNER_KEY);
      return owner === userId && (pending === null || pending === userId);
    };

    let deviceId: string | null = null;
    let running = false;
    let again = false;

    const register = async (force: boolean): Promise<void> => {
      if (!live || d.platform === null) return;
      if (!(await ownerHolds())) return;
      deviceId ??= await getInstallId(settings, d.newId);
      if (!live) return;
      // A local read (no network): a token the last registration did not carry is registered now.
      const liveActivityToken = d.platform === 'ios' ? await readLiveActivityToken(d.liveActivity, (e) => report(e, 'devices live activity token')) : null;
      if (!live) return;
      // Also local: notifications allowed since the last registration (kept on its stamp).
      const canPush = await pushAllowed(d.push);
      if (!live) return;
      if (!force && (await registeredRecently(settings, userId, deviceId, now(), liveActivityToken, canPush))) return;
      if (!live) return;
      const pushToken = await readPushToken(d.push, d.projectId, (e) => report(e, 'devices push token'));
      if (!live) return;
      const result = await registerDevice({ rpc: d.rpc, settings, userId, deviceId, platform: d.platform, pushToken, liveActivityToken, pushAllowed: canPush, now, force, onError: report });
      if (result !== 'error') forcedFor.current = userId;
    };

    const foreground = async (): Promise<void> => {
      if (d.appState.currentState !== 'active') return;
      await register(forcedFor.current !== userId);
      if (!live) return;
      try {
        await latest.current.onForeground?.(userId);
      } catch (error) {
        report(error, 'devices onForeground');
      }
    };

    const run = async (work: () => Promise<void>): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await work();
        } while (again && live);
      } catch (error) {
        report(error, 'devices host');
      } finally {
        running = false;
      }
    };

    cleanups.push(onDeviceSyncRequested(() => void run(() => register(true))));
    const tokenSub = d.push.addPushTokenListener(() => void run(() => register(true)));
    cleanups.push(() => tokenSub.remove());
    const laSub = d.liveActivity.addTokenListener(() => void run(() => register(true)));
    cleanups.push(() => laSub.remove());
    const appSub = d.appState.addEventListener('change', (next) => {
      if (next === 'active') void run(foreground);
    });
    cleanups.push(() => appSub.remove());
    void run(foreground);

    return () => {
      live = false;
      for (const cleanup of cleanups.splice(0)) cleanup();
    };
  }, [enabled, userId, db, now]);

  return null;
}
