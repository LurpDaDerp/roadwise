import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { SkyMood } from './palette';
import { readPhase, type Place } from './phase';
import {
  CLEAR,
  parseSkyCache,
  roundCoord,
  SKY_CACHE_KEY,
  skyWeatherFor,
  WEATHER_STALE_MS,
  WEATHER_TTL_MS,
  type FetchLike,
  type SkyCache,
  type SkyStorage,
  type SkyWeather,
} from './weather';

/**
 * Where the theme's sky comes from, as ports so the hook runs in tests without native modules.
 * `position` must never prompt: it reads a position the phone already holds, or null.
 */
export type SkyPorts = {
  position: () => Promise<Place | null>;
  storage: SkyStorage | null;
  fetch?: FetchLike;
  now?: () => number;
};

/** The longest the hook ever sleeps before looking at the sun again. */
const MAX_SLEEP_MS = 6 * 60 * 60_000;

/**
 * The live mood: the phase from the sun at the last known position (or the 07:00 / 19:00 clock),
 * and the weather there. Re-read when RoadWise comes to the front, at the next phase boundary
 * (every 10 min inside a twilight window), and when a weather answer expires while on screen.
 * No polling faster than that; nothing at all while RoadWise is in the background.
 */
export function useSkyMood(ports: SkyPorts): SkyMood {
  const [place, setPlace] = useState<Place | null>(null);
  const [weather, setWeather] = useState<SkyWeather>(CLEAR);
  // The moment the phase was last read; every re-read sets it, and the reading follows from it.
  const [at, setAt] = useState(() => (ports.now ?? Date.now)());
  const reading = useMemo(() => readPhase(new Date(at), place), [at, place]);
  const cache = useRef<SkyCache | null>(null);
  const busy = useRef(false);
  const portsRef = useRef(ports);
  useEffect(() => {
    portsRef.current = ports;
  }, [ports]);
  const clock = useCallback(() => (portsRef.current.now ?? Date.now)(), []);

  const save = useCallback((c: SkyCache) => {
    cache.current = c;
    void portsRef.current.storage?.setItem(SKY_CACHE_KEY, JSON.stringify(c)).catch(() => {});
  }, []);

  // The stored place and answer paint the first frames before any read finishes.
  useEffect(() => {
    let live = true;
    const store = ports.storage;
    if (!store) return;
    store
      .getItem(SKY_CACHE_KEY)
      .then((raw) => {
        const c = parseSkyCache(raw);
        if (!live || !c) return;
        cache.current = cache.current ?? c;
        setPlace((p) => p ?? { lat: c.lat, lng: c.lng });
        setAt(clock());
        if (c.weather && clock() - c.fetchedAt < WEATHER_STALE_MS) setWeather(c.weather);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ports.storage, clock]);

  const refresh = useCallback(async () => {
    if (busy.current || AppState.currentState === 'background') return;
    busy.current = true;
    try {
      const p = portsRef.current;
      const here = await p.position();
      if (!here) return;
      const rounded = { lat: roundCoord(here.lat), lng: roundCoord(here.lng) };
      setPlace((prev) => (prev && prev.lat === rounded.lat && prev.lng === rounded.lng ? prev : rounded));
      setAt(clock());
      const res = await skyWeatherFor(rounded, { now: clock(), cache: cache.current, fetch: p.fetch, save });
      cache.current = res.cache;
      setWeather((prev) => (prev.kind === res.weather.kind && prev.intensity === res.weather.intensity ? prev : res.weather));
    } finally {
      busy.current = false;
    }
  }, [save, clock]);

  // On mount and every time RoadWise comes back to the front.
  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        setAt(clock());
        void refresh();
      }
    });
    return () => sub.remove();
  }, [refresh, clock]);

  // A weather answer that expires while RoadWise is on screen is asked again once.
  useEffect(() => {
    const c = cache.current;
    if (!c || !c.weather) return;
    const wait = Math.max(60_000, c.fetchedAt + WEATHER_TTL_MS - clock());
    const timer = setTimeout(() => void refresh(), Math.min(wait, MAX_SLEEP_MS));
    return () => clearTimeout(timer);
  }, [weather, refresh, clock]);

  // The phase is read again at its next boundary (every 10 min inside a twilight window).
  useEffect(() => {
    const wait = Math.max(1_000, Math.min(reading.nextAt - clock(), MAX_SLEEP_MS));
    const timer = setTimeout(() => setAt(clock()), wait);
    return () => clearTimeout(timer);
  }, [reading, clock]);

  return useMemo(
    () => ({ phase: reading.phase, glow: reading.glow, weather }),
    [reading.phase, reading.glow, weather]
  );
}
