// In-memory live-drive for tests: one activity at a time, started only by `start`, gone on `end`.
import type { LiveDriveApi, LiveDriveFakeControls, LiveDriveState } from './types';

export function createFakeLiveDrive(opts: { supported?: boolean } = {}): LiveDriveApi & LiveDriveFakeControls {
  let supported = opts.supported ?? true;
  let active: LiveDriveState | null = null;
  const calls: string[] = [];
  const api: LiveDriveApi & LiveDriveFakeControls = {
    isSupported() {
      calls.push('isSupported');
      return Promise.resolve(supported);
    },
    start(state) {
      calls.push('start');
      active = supported ? { ...state } : null;
      return Promise.resolve(active !== null);
    },
    update(state) {
      calls.push('update');
      if (active) active = { ...state };
      return Promise.resolve();
    },
    end() {
      calls.push('end');
      active = null;
      return Promise.resolve();
    },
    setSupported(s) {
      supported = s;
      if (!s) active = null;
    },
    get active() {
      return active ? { ...active } : null;
    },
    calls,
  };
  return api;
}
