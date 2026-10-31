/**
 * The car link as the screens read it (iPhone only): `unsupported` on Android, or a native build
 * without it; `loading` until the first read; else the state. Read when a screen using it comes into
 * focus and when RoadWise returns to the front, and kept fresh by the native `carLink` event while
 * mounted (connecting the phone to the car while the pairing screen is open shows at once).
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import type { CarLinkState } from '@drive-sense';

import { forgetCar, notMyCar, onCarLink, pairCar, readCarLink } from './port';

export type CarLinkView = { status: 'loading' } | { status: 'unsupported' } | { status: 'ready'; state: CarLinkState };

export function useCarLink() {
  const ios = Platform.OS === 'ios';
  const [view, setView] = useState<CarLinkView>(ios ? { status: 'loading' } : { status: 'unsupported' });
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  const take = useCallback((s: CarLinkState | null) => {
    if (alive.current) setView(s === null ? { status: 'unsupported' } : { status: 'ready', state: s });
  }, []);
  const reread = useCallback(() => {
    if (ios) void readCarLink().then(take);
  }, [ios, take]);

  useEffect(() => {
    alive.current = true;
    if (!ios) return;
    const off = onCarLink(take);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') reread();
    });
    return () => {
      alive.current = false;
      off();
      sub.remove();
    };
  }, [ios, reread, take]);
  useFocusEffect(reread);

  /** One of the driver's taps; a failure keeps the state as it was and says so. */
  const act = useCallback(
    async (run: () => Promise<CarLinkState | null>): Promise<CarLinkState | null> => {
      const next = await run();
      if (!alive.current) return next;
      setFailed(next === null);
      if (next !== null) take(next);
      return next;
    },
    [take]
  );

  return {
    view,
    failed,
    pair: (uid: string) => act(() => pairCar(uid)),
    forget: (uid: string) => act(() => forgetCar(uid)),
    notMine: (uid: string) => act(() => notMyCar(uid)),
  };
}
