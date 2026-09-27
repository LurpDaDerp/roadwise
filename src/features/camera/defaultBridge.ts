// The camera bridge as the app builds it (bootstrap). Everything heavy is deferred: the DMS controller (and with it
// the native camera module), the alert ports and the battery reads load only at the first drive of a driver who opted
// in, so a launch, a background wake or a driver without the beta pays nothing.
import { createSettingsProfileStore } from '@/core/dms/host/profileStore';
import type { Db } from '@/data/db/driver';
import { readFlag } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';
import { voicePrefEnabled } from '@/features/settings/alerts/voicePref';

import { createCameraBridge, type CameraBridge } from './bridge';
import { setCameraBridge } from './runtime';

export interface DefaultCameraBridgeDeps {
  db: Db;
  appState: AppStateLike & { currentState?: string | null };
  readUid(): Promise<string | null>;
  readAgeBand(): Promise<string | null>;
  onError?(e: unknown, ctx: string): void;
}

/**
 * Battery for the capture policy: read once when the first controller is made, then kept fresh by the OS's events.
 * Review LB-1: expo-battery gives a FRACTION (0–1); the policy's `batteryLevel` is a PERCENT (LOW_BATTERY_PCT 20), so
 * the level is converted here. A fraction passed on capped every unplugged drive at 8 fps.
 */
export function toPercent(fraction: number): number | null {
  return fraction >= 0 && fraction <= 1 ? Math.round(fraction * 100) : null;
}

export function batteryWatch(onError: (e: unknown) => void) {
  const state = { level: null as number | null, charging: null as boolean | null };
  let started = false;
  return {
    /** starts once; the returned promise settles when the first reading is in (tests) */
    start(): Promise<void> {
      if (started) return Promise.resolve();
      started = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
        const Battery = require('expo-battery') as typeof import('expo-battery');
        const charging = (b: number) => b === Battery.BatteryState.CHARGING || b === Battery.BatteryState.FULL;
        Battery.addBatteryLevelListener(({ batteryLevel }) => {
          state.level = toPercent(batteryLevel);
        });
        Battery.addBatteryStateListener(({ batteryState }) => {
          state.charging = charging(batteryState);
        });
        return Battery.getPowerStateAsync()
          .then((p) => {
            state.level = toPercent(p.batteryLevel);
            state.charging = charging(p.batteryState);
          })
          .catch(onError);
      } catch (e) {
        onError(e);
        return Promise.resolve();
      }
    },
    read: () => state,
  };
}

export function createDefaultCameraBridge(deps: DefaultCameraBridgeDeps): CameraBridge {
  const settings = createSettingsRepo(deps.db);
  const report = (e: unknown, ctx: string) => deps.onError?.(e, ctx);
  const battery = batteryWatch((e) => report(e, 'camera battery'));
  const bridge = createCameraBridge({
    settings,
    readUid: deps.readUid,
    readAgeBand: deps.readAgeBand,
    readCameraBeta: () => readFlag(deps.db, 'camera_beta', false),
    createController(handlers, uid) {
      void battery.start();
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: loads the native camera module
      const dms = require('@/core/dms') as typeof import('@/core/dms');
      return dms.createDefaultDmsController({
        ...handlers,
        profileStore: dms.createSettingsProfileStore(settings, uid),
        config: { gazeSource: 'geometric' },
      });
    },
    async createPorts() {
      const { createExpoAlertPorts } = await import('@/core/alerts/adapters');
      return createExpoAlertPorts();
    },
    voiceEnabled: voicePrefEnabled,
    appActive: () => (deps.appState.currentState ?? 'active') === 'active',
    subscribeAppState(fn) {
      const sub = deps.appState.addEventListener('change', () => fn());
      return () => sub.remove();
    },
    power() {
      const b = battery.read();
      const d = new Date();
      return { batteryLevel: b.level, charging: b.charging, localMinutes: d.getHours() * 60 + d.getMinutes() };
    },
    async clearProfile() {
      // The store's own module (light: no native code), so a sign-out never loads the camera.
      await createSettingsProfileStore(settings, '').clear();
    },
    onError: report,
  });
  setCameraBridge(bridge);
  return bridge;
}
