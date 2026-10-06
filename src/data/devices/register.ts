/**
 * `register_device` (plan §4): this install's row under the signed-in account — platform and, when
 * notifications are permitted, the Expo push token — and the one answer the app keeps:
 * `league_eligible` (the first account to register a device claims it). Called on sign-in and on
 * foreground, throttled to once every 6 hours unless the token changed.
 */
import type { SettingsRepo } from '@/data/db/settings';

export const LAST_REGISTER_KEY = 'device.lastRegister';
export const LEAGUE_ELIGIBLE_KEY = 'device.leagueEligible';
export const REGISTER_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface RegisterDeps {
  rpc: Rpc;
  settings: Pick<SettingsRepo, 'get' | 'set'>;
  userId: string;
  deviceId: string;
  platform: 'ios' | 'android';
  pushToken: string | null;
  now: () => number;
  force?: boolean;
  onError?: (error: unknown, context: string) => void;
}

export type RegisterResult = 'saved' | 'throttled' | 'error';

interface LastRegister {
  userId: string;
  deviceId: string;
  at: number;
  token: string | null;
}

function parseLast(raw: unknown): LastRegister | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.userId !== 'string' || typeof r.deviceId !== 'string' || typeof r.at !== 'number') return null;
  return { userId: r.userId, deviceId: r.deviceId, at: r.at, token: typeof r.token === 'string' ? r.token : null };
}

/** The cached `league_eligible` for `userId`, or null before the first registration answered. */
export async function readLeagueEligible(settings: Pick<SettingsRepo, 'get'>, userId: string): Promise<boolean | null> {
  const raw = await settings.get<unknown>(LEAGUE_ELIGIBLE_KEY);
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return r.userId === userId && typeof r.eligible === 'boolean' ? r.eligible : null;
}

/** A PostgREST error object as an `Error`, carrying its code only (never a row or a token). */
export function asError(error: unknown, message: string): Error {
  if (error instanceof Error) return error;
  const code =
    error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  return new Error(code ? `${message} (${code})` : message);
}

/** The sign-out's own budget for the release (the session's before-sign-out tasks share 2 s). */
export const RELEASE_BUDGET_MS = 2_000;

export interface ReleaseDeps {
  rpc: Rpc;
  settings: Pick<SettingsRepo, 'get' | 'set' | 'remove'>;
  /** This install's id, read at task start; null when the device was never registered. */
  deviceId: string | null;
  budgetMs?: number;
  onError?: (error: unknown, context: string) => void;
}

/**
 * Before the session ends at sign-out: `release_device(p_device_id)` clears this install's push
 * token on the server, so the next holder of the phone never sees this driver's pushes (security
 * audit, Important 1). Bounded, failure tolerated (Expo's `DeviceNotRegistered` and the next
 * account's `register_device` are the backstops); the local registration stamp is cleared so a
 * return registers afresh.
 */
export async function releaseDevice(deps: ReleaseDeps): Promise<'released' | 'skipped' | 'failed'> {
  const { deviceId } = deps;
  if (deviceId === null) return 'skipped';
  await deps.settings.remove(LAST_REGISTER_KEY).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<'failed'>((resolve) => {
    timer = setTimeout(() => resolve('failed'), deps.budgetMs ?? RELEASE_BUDGET_MS);
  });
  try {
    return await Promise.race([
      deps.rpc('release_device', { p_device_id: deviceId }).then(
        () => 'released' as const,
        (error: unknown) => {
          deps.onError?.(asError(error, 'release_device failed'), 'release device');
          return 'failed' as const;
        }
      ),
      budget,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True while this account's registration from this install is under 6 hours old. Checked before
 * the push token is read on a plain foreground, so a throttled foreground costs no Expo call (a
 * new token arrives through the token listener, which forces a registration anyway).
 */
export async function registeredRecently(
  settings: Pick<SettingsRepo, 'get'>,
  userId: string,
  deviceId: string,
  now: number
): Promise<boolean> {
  const last = parseLast(await settings.get<unknown>(LAST_REGISTER_KEY));
  return last !== null && last.userId === userId && last.deviceId === deviceId && last.at <= now && now - last.at < REGISTER_INTERVAL_MS;
}

export async function registerDevice(deps: RegisterDeps): Promise<RegisterResult> {
  const { settings, userId, deviceId } = deps;
  const now = deps.now();
  const last = parseLast(await settings.get<unknown>(LAST_REGISTER_KEY));
  const same = last !== null && last.userId === userId && last.deviceId === deviceId;
  if (!deps.force && same && last.token === deps.pushToken && last.at <= now && now - last.at < REGISTER_INTERVAL_MS) return 'throttled';

  let eligible: boolean | null = null;
  try {
    const args: Record<string, unknown> = { p_device_id: deviceId, p_platform: deps.platform };
    if (deps.pushToken !== null) args.p_push_token = deps.pushToken;
    const answer = await deps.rpc('register_device', args);
    const r = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
    eligible = typeof r.league_eligible === 'boolean' ? r.league_eligible : null;
  } catch (error) {
    deps.onError?.(asError(error, 'register_device failed'), 'register device');
    return 'error';
  }
  const stamp: LastRegister = { userId, deviceId, at: now, token: deps.pushToken };
  await settings.set(LAST_REGISTER_KEY, stamp);
  if (eligible !== null) await settings.set(LEAGUE_ELIGIBLE_KEY, { userId, eligible });
  return 'saved';
}
