// The BLE manager at module load (plan §7.4), from `index.ts`, before any React tree or the runtime:
// iOS state restoration emits once, during `start()`, and only if the app's restore identifier is
// registered in that process. Only when the driver opted into DashPal (`dashpal.enabled`): nobody
// without a DashPal ever sees the Bluetooth permission prompt. The paired peripheral comes from
// SecureStore too, so a restored connection is kept and every other one cancelled before SQLite is
// open; bootstrap later sets the target from the database (the source of truth).
//
// The install marker (pairing v2 §7.2): iOS Keychain items outlive an uninstall, and this runs
// before SQLite opens, so a reinstalled app could otherwise reconnect with a key the driver never set
// up in this install. AsyncStorage `dashpal.install` lives in the app container (an uninstall wipes
// it). When it is missing, the leftover entries are quarantined: the launch flag and the peripheral
// go, the pairing key moves to `dashpal.orphan` (used only to prove `prev_id` at the next setup of
// that DashPal), the marker is written and nothing starts. When AsyncStorage cannot be read, nothing
// starts early either (bootstrap sets the target from SQLite as usual). A link's held code goes only
// when it is older than this process: the label link that launched the app (the first launch after
// an install or update) is kept, and `+native-intent` writes its code only after the check
// (`afterInstallCheck`). With the marker present, the pending key of a setup the app died in
// (`dashpal.authPending`) is deleted.
import { getDashcamTransport, type DashcamTransport } from './transport';
import { dashpalSecrets, type DashpalSecrets } from './secure';

export const INSTALL_MARKER_KEY = 'dashpal.install';
/** The longest a link waits for this launch's install check before it writes its code anyway. */
export const INSTALL_CHECK_WAIT_MS = 2000;

/** When this process loaded the module: a held link code from before it is a leftover. */
const LOADED_AT = Date.now();
/** This launch's install check (set by `startDashpalEarly`, which `index.ts` calls at module load). */
let installCheck: Promise<unknown> = Promise.resolve();

/** Resolves once this launch's install check has finished, or after `ms` at most. Never rejects. */
export function afterInstallCheck(ms: number = INSTALL_CHECK_WAIT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    installCheck.then(
      () => {},
      () => {}
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/** The slice of AsyncStorage the marker uses. */
export interface MarkerStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

function asyncStorage(): MarkerStorage {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  return (require('@react-native-async-storage/async-storage') as { default: MarkerStorage }).default;
}

/**
 * `present`: this install's marker is there. `quarantined`: it was missing (a fresh install, or the
 * first launch of a build with link v2), so the leftover DashPal entries were set aside. `unknown`:
 * AsyncStorage could not be read.
 */
export async function checkInstall(
  deps: { secrets?: DashpalSecrets; storage?: () => MarkerStorage; loadedAt?: number } = {}
): Promise<'present' | 'quarantined' | 'unknown'> {
  const secrets = deps.secrets ?? dashpalSecrets;
  const loadedAt = deps.loadedAt ?? LOADED_AT;
  let storage: MarkerStorage;
  let marker: string | null;
  try {
    storage = (deps.storage ?? asyncStorage)();
    marker = await storage.getItem(INSTALL_MARKER_KEY);
  } catch {
    return 'unknown';
  }
  if (marker !== null) return 'present';
  // Each step on its own: one failing never keeps the others from running.
  await secrets.writeEnabled(false).catch(() => {});
  await secrets.writeTarget(null).catch(() => {});
  const auth = await secrets.readAuth().catch(() => null);
  const pending = auth ? null : await secrets.readPendingAuth().catch(() => null);
  const left = auth ?? pending;
  if (left) await secrets.writeOrphan({ dashcamId: left.dashcamId, phoneId: left.phoneId, kPair: left.kPair }).catch(() => {});
  await secrets.deleteAuth().catch(() => {});
  await secrets.deletePendingAuth().catch(() => {});
  // A link's code from before this process goes; the one of the link that launched it stays.
  const held = await secrets.readPendingCode(Date.now()).catch(() => null);
  if (held && held.at < loadedAt) await secrets.deletePendingCode().catch(() => {});
  await storage.setItem(INSTALL_MARKER_KEY, '1').catch(() => {});
  return 'quarantined';
}

/** Write the install marker if it is missing (the runtime, after a launch whose write failed). Never throws. */
export async function ensureInstallMarker(storage: () => MarkerStorage = asyncStorage): Promise<void> {
  try {
    const s = storage();
    if ((await s.getItem(INSTALL_MARKER_KEY)) === null) await s.setItem(INSTALL_MARKER_KEY, '1');
  } catch {
    // the next launch checks again
  }
}

export async function startDashpalEarly(
  deps: { transport?: () => DashcamTransport; secrets?: DashpalSecrets; storage?: () => MarkerStorage; onError?: (e: unknown) => void } = {}
): Promise<boolean> {
  try {
    const secrets = deps.secrets ?? dashpalSecrets;
    // Set before the first await: a link handled meanwhile waits for it (`afterInstallCheck`).
    const check = checkInstall({ secrets, storage: deps.storage });
    installCheck = check;
    if ((await check) !== 'present') return false;
    // A setup the app did not live to finish: its key goes (the DashPal undoes a pairing that was
    // not committed by itself, 60 s after the phone went away).
    if (await secrets.readPendingAuth().catch(() => null)) await secrets.deletePendingAuth().catch(() => {});
    if (!(await secrets.readEnabled())) return false;
    const transport = (deps.transport ?? getDashcamTransport)();
    const target = await secrets.readTarget();
    // The pairing key goes with the target: without it no session can be proven, so nothing connects.
    const auth = target ? await secrets.readAuth() : null;
    if (target && auth && auth.dashcamId === target.dashcamId && transport.target() === null) {
      transport.setTarget({ ...target, auth: { phoneId: auth.phoneId, kPair: auth.kPair } });
    }
    await transport.start();
    return true;
  } catch (e) {
    deps.onError?.(e);
    return false;
  }
}
