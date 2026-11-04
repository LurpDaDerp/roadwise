/**
 * The car link as the screens read it (iPhone only): `unsupported` on Android, or a native build
 * without it; `loading` until the first read; else the state. Read when a screen using it comes into
 * focus and when RoadWise returns to the front, and kept fresh by the native `carLink` event while
 * mounted (connecting the phone to the car while the pairing screen is open shows at once). Pairing
 * a car asks for Bluetooth once, after the car is paired (`bluetoothAsk.ts`); with `askIfPaired`
 * (the Settings surfaces), a car paired before that ask existed is asked for as the state reads.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import type { CarLinkState } from '@drive-sense';
import { useDb } from '@/data/queries/context';

import { askBluetoothOnPair } from './bluetoothAsk';
import { forgetCar, notMyCar, onCarLink, pairCar, readCarLink } from './port';

export type CarLinkView = { status: 'loading' } | { status: 'unsupported' } | { status: 'ready'; state: CarLinkState };

export function useCarLink(opts: { askIfPaired?: boolean } = {}) {
  const ios = Platform.OS === 'ios';
  const db = useDb();
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

  // A car already paired (before pairing asked for Bluetooth): asked once here, never during a drive.
  const askIfPaired = opts.askIfPaired === true;
  const paired = view.status === 'ready' && view.state.cars.length > 0;
  const askedHere = useRef(false);
  useEffect(() => {
    if (!askIfPaired || !paired || askedHere.current) return;
    askedHere.current = true;
    void askBluetoothOnPair(db).catch(() => {});
  }, [askIfPaired, paired, db]);

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
    pair: async (uid: string) => {
      // The pairing asks itself (below): the screen's own ask for a paired car is not needed here.
      askedHere.current = true;
      const next = await act(() => pairCar(uid));
      // Paired: the one-time Bluetooth ask, which never holds or undoes the pairing.
      if (next !== null && next.cars.some((c) => c.uid === uid)) void askBluetoothOnPair(db).catch(() => {});
      return next;
    },
    forget: (uid: string) => act(() => forgetCar(uid)),
    notMine: (uid: string) => act(() => notMyCar(uid)),
  };
}
