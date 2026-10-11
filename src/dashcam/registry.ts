// The DashPal runtime the screens read: bootstrap registers the live one (and clears it on teardown),
// so the settings screen, the setup flow, the HUD chip and the prompt host need no provider of their
// own and follow a handover rebuild.
import type { DashcamRuntime } from './runtime';

let current: DashcamRuntime | null = null;
const listeners = new Set<() => void>();

export function setActiveDashcam(runtime: DashcamRuntime | null): void {
  if (current === runtime) return;
  current = runtime;
  for (const fn of [...listeners]) fn();
}

export const activeDashcam = (): DashcamRuntime | null => current;

export function subscribeActiveDashcam(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
