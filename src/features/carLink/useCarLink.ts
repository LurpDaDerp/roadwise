/**
 * The car link as the screens read it (iPhone and Android): `unsupported` on web or a native build
 * without it (`DriveDetect.carLinkAvailable` false: the read answers null); `loading` until the
 * first read; else the state. Read when a screen using it comes into focus and when RoadWise returns
 * to the front, and kept fresh by the native `carLink` event while mounted (connecting the phone to
 * the car while the pairing screen is open shows at once). On Android 12+ pairing asks for Nearby
 * devices first, once, so the car is paired by its full Bluetooth address (ruling 14); on iPhone it
 * asks for Bluetooth once, after the car is paired (`bluetoothAsk.ts`), and with `askIfPaired` (the
 * Settings surfaces) a car paired before that ask existed is asked for as the state reads.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import type { CarLinkState } from '@drive-sense';
import { useDb } from '@/data/queries/context';

import { askBluetoothBeforePair, askBluetoothOnPair } from './bluetoothAsk';
import { forgetCar, notMyCar, onCarLink, pairCar, readCarLink } from './port';

export type CarLinkView = { status: 'loading' } | { status: 'unsupported' } | { status: 'ready'; state: CarLinkState };

export function useCarLink(opts: { askIfPaired?: boolean } = {}) {
  // Both phones read it; a native build without the car link answers null (unsupported).
  const native = Platform.OS === 'ios' || Platform.OS === 'android';
  const db = useDb();
  const [view, setView] = useState<CarLinkView>(native ? { status: 'loading' } : { status: 'unsupported' });
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  const take = useCallback((s: CarLinkState | null) => {
    if (alive.current) setView(s === null ? { status: 'unsupported' } : { status: 'ready', state: s });
  }, []);
  const reread = useCallback(() => {
    if (native) void readCarLink().then(take);
  }, [native, take]);

  useEffect(() => {
    alive.current = true;
    if (!native) return;
    const off = onCarLink(take);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') reread();
    });
    return () => {
      alive.current = false;
      off();
      sub.remove();
    };
  }, [native, reread, take]);
  useFocusEffect(reread);

  // iPhone: a car already paired (before pairing asked for Bluetooth): asked once here, never during
  // a drive. Android asks before each pairing instead (`pair`).
  const askIfPaired = opts.askIfPaired === true && Platform.OS === 'ios';
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
      // Android 12+: Nearby devices first, so the car is paired by its full address; any answer pairs.
      if (Platform.OS === 'android') await askBluetoothBeforePair(db).catch(() => {});
      const next = await act(() => pairCar(uid));
      // iPhone, paired: the one-time Bluetooth ask, which never holds or undoes the pairing.
      if (Platform.OS === 'ios' && next !== null && next.cars.some((c) => c.uid === uid)) void askBluetoothOnPair(db).catch(() => {});
      return next;
    },
    forget: (uid: string) => act(() => forgetCar(uid)),
    notMine: (uid: string) => act(() => notMyCar(uid)),
  };
}
