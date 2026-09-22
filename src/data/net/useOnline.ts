import { useSyncExternalStore } from 'react';

import { getSharedOnline, subscribeSharedOnline } from './net';

/**
 * Whether the device is online, for a screen that has something honest to say when it is not
 * (D2's route map). Re-renders on a change. `true` until the launch has read the network state —
 * an unread state is not evidence of being offline.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeSharedOnline, getSharedOnline, getSharedOnline);
}
