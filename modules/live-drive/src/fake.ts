// In-memory live-drive for tests: one activity at a time, started by `start` or by a push, updated
// (never replaced) by a later `start`, gone on `end`; a settable push-to-start token and its event.
import type { LiveDriveApi, LiveDriveEvent, LiveDriveEvents, LiveDriveFakeControls, LiveDriveState } from './types';

export function createFakeLiveDrive(opts: { supported?: boolean; token?: string | null } = {}): LiveDriveApi & LiveDriveFakeControls {
  let supported = opts.supported ?? true;
  let active: LiveDriveState | null = null;
  let token: string | null = opts.token ?? null;
  const calls: string[] = [];
  const tokenListeners = new Set<(p: LiveDriveEvents['pushToStartToken']) => void>();
  const api: LiveDriveApi & LiveDriveFakeControls = {
    isSupported() {
      calls.push('isSupported');
      return Promise.resolve(supported);
    },
    isRunning() {
      calls.push('isRunning');
      return Promise.resolve(active !== null);
    },
    getPushToStartToken() {
      calls.push('getPushToStartToken');
      return Promise.resolve(token);
    },
    start(state) {
      calls.push('start');
      // A running activity (a pushed one too) is updated, never replaced.
      if (active) active = { ...state };
      else active = supported ? { ...state } : null;
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
    addListener<E extends LiveDriveEvent>(_event: E, fn: (payload: LiveDriveEvents[E]) => void) {
      const listener = fn as (p: LiveDriveEvents['pushToStartToken']) => void;
      tokenListeners.add(listener);
      return { remove: () => void tokenListeners.delete(listener) };
    },
    setSupported(s) {
      supported = s;
      if (!s) active = null;
    },
    get active() {
      return active ? { ...active } : null;
    },
    pushStart(state) {
      active = { ...state };
    },
    setToken(t) {
      token = t;
    },
    emitToken(t) {
      token = t;
      for (const fn of [...tokenListeners]) fn({ token: t });
    },
    calls,
  };
  return api;
}
