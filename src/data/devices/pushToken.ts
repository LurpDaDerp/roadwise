/**
 * The Expo push token, registered with the server against this install (`register_push_token`)
 * and released before sign-out (`unregister_push_token`).
 *
 * - Registered when the token changed, when the last registration is more than 7 days old, or
 *   when forced: `DeviceHost` forces its first sync of every launch (T2 security M-3: a token is
 *   re-registered at every launch; a takeover by another account on this phone is by design).
 * - Never without notification permission, and never from a simulator.
 * - The token is kept on the phone only (settings), to compare and to release. It is never
 *   returned, logged or put in an error: every result is a status word.
 *
 * Release (sign-out): 2-second budget, errors swallowed, sent only under the account that
 * registered it (T17 security: a late release must never go out under the next driver's JWT),
 * and aborted at the budget so it cannot land later. Offline, it fails: the server keeps the
 * registration, and the previous account's server pushes can reach the signed-out phone until
 * another account registers the token here (rev1: m — the accepted residual).
 */
import type { SettingsRepo } from '@/data/db/settings';

import type { DevicesClient } from './register';

export const PUSH_REGISTRATION_KEY = 'device.pushRegistration';
export const PUSH_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
export const UNREGISTER_BUDGET_MS = 2_000;

/** The server's own pattern (0007 `push_registrations.token`). */
const TOKEN_PATTERN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

/** The OS side, behind a port so tests never touch expo-notifications. */
export interface PushPort {
  /** A real phone (a simulator has no push token). */
  isDevice(): boolean;
  /** Notification permission granted (or iOS provisional). Never asks. */
  permitted(): Promise<boolean>;
  getExpoPushToken(projectId: string | null): Promise<string>;
  /** The OS issued a new device token. */
  addPushTokenListener(listener: () => void): { remove(): void };
}

/** expo-notifications and expo-device, loaded on first use. */
export function createExpoPushPort(): PushPort {
  /* eslint-disable @typescript-eslint/no-require-imports -- native modules, loaded on first use */
  const notifications = () => require('expo-notifications') as typeof import('expo-notifications');
  const device = () => require('expo-device') as typeof import('expo-device');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    isDevice: () => device().isDevice === true,
    async permitted() {
      const N = notifications();
      const p = await N.getPermissionsAsync();
      return p.granted || p.ios?.status === N.IosAuthorizationStatus.PROVISIONAL;
    },
    async getExpoPushToken(projectId) {
      const { data } = await notifications().getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      return data;
    },
    addPushTokenListener: (listener) => notifications().addPushTokenListener(() => listener()),
  };
}

/** The EAS project id the token is issued for (app.config.ts `extra.eas.projectId`). */
export function easProjectId(): string | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module, loaded on first use
  const Constants = (require('expo-constants') as typeof import('expo-constants')).default;
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const id = extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  return typeof id === 'string' && id !== '' ? id : null;
}

interface Registration {
  token: string;
  userId: string;
  deviceId: string;
  at: number;
}

function parseRegistration(raw: unknown): Registration | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return typeof r.token === 'string' &&
    typeof r.userId === 'string' &&
    typeof r.deviceId === 'string' &&
    typeof r.at === 'number'
    ? { token: r.token, userId: r.userId, deviceId: r.deviceId, at: r.at }
    : null;
}

export type SyncPushResult = 'registered' | 'unchanged' | 'no-permission' | 'not-a-device' | 'error';

export interface SyncPushDeps {
  userId: string;
  deviceId: string;
  settings: Pick<SettingsRepo, 'get' | 'set'>;
  supabase: DevicesClient;
  port: PushPort;
  projectId: string | null;
  now: () => number;
  /** Register even when the last registration is fresh (the first sync of a launch, a new OS token). */
  force?: boolean;
  onError?: (error: unknown, context: string) => void;
}

/** A failure described without the token (or anything else the error might carry). */
const failure = (what: string, error: unknown): Error => {
  const code =
    error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? ` (${(error as { code: string }).code})`
      : '';
  return new Error(`${what}${code}`);
};

export async function syncPushToken(deps: SyncPushDeps): Promise<SyncPushResult> {
  const { userId, deviceId, settings, port } = deps;
  const report = (what: string, error: unknown) => deps.onError?.(failure(what, error), 'devices push token');
  try {
    if (!port.isDevice()) return 'not-a-device';
    if (!(await port.permitted())) return 'no-permission';
  } catch (error) {
    report('push permission could not be read', error);
    return 'error';
  }

  const now = deps.now();
  const last = parseRegistration(await settings.get<unknown>(PUSH_REGISTRATION_KEY));
  const same = last !== null && last.userId === userId && last.deviceId === deviceId;
  // Fresh: no token fetch at all (getExpoPushTokenAsync is a request to Expo). A new OS token
  // arrives through the listener, which forces.
  if (!deps.force && same && last.at <= now && now - last.at < PUSH_REFRESH_MS) return 'unchanged';

  let token: string;
  try {
    token = await port.getExpoPushToken(deps.projectId);
  } catch (error) {
    report('push token could not be fetched', error);
    return 'error';
  }
  if (!TOKEN_PATTERN.test(token)) {
    report('push token is not an Expo push token', null);
    return 'error';
  }

  try {
    const { error } = await deps.supabase.rpc('register_push_token', { p_device_id: deviceId, p_token: token });
    if (error) throw error;
  } catch (error) {
    report('push token registration failed', error);
    return 'error';
  }
  const record: Registration = { token, userId, deviceId, at: now };
  await settings.set(PUSH_REGISTRATION_KEY, record);
  return 'registered';
}

export interface UnregisterDeps {
  settings: Pick<SettingsRepo, 'get' | 'remove'>;
  /** Default: the app client, loaded on first use. */
  supabase?: DevicesClient;
  budgetMs?: number;
}

/** The pre-sign-out task: release this phone's token from the signed-in account. Never throws. */
export async function unregisterPushToken(deps: UnregisterDeps): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, deps.budgetMs ?? UNREGISTER_BUDGET_MS);
  });

  const release = async (): Promise<void> => {
    // Captured now: nothing read later can point this at another account's token.
    const registration = parseRegistration(await deps.settings.get<unknown>(PUSH_REGISTRATION_KEY));
    if (!registration) return;
    await deps.settings.remove(PUSH_REGISTRATION_KEY);
    const supabase =
      deps.supabase ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only when used
      (require('@/data/supabase/client') as typeof import('@/data/supabase/client')).supabase;
    const { data } = await supabase.auth.getSession();
    if (controller.signal.aborted || data.session?.user.id !== registration.userId) return;
    await supabase
      .rpc('unregister_push_token', { p_token: registration.token })
      .abortSignal(controller.signal);
  };

  try {
    await Promise.race([release().catch(() => {}), budget]);
  } finally {
    clearTimeout(timer);
  }
}
