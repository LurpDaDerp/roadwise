// The DashPal entries in SecureStore (plan §7.4; pairing v2 §7.2). They are read before SQLite is
// open (an iOS Bluetooth relaunch can come with the phone locked, after its first unlock) and they
// survive the handover wipe (SecureStore is not the database): the pairing belongs to the phone.
//
// - `dashpal.enabled`: start the BLE manager at launch (written at opt-in and pairing).
// - `dashpal.peripheral`: `{peripheralId, dashcamId}`, the paired peripheral to keep connected.
// - `dashpal.auth`: this phone's pairing key with the paired DashPal, `{v: 2, dashcamId, phoneId
//   (16 hex), kPair (64 hex)}` (a `code` field an older build wrote is ignored).
// - `dashpal.authPending`: the key of a pairing under way, written before PAIR_FIN; it replaces
//   `dashpal.auth` only once the DashPal has committed the setup, so a failed or cancelled setup
//   leaves the previous pairing as it was.
// - `dashpal.orphan`: `{dashcamId, phoneId, kPair}`, a key left from before (an iOS reinstall, a
//   commit whose answer never came); never used for a session, only to prove `prev_id` when this
//   phone next sets up that DashPal.
// - `dashpal.pendingCode`: `{at, dashcamId, code}`, a label link's code held until setup can open
//   (12 h), so the code never enters router state or SQLite.
// The key entries are "this device only": never in a backup, never on another phone.
import { isDashcamId } from './protocol';
import { ENABLED_SECURE_KEY } from './keys';

export const PERIPHERAL_SECURE_KEY = 'dashpal.peripheral';
export const AUTH_SECURE_KEY = 'dashpal.auth';
export const AUTH_PENDING_SECURE_KEY = 'dashpal.authPending';
export const ORPHAN_SECURE_KEY = 'dashpal.orphan';
export const PENDING_CODE_SECURE_KEY = 'dashpal.pendingCode';
/** A held link's code is used within this long of its arrival (the drive-hold rule, `ui/links.ts`). */
export const PENDING_CODE_MAX_AGE_MS = 12 * 60 * 60_000;

export interface SecureStoreLike {
  getItemAsync(key: string, opts?: unknown): Promise<string | null>;
  setItemAsync(key: string, value: string, opts?: unknown): Promise<void>;
  deleteItemAsync(key: string, opts?: unknown): Promise<void>;
  AFTER_FIRST_UNLOCK?: unknown;
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY?: unknown;
}

function secureStore(): SecureStoreLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  return require('expo-secure-store') as SecureStoreLike;
}

function options(s: SecureStoreLike): unknown {
  return s.AFTER_FIRST_UNLOCK === undefined ? undefined : { keychainAccessible: s.AFTER_FIRST_UNLOCK };
}

