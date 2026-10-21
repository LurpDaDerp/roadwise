// The typed JS face of the native live-drive module (iOS Live Activity). Arguments are checked
// before they cross the bridge; where the native module is absent (Android, Jest, Expo Go, web)
// every method resolves as "unsupported" rather than rejecting, because a missing Live Activity
// must never affect a drive.
import { requireOptionalNativeModule } from 'expo-modules-core';
import { z } from 'zod';
import type { LiveDriveApi, LiveDriveEvent, LiveDriveEvents, LiveDriveState, LiveDriveSubscription } from './types';

export * from './types';
export { createFakeLiveDrive } from './fake';

type NativeModule = {
  isSupported(): Promise<unknown>;
  isRunning(): Promise<unknown>;
  getPushToStartToken(): Promise<unknown>;
  start(state: LiveDriveState): Promise<unknown>;
  update(state: LiveDriveState): Promise<unknown>;
  end(): Promise<unknown>;
  addListener(event: string, fn: (payload: unknown) => void): LiveDriveSubscription;
};

const native = requireOptionalNativeModule<NativeModule>('LiveDrive');

/** A colour: "#RRGGBB", null or absent. */
const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const skyHex = hex.nullable().optional();

/** A push-to-start token: lowercase hex, as the server stores it. */
export const PUSH_TOKEN = /^[0-9a-f]{32,200}$/;

export const liveDriveStateSchema: z.ZodType<LiveDriveState> = z.strictObject({
  speed: z.number().nullable(),
  limit: z.number().nullable(),
  unit: z.enum(['mph', 'km/h']),
  speedTint: hex.nullable(),
  speeding: z.boolean(),
  notDrivingAvailable: z.boolean(),
  weatherKind: z.string().regex(/^[a-z][a-z_]{0,31}$/).nullable(),
  weatherText: z.string().min(1).max(60).nullable(),
  skyTop: skyHex,
  skyMid: skyHex,
  skyLow: skyHex,
  accent: skyHex,
});

function checked(method: string, state: LiveDriveState): LiveDriveState {
  const parsed = liveDriveStateSchema.safeParse(state);
  if (!parsed.success) throw new Error(`LiveDrive.${method}: invalid state ${JSON.stringify(state)}`);
  return parsed.data;
}

const tokenOf = (v: unknown): string | null => (typeof v === 'string' && PUSH_TOKEN.test(v) ? v : null);

const LiveDrive: LiveDriveApi = {
  async isSupported() {
    if (!native) return false;
    return (await native.isSupported()) === true;
  },
  async isRunning() {
    if (!native) return false;
    return (await native.isRunning()) === true;
  },
  async getPushToStartToken() {
    if (!native) return null;
    return tokenOf(await native.getPushToStartToken());
  },
  async start(state) {
    const s = checked('start', state);
    if (!native) return false;
    return (await native.start(s)) === true;
  },
  async update(state) {
    const s = checked('update', state);
    if (!native) return;
    await native.update(s);
  },
  async end() {
    if (!native) return;
    await native.end();
  },
  addListener<E extends LiveDriveEvent>(event: E, fn: (payload: LiveDriveEvents[E]) => void): LiveDriveSubscription {
    if (!native) return { remove() {} };
    return native.addListener(event, (raw) => {
      const token = tokenOf((raw as { token?: unknown } | null)?.token);
      if (token !== null) fn({ token } as LiveDriveEvents[E]);
    });
  },
};

export default LiveDrive;
