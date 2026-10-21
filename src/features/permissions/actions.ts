/**
 * What a tap on a missing permission does, from Home's row, Settings › Permissions and Start Drive's
 * Fix it alike. A request is the driver's own tap, so it is never throttled, and it stamps the 14-day
 * history so the app's own later offers wait (policy.ts). Bluetooth, the camera and Background App
 * Refresh never request: they only open the phone's settings. Location Always asks once (iOS shows
 * that prompt once), then opens Settings.
 *
 * The no-effect rule: after a request the board is read again; if the permission is still missing
 * in the same state (a dialog the phone did not show, one dismissed, Android notifications switched
 * off with the permission kept, a declined Play-services dialog), the request had no visible effect
 * and that row's next tap opens Settings. So no tap is ever dead twice.
 */
import { recordPrompt, type NotificationAccess, type PermissionsAdapter, type SettingsStore } from '@/core/permissions';

import type { Fix } from './board';
import { markToSettings } from './homePrefs';
import { permissionDef, signature, type MissingState, type PermissionBoardRead, type PermissionId } from './registry';
import { markSettingsReturn } from './usePermissionHealth';

export interface FixDeps {
  adapter: PermissionsAdapter;
  settings: SettingsStore;
  now: () => number;
  /** A forced, fresh read of the board after a request; null when the phone can't be read. */
  reread: () => Promise<PermissionBoardRead | null>;
  /** Android: the notification channels, made before the notifications prompt so the phone names them. */
  ensureChannels?: () => Promise<void>;
  /** After notifications are allowed: the device host registers the push token. */
  requestDeviceSync?: () => void;
  /** Stamp the "back from Settings" acknowledgement before opening Settings (Settings › Permissions). */
  markReturn?: boolean;
}

export type FixOutcome =
  | { kind: 'requested'; read: PermissionBoardRead | null; noEffect: boolean }
  | { kind: 'opened' };

const allowed = (n: NotificationAccess) => n === 'granted' || n === 'provisional';

const stamp = (deps: FixDeps, permission: 'location' | 'motion' | 'notifications') =>
  recordPrompt(deps.settings, permission, deps.now()).catch(() => {});

/** Whether this id and state have a phone prompt at all (never Bluetooth, the camera or Background App Refresh). */
export function requestable(id: PermissionId, state: MissingState): boolean {
  if (!state.canAsk) return false;
  return id === 'location' || id === 'precise' || id === 'locationAlways' || id === 'motion' || id === 'notifications';
}

async function request(id: PermissionId, state: MissingState, deps: FixDeps): Promise<void> {
  const { adapter } = deps;
  switch (id) {
    case 'location':
      if (state.reason === 'servicesOff') {
        await adapter.requestLocationServices();
        return;
      }
      await adapter.requestLocationForeground();
      await stamp(deps, 'location');
      return;
    case 'precise':
      // Fine and coarse again: Android 12+ shows its "change to precise" dialog.
      await adapter.requestLocationForeground();
      await stamp(deps, 'location');
      return;
    case 'locationAlways':
      await adapter.requestLocationAlways();
      await stamp(deps, 'location');
      return;
    case 'motion':
      await adapter.requestMotion();
      await stamp(deps, 'motion');
      return;
    case 'notifications': {
      if (deps.ensureChannels) await deps.ensureChannels().catch(() => {});
      const answer = await adapter.requestNotifications();
      await stamp(deps, 'notifications');
      if (allowed(answer)) deps.requestDeviceSync?.();
      return;
    }
    default:
      throw new Error(`${id} is never requested`);
  }
}

async function openTarget(state: MissingState, deps: FixDeps): Promise<void> {
  if (deps.markReturn) await markSettingsReturn(deps.settings, deps.now());
  switch (state.target) {
    case 'locationServices':
      return deps.adapter.openLocationServicesSettings();
    case 'app':
      return deps.adapter.openAppSettings();
  }
}

/**
 * Runs one fix for `id` in `state`. A request or Settings call that throws rejects and stores
 * nothing; the caller shows "That didn't work. Try again."
 */
export async function runFix(id: PermissionId, state: MissingState, fix: Fix, deps: FixDeps): Promise<FixOutcome> {
  if (fix === 'settings' || !requestable(id, state)) {
    await openTarget(state, deps);
    return { kind: 'opened' };
  }
  await request(id, state, deps);
  const read = await deps.reread();
  if (read === null) return { kind: 'requested', read, noEffect: false };
  const after = permissionDef(id).state(read);
  const noEffect = after.kind === 'missing' && signature(after) === signature(state);
  if (noEffect) await markToSettings(deps.settings, id, signature(state)).catch(() => {});
  return { kind: 'requested', read, noEffect };
}