/** The keys' accessibility: after the first unlock, and only on this device. */
function deviceOnly(s: SecureStoreLike): unknown {
  return s.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY === undefined ? undefined : { keychainAccessible: s.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
}

export interface SecureTarget {
  peripheralId: string;
  dashcamId: string;
}

/** This phone's pairing key with one DashPal. */
export interface StoredAuth {
  dashcamId: string;
  /** this phone's id at that DashPal, 16 lowercase hex */
  phoneId: string;
  /** the 32-byte pairing key, 64 lowercase hex */
  kPair: string;
}

export interface OrphanAuth {
  dashcamId: string;
  phoneId: string;
  kPair: string;
}

export interface PendingCode {
  at: number;
  /** the link's dashcam id, when it named one */
  dashcamId: string | null;
  /** the code text as the link carried it */
  code: string;
}

const isHex = (s: unknown, n: number): s is string => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asAuth(v: Record<string, unknown> | null): StoredAuth | null {
  if (!v || v.v !== 2 || !isDashcamId(v.dashcamId) || !isHex(v.phoneId, 16) || !isHex(v.kPair, 64)) return null;
  if (/^0+$/.test(v.phoneId)) return null;
  return { dashcamId: v.dashcamId, phoneId: v.phoneId, kPair: v.kPair };
}

function asOrphan(v: Record<string, unknown> | null): OrphanAuth | null {
  if (!v || !isDashcamId(v.dashcamId) || !isHex(v.phoneId, 16) || !isHex(v.kPair, 64)) return null;
  return { dashcamId: v.dashcamId, phoneId: v.phoneId, kPair: v.kPair };
}

/** The DashPal SecureStore entries (a test or the e2e bench passes its own store, one per phone). */
export interface DashpalSecrets {
  readEnabled(): Promise<boolean>;
  writeEnabled(on: boolean): Promise<void>;
  readTarget(): Promise<SecureTarget | null>;
  writeTarget(target: SecureTarget | null): Promise<void>;
  readAuth(): Promise<StoredAuth | null>;
  /** The key of a setup under way (before PAIR_FIN). */
  writePendingAuth(auth: StoredAuth): Promise<void>;
  readPendingAuth(): Promise<StoredAuth | null>;
  deletePendingAuth(): Promise<void>;
  /** The setup finished: the pending key becomes this phone's pairing (the previous one goes). */
  finalizeAuth(): Promise<StoredAuth | null>;
  deleteAuth(): Promise<void>;
  readOrphan(): Promise<OrphanAuth | null>;
  writeOrphan(o: OrphanAuth): Promise<void>;
  deleteOrphan(): Promise<void>;
  /** A held link's code, when it is at most 12 h old (an older one is deleted and reads as none). */
  readPendingCode(now: number): Promise<PendingCode | null>;
  writePendingCode(p: PendingCode): Promise<void>;
  deletePendingCode(): Promise<void>;
}

export function createDashpalSecrets(store: () => SecureStoreLike = secureStore): DashpalSecrets {
  const get = async (key: string, keyOpts: (s: SecureStoreLike) => unknown) => {
    const s = store();
    return s.getItemAsync(key, keyOpts(s));
  };
  const set = async (key: string, value: string, keyOpts: (s: SecureStoreLike) => unknown) => {
    const s = store();
    await s.setItemAsync(key, value, keyOpts(s));
  };
  const del = async (key: string, keyOpts: (s: SecureStoreLike) => unknown) => {
    const s = store();
    await s.deleteItemAsync(key, keyOpts(s));
  };
  const authJson = (a: StoredAuth): string => JSON.stringify({ v: 2, dashcamId: a.dashcamId, phoneId: a.phoneId, kPair: a.kPair });

  const self: DashpalSecrets = {
    readEnabled: async () => (await get(ENABLED_SECURE_KEY, options)) === '1',
    writeEnabled: (on) => (on ? set(ENABLED_SECURE_KEY, '1', options) : del(ENABLED_SECURE_KEY, options)),
    async readTarget() {
      const v = parseJson(await get(PERIPHERAL_SECURE_KEY, options));
      if (v && typeof v.peripheralId === 'string' && v.peripheralId.length > 0 && isDashcamId(v.dashcamId)) return { peripheralId: v.peripheralId, dashcamId: v.dashcamId };
      return null;
    },
    writeTarget: (t) => (t ? set(PERIPHERAL_SECURE_KEY, JSON.stringify({ peripheralId: t.peripheralId, dashcamId: t.dashcamId }), options) : del(PERIPHERAL_SECURE_KEY, options)),
    readAuth: async () => asAuth(parseJson(await get(AUTH_SECURE_KEY, deviceOnly))),
    writePendingAuth: (a) => set(AUTH_PENDING_SECURE_KEY, authJson(a), deviceOnly),
    readPendingAuth: async () => asAuth(parseJson(await get(AUTH_PENDING_SECURE_KEY, deviceOnly))),
    deletePendingAuth: () => del(AUTH_PENDING_SECURE_KEY, deviceOnly),
    async finalizeAuth() {
      const pending = await self.readPendingAuth();
      if (!pending) return null;
      await set(AUTH_SECURE_KEY, authJson(pending), deviceOnly);
      await del(AUTH_PENDING_SECURE_KEY, deviceOnly);
      return pending;
    },
    deleteAuth: () => del(AUTH_SECURE_KEY, deviceOnly),
    readOrphan: async () => asOrphan(parseJson(await get(ORPHAN_SECURE_KEY, deviceOnly))),
    writeOrphan: (o) => set(ORPHAN_SECURE_KEY, JSON.stringify({ dashcamId: o.dashcamId, phoneId: o.phoneId, kPair: o.kPair }), deviceOnly),
    deleteOrphan: () => del(ORPHAN_SECURE_KEY, deviceOnly),
    async readPendingCode(now) {
      const v = parseJson(await get(PENDING_CODE_SECURE_KEY, deviceOnly));
      if (!v) return null;
      const at = typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : null;
      const code = typeof v.code === 'string' && v.code.length > 0 && v.code.length <= 64 ? v.code : null;
      const dashcamId = v.dashcamId === null || v.dashcamId === undefined ? null : isDashcamId(v.dashcamId) ? v.dashcamId : undefined;
      if (at === null || code === null || dashcamId === undefined || now < at || now - at > PENDING_CODE_MAX_AGE_MS) {
        await del(PENDING_CODE_SECURE_KEY, deviceOnly).catch(() => {});
        return null;
      }
      return { at, dashcamId, code };
    },
    writePendingCode: (p) => set(PENDING_CODE_SECURE_KEY, JSON.stringify({ at: p.at, dashcamId: p.dashcamId, code: p.code }), deviceOnly),
    deletePendingCode: () => del(PENDING_CODE_SECURE_KEY, deviceOnly),
  };
  return self;
}

/** The app's DashPal SecureStore entries (expo-secure-store, loaded on first use). */
export const dashpalSecrets: DashpalSecrets = createDashpalSecrets();

export const readDashpalEnabled = (): Promise<boolean> => dashpalSecrets.readEnabled();
export const readSecureTarget = (): Promise<SecureTarget | null> => dashpalSecrets.readTarget();
export const writeDashpalEnabled = (on: boolean): Promise<void> => dashpalSecrets.writeEnabled(on);
export const writeSecureTarget = (target: SecureTarget | null): Promise<void> => dashpalSecrets.writeTarget(target);
