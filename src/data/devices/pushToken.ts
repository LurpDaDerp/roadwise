/**
 * The Expo push token, read for `register_device`: never without notification permission, never
 * from a simulator. The token is kept on the phone only (settings) to compare; it is never logged.
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
