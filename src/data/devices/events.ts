/**
 * "Sync the device now": raised by a screen that has just changed something the device row or the
 * push registration depends on (A8 after notification permission is granted), heard by the
 * mounted `DeviceHost`, which registers the push token. In-process only; nothing is queued while
 * no host listens.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function requestDeviceSync(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // one listener's failure costs the others nothing
    }
  }
}

/** Returns the unsubscribe. */
export function onDeviceSyncRequested(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
