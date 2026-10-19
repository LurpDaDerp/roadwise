import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useOptionalDb } from '@/data/queries/context';

import { dangerFrom, isDangerKind, type DangerAlert, type DangerKind } from './danger';
import { fetchWeather, type FetchLike } from './openMeteo';
import { lastKnownPlace, type Place } from './ports';

/** Home asks again at most this often (on focus and when RoadWise comes to the front). */
export const HOME_WEATHER_REFRESH_MS = 15 * 60_000;
/** The settings key holding the kind of alert the driver hid on Home. */
export const WEATHER_DISMISSED_KEY = 'weather.dismissed';

export type WeatherPorts = {
  /** A position the phone already holds; must never prompt. */
  position: () => Promise<Place | null>;
  fetch?: FetchLike;
  now?: () => number;
};

/** Where Home keeps the hidden alert's kind, so it stays hidden after a restart. */
export type DismissStore = {
  read: () => Promise<DangerKind | null>;
  write: (kind: DangerKind | null) => Promise<void>;
};

export const defaultWeatherPorts: WeatherPorts = { position: lastKnownPlace };

const memoryStore = (): DismissStore => {
  let kind: DangerKind | null = null;
  return {
    read: async () => kind,
    write: async (k) => {
      kind = k;
    },
  };
};

/** The settings repo when a database is mounted, else a store that lasts as long as the screen. */
function useDismissStore(): DismissStore {
  const db = useOptionalDb();
  return useMemo(() => {
    if (db === null) return memoryStore();
    const repo = createSettingsRepo(db);
    return {
      read: async () => {
        const v = await repo.get<unknown>(WEATHER_DISMISSED_KEY).catch(() => null);
        return isDangerKind(v) ? v : null;
      },
      write: async (kind) => {
        await (kind === null ? repo.remove(WEATHER_DISMISSED_KEY) : repo.set(WEATHER_DISMISSED_KEY, kind)).catch(() => {});
      },
    };
  }, [db]);
}

export type HomeWeather = {
  /** The alert to show: the most severe danger now or in the next 2 hours, unless hidden. */
  alert: DangerAlert | null;
  /** Hide it until that danger ends or a different one starts. */
  dismiss: () => void;
};

/**
 * Home's dangerous-weather alert. Asked when Home comes into view and when RoadWise returns to
 * the front, at most every 15 min. Silent on any failure: no position, no network, a bad answer.
 * A hidden alert stays hidden (across restarts) until a reading says its danger has ended or a
 * different one has begun.
 */
export function useWeatherAlert(ports: WeatherPorts = defaultWeatherPorts, injected?: DismissStore): HomeWeather {
  const fallback = useDismissStore();
  const store = injected ?? fallback;
  const [alert, setAlert] = useState<DangerAlert | null>(null);
  const [dismissed, setDismissed] = useState<DangerKind | null>(null);
  // `undefined`: no reading yet (the stored dismissal can't be judged before one).
  const latest = useRef<DangerAlert | null | undefined>(undefined);
  const hidden = useRef<DangerKind | null>(null);
  const lastAsk = useRef<number | null>(null);
  const busy = useRef(false);
  const live = useRef(true);
  const portsRef = useRef(ports);
  const storeRef = useRef(store);
  useEffect(() => {
    portsRef.current = ports;
    storeRef.current = store;
  }, [ports, store]);

  /** A hidden alert ends with its danger: a reading without it (nothing, or another danger). */
  const reconcile = useCallback(() => {
    const now = latest.current;
    if (now === undefined || hidden.current === null) return;
    if (now === null || now.kind !== hidden.current) {
      hidden.current = null;
      if (live.current) setDismissed(null);
      void storeRef.current.write(null).catch(() => {});
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void store
      .read()
      .then((kind) => {
        if (!live.current || hidden.current !== null || kind === null) return;
        hidden.current = kind;
        setDismissed(kind);
        reconcile();
      })
      .catch(() => {});
    return () => {
      live.current = false;
    };
  }, [store, reconcile]);

  const refresh = useCallback(async () => {
    const p = portsRef.current;
    const now = (p.now ?? Date.now)();
    if (busy.current || AppState.currentState === 'background') return;
    if (lastAsk.current !== null && now - lastAsk.current < HOME_WEATHER_REFRESH_MS) return;
    busy.current = true;
    try {
      const place = await p.position().catch(() => null);
      if (place === null) return;
      lastAsk.current = now;
      const reading = await fetchWeather(place.lat, place.lng, { fetch: p.fetch });
      if (!live.current) return;
      // A failed ask says nothing: no alert, and a hidden one stays hidden.
      if (reading === null) {
        setAlert(null);
        return;
      }
      const next = dangerFrom(reading);
      latest.current = next;
      setAlert(next);
      reconcile();
    } finally {
      busy.current = false;
    }
  }, [reconcile]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const dismiss = useCallback(() => {
    const kind = latest.current?.kind ?? null;
    if (kind === null) return;
    hidden.current = kind;
    setDismissed(kind);
    void storeRef.current.write(kind).catch(() => {});
  }, []);

  return { alert: alert !== null && alert.kind !== dismissed ? alert : null, dismiss };
}
