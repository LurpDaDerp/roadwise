/**
 * Settings › Notifications › "Weather before your commute": this phone's own switch for the weather
 * heads-up before the usual commute (`commuteHeadsUp.ts`). On until switched off: only a stored
 * `false` is off. Local only (never sent anywhere); cleared at sign-out (`SIGN_OUT_SETTINGS`) and by
 * the device wipe, so the next driver starts with it on.
 */
export const COMMUTE_HEADS_UP_KEY = 'weather.commuteHeadsUp';

type Store = { get<T>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void> };

export const commuteHeadsUpOn = (raw: unknown): boolean => raw !== false;

export async function readCommuteHeadsUp(store: Pick<Store, 'get'>): Promise<boolean> {
  return commuteHeadsUpOn(await store.get<unknown>(COMMUTE_HEADS_UP_KEY));
}

export async function writeCommuteHeadsUp(store: Pick<Store, 'set'>, on: boolean): Promise<void> {
  await store.set(COMMUTE_HEADS_UP_KEY, on);
}
