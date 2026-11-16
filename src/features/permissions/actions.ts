/**
 * What a tap on a missing permission does, from Home's row, Settings › Permissions and Start Drive's
 * Fix it alike. A request is the driver's own tap, so it is never throttled, and it stamps the 14-day
 * history so the app's own later offers wait (policy.ts). Bluetooth, the camera and Background App
 * Refresh never request: they only open the phone's settings. Location Always asks once (iOS shows
 * that prompt once), then opens Settings. On Android every Location Always tap, a request or
 * Settings alike, first shows Google Play's prominent disclosure (`discloseBackground`): Not now
 * asks nothing and opens nothing. So does the location tap on Android 9 and lower with the drive
 * detector, where allowing location allows it in the background too (the caller passes the
 * disclosure only then: `disclosesBackground`).
 *
 * The no-effect rule: after a request the board is read again; if the permission is still missing
 * in the same state (a dialog the phone did not show, one dismissed, Android notifications switched
 * off with the permission kept, a declined Play-services dialog), the request had no visible effect
 * and that row's next tap opens Settings. So no tap is ever dead twice.
 */
import { recordPrompt, type NotificationAccess, type PermissionsAdapter, type SettingsStore } from '@/core/permissions';

import type { Fix } from './board';
import type { DisclosureNext } from './copy';
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
  /**
   * Android: Google Play's prominent disclosure, shown before any Location Always fix (and the
   * location fix where that is a background request too); resolves true on Continue. Only with it
   * does the adapter ask for "Allow all the time". Its argument names the choice the phone offers
   * next.
   */
  discloseBackground?: (next: DisclosureNext) => Promise<boolean>;
}

export type FixOutcome =
  | { kind: 'requested'; read: PermissionBoardRead | null; noEffect: boolean }
  | { kind: 'opened' }
  /** The driver chose Not now on the background-location disclosure: nothing was asked or opened. */
  | { kind: 'declined' };

const allowed = (n: NotificationAccess) => n === 'granted' || n === 'provisional';

const stamp = (deps: FixDeps, permission: 'location' | 'motion' | 'notifications') =>
  recordPrompt(deps.settings, permission, deps.now()).catch(() => {});

/** Whether this id and state have a phone prompt at all (never Bluetooth, the camera or Background App Refresh). */
export function requestable(id: PermissionId, state: MissingState): boolean {
  if (!state.canAsk) return false;
  return id === 'location' || id === 'precise' || id === 'locationAlways' || id === 'motion' || id === 'notifications';
}

async function request(id: PermissionId, state: MissingState, deps: FixDeps, disclosed: boolean): Promise<void> {
  const { adapter } = deps;
  switch (id) {
    case 'location':
      if (state.reason === 'servicesOff') {
        await adapter.requestLocationServices();
        return;
      }
      // Android 9 and lower with the drive detector: the disclosure was shown (the adapter asks only then).
      await adapter.requestLocationForeground({ disclosed });
      await stamp(deps, 'location');
      return;
    case 'precise':
      // Fine and coarse again: Android 12+ shows its "change to precise" dialog.
      await adapter.requestLocationForeground();
      await stamp(deps, 'location');
      return;
    case 'locationAlways':
      await adapter.requestLocationAlways({ disclosed });
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
    case 'batterySaver':
      return deps.adapter.openBatterySaverSettings();
    case 'unusedApps':
      return deps.adapter.openUnusedAppSettings();
    case 'app':
      return deps.adapter.openAppSettings();
  }
}

/**
 * Runs one fix for `id` in `state`. A request or Settings call that throws rejects and stores
 * nothing; the caller shows "That didn't work. Try again."
 */
export async function runFix(id: PermissionId, state: MissingState, fix: Fix, deps: FixDeps): Promise<FixOutcome> {
  let disclosed = false;
  const background = id === 'locationAlways' || (id === 'location' && state.reason !== 'servicesOff');
  if (background && deps.discloseBackground) {
    if (!(await deps.discloseBackground(id === 'locationAlways' ? 'allTheTime' : 'allow'))) return { kind: 'declined' };
    disclosed = true;
  }
  if (fix === 'settings' || !requestable(id, state)) {
    await openTarget(state, deps);
    return { kind: 'opened' };
  }
  await request(id, state, deps, disclosed);
  const read = await deps.reread();
  if (read === null) return { kind: 'requested', read, noEffect: false };
  const after = permissionDef(id).state(read);
  const noEffect = after.kind === 'missing' && signature(after) === signature(state);
  if (noEffect) await markToSettings(deps.settings, id, signature(state)).catch(() => {});
  return { kind: 'requested', read, noEffect };
}
