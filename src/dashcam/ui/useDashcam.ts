// The screens' view of DashPal: the live runtime (registered by bootstrap) and its state.
import { useCallback, useRef, useSyncExternalStore } from 'react';

import { activeDashcam, subscribeActiveDashcam } from '../registry';
import type { DashcamRuntime, DashcamState } from '../runtime';

export function useDashcamRuntime(): DashcamRuntime | null {
  return useSyncExternalStore(subscribeActiveDashcam, activeDashcam, activeDashcam);
}

/**
 * A slice of the runtime's state (null without a runtime). The slice is compared by value, so a
 * selector re-renders only when what it picked changes (the HUD chip is not redrawn per STATUS).
 */
export function useDashcamSelector<T>(select: (s: DashcamState | null) => T): T {
  const runtime = useDashcamRuntime();
  const last = useRef<{ key: string; value: T } | null>(null);
  const subscribe = useCallback((fn: () => void) => (runtime ? runtime.subscribe(() => fn()) : () => {}), [runtime]);
  const read = useCallback(() => {
    const value = select(runtime ? runtime.state() : null);
    const key = JSON.stringify(value) ?? 'undefined';
    if (last.current && last.current.key === key) return last.current.value;
    last.current = { key, value };
    return value;
  }, [runtime, select]);
  return useSyncExternalStore(subscribe, read, read);
}
