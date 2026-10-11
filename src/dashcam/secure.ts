// The two SecureStore entries the transport needs before SQLite is open (plan §7.4): whether to
// start the BLE manager at launch, and which peripheral to keep connected. Written at opt-in and
// pairing, readable after the first unlock (an iOS Bluetooth relaunch can happen with the phone
// locked), and they survive the handover wipe (SecureStore is not the database).
import { isDashcamId } from './protocol';
import { ENABLED_SECURE_KEY } from './keys';

export const PERIPHERAL_SECURE_KEY = 'dashpal.peripheral';

interface SecureStoreLike {
  getItemAsync(key: string, opts?: unknown): Promise<string | null>;
  setItemAsync(key: string, value: string, opts?: unknown): Promise<void>;
  deleteItemAsync(key: string, opts?: unknown): Promise<void>;
  AFTER_FIRST_UNLOCK?: unknown;
}

function secureStore(): SecureStoreLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  return require('expo-secure-store') as SecureStoreLike;
}

function options(s: SecureStoreLike): unknown {
  return s.AFTER_FIRST_UNLOCK === undefined ? undefined : { keychainAccessible: s.AFTER_FIRST_UNLOCK };
}

export interface SecureTarget {
  peripheralId: string;
  dashcamId: string;
}

export async function readDashpalEnabled(): Promise<boolean> {
  const s = secureStore();
  return (await s.getItemAsync(ENABLED_SECURE_KEY, options(s))) === '1';
}

export async function readSecureTarget(): Promise<SecureTarget | null> {
  const s = secureStore();
  const raw = await s.getItemAsync(PERIPHERAL_SECURE_KEY, options(s));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SecureTarget>;
    if (typeof v.peripheralId === 'string' && v.peripheralId.length > 0 && isDashcamId(v.dashcamId)) return { peripheralId: v.peripheralId, dashcamId: v.dashcamId };
  } catch {
    // unreadable: as if absent
  }
  return null;
}

export async function writeDashpalEnabled(on: boolean): Promise<void> {
  const s = secureStore();
  if (on) await s.setItemAsync(ENABLED_SECURE_KEY, '1', options(s));
  else await s.deleteItemAsync(ENABLED_SECURE_KEY, options(s));
}

export async function writeSecureTarget(target: SecureTarget | null): Promise<void> {
  const s = secureStore();
  if (target) await s.setItemAsync(PERIPHERAL_SECURE_KEY, JSON.stringify(target), options(s));
  else await s.deleteItemAsync(PERIPHERAL_SECURE_KEY, options(s));
}
