/**
 * The two tokens read for `register_device`: the Expo push token (never without notification
 * permission, never from a simulator) and, on iOS 17.2 or later, the Live Activity push-to-start
 * token. Tokens are kept on the phone only (settings) to compare; they are never logged.
 */
export const PUSH_TOKEN_KEY = 'device.pushToken';

/** The server's own pattern (0001 `devices.push_token`). */
export const TOKEN_PATTERN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

/** The OS side, behind a port so tests never touch expo-notifications. */
export interface PushPort {
  isDevice(): boolean;
  /** Notification permission granted (or iOS provisional). Never asks. */
  permitted(): Promise<boolean>;
  getExpoPushToken(projectId: string | null): Promise<string>;
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

/** The EAS project id, from the app config, for `getExpoPushTokenAsync`. */
export function easProjectId(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded on first use
    const Constants = (require('expo-constants') as typeof import('expo-constants')).default;
    const id = Constants.expoConfig?.extra?.eas?.projectId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** The token to register, or null: not a device, no permission, or no token to be had. Never throws. */
export async function readPushToken(port: PushPort, projectId: string | null, onError?: (e: unknown) => void): Promise<string | null> {
  try {
    if (!port.isDevice()) return null;
    if (!(await port.permitted())) return null;
    const token = await port.getExpoPushToken(projectId);
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch (error) {
    onError?.(error instanceof Error ? new Error(error.name) : new Error('push token unavailable'));
    return null;
  }
}

/** The server's own pattern for a Live Activity token (0024 `devices.live_activity_token`): lowercase hex. */
export const LIVE_ACTIVITY_TOKEN_PATTERN = /^[0-9a-f]{32,200}$/;

/** The Live Activity push-to-start token, behind a port so tests never touch the native module. */
export interface LiveActivityTokenPort {
  /** The token the system issued (hex), or null: not iOS 17.2+, none issued yet, or no module. Never asks. */
  getToken(): Promise<string | null>;
  /** The system issued a new token. */
  addTokenListener(listener: () => void): { remove(): void };
}

/** What this layer uses of the live-drive module (`modules/live-drive`); read loosely, every part optional. */
interface LiveDriveTokenSource {
  getPushToStartToken?: () => Promise<unknown>;
  addListener?: (event: 'pushToStartToken', listener: (payload: unknown) => void) => { remove(): void } | undefined;
}

/** The live-drive module, loaded on first use. Where it has no token (Android, Expo Go, Jest) the token is null. */
export function createLiveDriveTokenPort(): LiveActivityTokenPort {
  const source = (): LiveDriveTokenSource | null => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a native module, loaded on first use
      const mod = require('@live-drive') as { default?: unknown };
      const api = mod.default;
      return typeof api === 'object' && api !== null ? (api as LiveDriveTokenSource) : null;
    } catch {
      return null;
    }
  };
  return {
    async getToken() {
      const api = source();
      if (!api || typeof api.getPushToStartToken !== 'function') return null;
      const token = await api.getPushToStartToken();
      return typeof token === 'string' ? token : null;
    },
    addTokenListener(listener) {
      const api = source();
      if (!api || typeof api.addListener !== 'function') return { remove() {} };
      return api.addListener('pushToStartToken', () => listener()) ?? { remove() {} };
    },
  };
}

/** The Live Activity token to register (lowercase hex in the server's pattern), or null. Never throws. */
export async function readLiveActivityToken(port: LiveActivityTokenPort, onError?: (e: unknown) => void): Promise<string | null> {
  try {
    const token = (await port.getToken())?.toLowerCase() ?? null;
    return token !== null && LIVE_ACTIVITY_TOKEN_PATTERN.test(token) ? token : null;
  } catch (error) {
    onError?.(error instanceof Error ? new Error(error.name) : new Error('live activity token unavailable'));
    return null;
  }
}
