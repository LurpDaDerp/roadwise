// The typed JS face of the native live-drive module (iOS Live Activity). Arguments are checked
// before they cross the bridge; where the native module is absent (Android, Jest, Expo Go, web)
// every method resolves as "unsupported" rather than rejecting, because a missing Live Activity
// must never affect a drive.
import { requireOptionalNativeModule } from 'expo-modules-core';
import { z } from 'zod';
import type { LiveDriveApi, LiveDriveState } from './types';

export * from './types';
export { createFakeLiveDrive } from './fake';

type NativeModule = {
  isSupported(): Promise<unknown>;
  start(state: LiveDriveState): Promise<unknown>;
  update(state: LiveDriveState): Promise<unknown>;
  end(): Promise<unknown>;
};

const native = requireOptionalNativeModule<NativeModule>('LiveDrive');

/** A colour: "#RRGGBB", null or absent. */
const skyHex = z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional();

export const liveDriveStateSchema: z.ZodType<LiveDriveState> = z.strictObject({
  speed: z.number().nullable(),
  limit: z.number().nullable(),
  unit: z.enum(['mph', 'km/h']),
  points: z.number().nullable(),
  pointsDelta: z.number().nullable(),
  stopped: z.boolean(),
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

const LiveDrive: LiveDriveApi = {
  async isSupported() {
    if (!native) return false;
    return (await native.isSupported()) === true;
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
};

export default LiveDrive;
