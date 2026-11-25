/**
 * Settings › Notifications: the switches this phone keeps for the notifications it posts itself.
 * Each is on until switched off (only a stored `false` is off), local only (never sent anywhere),
 * and cleared at sign-out (`SIGN_OUT_SETTINGS`) and by the device wipe, so the next driver starts
 * with them on.
 *
 * - "Drive started": the note an automatic drive posts when it starts (drive-sense posts it
 *   natively, so the switch is handed to native too: `setDriveStartNote` in src/boot/autoDetect.ts).
 * - "Drive recaps": the recap when a drive ends (`summaryNotifier.ts`).
 * - "Are you driving?": the passenger check during a drive (`src/drive/passengerNote.ts`).
 *
 * The weather heads-up's switch lives with the heads-up (`features/weather/commuteSetting.ts`).
 */
export const DRIVE_STARTED_KEY = 'notify.driveStarted';
export const DRIVE_RECAPS_KEY = 'notify.driveRecaps';
export const ARE_YOU_DRIVING_KEY = 'notify.areYouDriving';

export type LocalSwitchKey = typeof DRIVE_STARTED_KEY | typeof DRIVE_RECAPS_KEY | typeof ARE_YOU_DRIVING_KEY;

type Store = { get<T>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void> };

export const switchOn = (raw: unknown): boolean => raw !== false;

/** The switch as stored; on when unreadable (a missed setting costs less than a silent phone). */
export async function readSwitch(store: Pick<Store, 'get'>, key: LocalSwitchKey): Promise<boolean> {
  try {
    return switchOn(await store.get<unknown>(key));
  } catch {
    return true;
  }
}

export async function writeSwitch(store: Pick<Store, 'set'>, key: LocalSwitchKey, on: boolean): Promise<void> {
  await store.set(key, on);
}
