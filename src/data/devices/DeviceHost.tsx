/**
 * Keeps this install's server-side presence current: the `devices` row, the permission report,
 * the push token and the drive state. Renders nothing; mounted once by the root layout (Task 18).
 *
 * Runs only while signed in and onboarded (not under 13, not still in setup), and only while this
 * account is the device owner with no handover pending (M3 H2's owner fence), so nothing is ever
 * written for one driver from another's phone state.
 *
 * - **On mount and on every `AppState → active`:** the throttled upsert, a permission snapshot →
 *   `reportPermissions`, `syncPushToken` (forced on the first successful sync of the launch: T2
 *   security M-3), the drive-state reporter's `retryPending`, then `onForeground?.(userId)`.
 *   A mount in a background launch (an iOS location wake renders the tree) waits for `active`.
 * - **`requestDeviceSync()`** → `syncPushToken`; **a new OS token** → a forced `syncPushToken`.
 * - **`subscribeDrive`** → the drive-state reporter; `useDriveStateReported()` is true while a host
 *   with a source is mounted.
 *
 * Battery (§3.5): no timer and no polling. The only triggers are the OS saying the app came
 * forward, a screen asking, a new token, and the drive's own state changes; each foreground is
 * local reads plus at most the writes something actually changed.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { createPermissionsAdapter, type PermissionsAdapter } from '@/core/permissions';
import { LAST_USER_KEY, PENDING_OWNER_KEY } from '@/boot/device';
import { createSettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';
import { useDataSource } from '@/data/queries/context';
import { useSession } from '@/data/supabase/session';
import type { DriveState } from '@/drive/host';
import { profileGate } from '@/features/auth/authGuard';
import { takeSettingsReturnAck } from '@/features/permissions/usePermissionHealth';

import { createDriveStateReporter, type DriveStateReporter } from './driveState';
import { registerDriveStateSource } from './driveStateStore';
import { onDeviceSyncRequested } from './events';
import { getInstallId } from './installId';
import { readReportedPermissions, reportPermissions } from './permissionsReport';
import { createExpoPushPort, easProjectId, syncPushToken, type PushPort, type SyncPushResult } from './pushToken';
import { readDeviceInfo, upsertDevice, type BaseDeviceInfo, type DevicesClient } from './register';

export interface DeviceHostDeps {
  supabase: DevicesClient;
  adapter: Pick<PermissionsAdapter, 'snapshot'>;
  push: PushPort;
  appState: AppStateLike;
  deviceInfo: () => BaseDeviceInfo | null;
  projectId: string | null;
  newId?: () => string;
}

export interface DeviceHostProps {
  /** Default true. The host also requires a signed-in, onboarded account. */
  enabled?: boolean;
  /** The drive host's subscribe; each state change goes to the drive-state reporter. */
  subscribeDrive?: (fn: (s: DriveState) => void) => () => void;
  /** Runs last on every foreground sync (Task 7's `syncNotificationPrefs`). */
  onForeground?: (userId: string) => unknown;
  onError?: (error: unknown, context: string) => void;
  /** Test seams; every one defaults to the device's own. */
  deps?: Partial<DeviceHostDeps>;
}

let sharedAdapter: PermissionsAdapter | null = null;

function resolveDeps(p: Partial<DeviceHostDeps> = {}): DeviceHostDeps {
  return {
    supabase:
      p.supabase ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only when mounted for real
      (require('@/data/supabase/client') as typeof import('@/data/supabase/client')).supabase,
    adapter: p.adapter ?? (sharedAdapter ??= createPermissionsAdapter()),
    push: p.push ?? createExpoPushPort(),
    appState: p.appState ?? AppState,
    deviceInfo: p.deviceInfo ?? readDeviceInfo,
    projectId: p.projectId !== undefined ? p.projectId : easProjectId(),
    newId: p.newId,
  };
}

