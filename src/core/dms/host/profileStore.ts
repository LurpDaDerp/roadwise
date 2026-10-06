// The only profile and setup stores (plan Privacy 7, rev1 S-M2): the settings table, one key each, bound to
// the uid. Never a file, SecureStore or a table of their own, so the handover wipe (DEVICE_TABLES includes
// `settings`) clears them by construction. A different uid never loads either: the mismatch removes the key.
// The camera bridge also calls clear() on sign-out and account deletion.
import { parseProfile, type DmsProfileV1 } from '../engine/profile';
import { parseSetupRecord, type DmsSetupRecord } from '../engine/setupRecord';

export const DMS_PROFILE_KEY = 'dms.profile';
/** The setup session's record (v3): the seed and the mirror zones, applied at every drive's start. */
export const DMS_SETUP_KEY = 'dms.setup';

export interface DmsProfileStore {
  /** The signed-in uid's profile, parsed; null when absent, someone else's or malformed. */
  load(): Promise<DmsProfileV1 | null>;
  save(p: DmsProfileV1): Promise<void>;
  clear(): Promise<void>;
}

export interface DmsSetupStore {
  /** The signed-in uid's setup record, parsed; null when absent, someone else's or malformed. */
  load(): Promise<DmsSetupRecord | null>;
  save(r: DmsSetupRecord): Promise<void>;
  clear(): Promise<void>;
}

export interface SettingsLike {
  get<T>(k: string): Promise<T | null>;
  set(k: string, v: unknown): Promise<void>;
  remove(k: string): Promise<boolean>;
}

function uidBoundStore<T>(settings: SettingsLike, uid: string, key: string, field: string, parse: (x: unknown) => T | null) {
  return {
    async load(): Promise<T | null> {
      const stored = await settings.get<unknown>(key);
      if (stored === null || stored === undefined) return null;
      const o = typeof stored === 'object' ? (stored as Record<string, unknown>) : null;
      const value = o !== null && o.uid === uid ? parse(o[field]) : null;
      if (value === null) await settings.remove(key); // someone else's, or unreadable
      return value;
    },
    async save(v: T): Promise<void> {
      await settings.set(key, { uid, [field]: v });
    },
    async clear(): Promise<void> {
      await settings.remove(key);
    },
  };
}

export function createSettingsProfileStore(settings: SettingsLike, uid: string): DmsProfileStore {
  return uidBoundStore<DmsProfileV1>(settings, uid, DMS_PROFILE_KEY, 'profile', (x) => parseProfile(x));
}

export function createSettingsSetupStore(settings: SettingsLike, uid: string): DmsSetupStore {
  return uidBoundStore<DmsSetupRecord>(settings, uid, DMS_SETUP_KEY, 'setup', (x) => parseSetupRecord(x));
}