export function DeviceHost(props: DeviceHostProps): null {
  const { db, now } = useDataSource();
  const { status, session, profile } = useSession();
  const userId = status === 'signedIn' ? (session?.user.id ?? null) : null;
  const active = (props.enabled ?? true) && userId !== null && profileGate(profile) === 'ready';

  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  const hasSource = props.subscribeDrive !== undefined;
  useEffect(() => (hasSource ? registerDriveStateSource() : undefined), [hasSource]);

  useEffect(() => {
    if (!active || userId === null) return;
    let live = true;
    const cleanups: (() => void)[] = [];
    const d = resolveDeps(latest.current.deps);
    const settings = createSettingsRepo(db);
    const report = (error: unknown, context: string) => {
      if (live) latest.current.onError?.(error, context);
    };
    const step = async (context: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        report(error, context);
      }
    };

    let deviceId: string | null = null;
    let reporter: DriveStateReporter | null = null;
    /** The first sync of a launch registers even when fresh; cleared once one gets an answer. */
    let forceToken = true;
    let running = false;
    let again = false;

    const ownerHolds = async (): Promise<boolean> => {
      const owner = await settings.get<string>(LAST_USER_KEY);
      const pending = await settings.get<string>(PENDING_OWNER_KEY);
      return owner === userId && (pending === null || pending === userId);
    };

    const syncToken = async (force: boolean): Promise<SyncPushResult | null> => {
      if (!live || deviceId === null) return null;
      return syncPushToken({
        userId,
        deviceId,
        settings,
        supabase: d.supabase,
        port: d.push,
        projectId: d.projectId,
        now,
        force,
        onError: report,
      });
    };

    const foreground = async (): Promise<void> => {
      if (!live || deviceId === null || d.appState.currentState !== 'active') return;
      if (!(await ownerHolds())) return;
      const id = deviceId;
      const deps = { supabase: d.supabase, settings, now, onError: report };

      let snapshot = null;
      try {
        snapshot = await d.adapter.snapshot();
      } catch (error) {
        // a failed read reports nothing, never a made-up state (T8)
        report(error, 'devices permissions snapshot');
      }
      if (!live) return;

      await step('devices upsert', async () => {
        const info = d.deviceInfo();
        if (!info) return;
        const permissions = await readReportedPermissions(settings, userId, id);
        await upsertDevice(userId, { ...info, permissions }, { ...deps, deviceId: id });
      });
      if (!live) return;

      if (snapshot) {
        const taken = snapshot;
        await step('devices permissions report', async () => {
          const result = await reportPermissions(
            { userId, deviceId: id, snapshot: taken, reportedFrom: 'foreground', ack: 'settingsReturn' },
            deps
          );
          // Back in the app with nothing changed: that Settings trip is over.
          if (result === 'unchanged') await takeSettingsReturnAck(settings, now());
        });
      }
      if (!live) return;

      await step('devices push token', async () => {
        const result = await syncToken(forceToken);
        if (result !== null && result !== 'error') forceToken = false;
      });
      if (!live) return;

      await step('devices drive state retry', async () => reporter?.retryPending());
      if (!live) return;

      await step('devices onForeground', async () => latest.current.onForeground?.(userId));
    };

    const run = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await foreground();
        } while (again && live);
      } finally {
        running = false;
      }
    };

    void (async () => {
      if (!(await ownerHolds())) return;
      const id = await getInstallId(settings, d.newId);
      if (!live) return;
      deviceId = id;

      // Everything below is attached synchronously, after the last await, so an unmount in the
      // meantime leaves nothing behind.
      const subscribeDrive = latest.current.subscribeDrive;
      if (subscribeDrive) {
        const r = createDriveStateReporter({ supabase: d.supabase, userId, deviceId: id, onError: report });
        reporter = r;
        cleanups.push(subscribeDrive((s) => r.onDriveState(s)));
      }
      cleanups.push(
        onDeviceSyncRequested(() => {
          void step('devices push token', () => syncToken(false));
        })
      );
      const tokenSub = d.push.addPushTokenListener(() => {
        void step('devices push token', () => syncToken(true));
      });
      cleanups.push(() => tokenSub.remove());
      const appSub = d.appState.addEventListener('change', (next) => {
        if (next === 'active') void run();
      });
      cleanups.push(() => appSub.remove());

      await run();
    })().catch((error: unknown) => report(error, 'devices host'));

    return () => {
      live = false;
      for (const cleanup of cleanups.splice(0)) cleanup();
    };
  }, [active, userId, db, now]);

  return null;
}
