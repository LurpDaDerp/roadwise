import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
 *
 * `enabled: false` (a static look in Settings › Appearance, or the choice not read yet) stops all
 * of it: no position read, no weather request, no timers, and a read already waiting on the position
 * asks for no weather once it answers. Turned back on, the very render that turns it on already
 * wears the phase of that moment (and drops a weather answer over 3 h old, as a cold start would),
 * then it reads the sun and the weather again at once.
 */
export function useSkyMood(ports: SkyPorts, { enabled = true }: { enabled?: boolean } = {}): SkyMood {
  const [place, setPlace] = useState<Place | null>(null);
  const [weather, setWeather] = useState<SkyWeather>(CLEAR);
  // When the answer on show was fetched (0 for none), so a stale one is not shown on turning back on.
  const [weatherAt, setWeatherAt] = useState(0);
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
        if (c.weather && clock() - c.fetchedAt < WEATHER_STALE_MS) {
          setWeather(c.weather);
          setWeatherAt(c.fetchedAt);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ports.storage, clock]);

  // Turned back on: this render already reads the phase now, not when it was last on, so the theme
  // is never handed the old hour's sky for a frame (React's "adjust state when a prop changes").
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (enabled) {
      const now = (ports.now ?? Date.now)();
      setAt(now);
      if (!(now - weatherAt < WEATHER_STALE_MS)) setWeather(CLEAR);
    }
  }

  // Updated as the change commits, so a read under way sees a turn-off before its answer lands.
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const refresh = useCallback(async () => {
    if (!enabledRef.current || busy.current || AppState.currentState === 'background') return;
    busy.current = true;
    try {
      const p = portsRef.current;
      const here = await p.position();
      // Turned off while the position was being read: no weather request for a static look.
      if (!here || !enabledRef.current) return;
      const rounded = { lat: roundCoord(here.lat), lng: roundCoord(here.lng) };
      setPlace((prev) => (prev && prev.lat === rounded.lat && prev.lng === rounded.lng ? prev : rounded));
      setAt(clock());
      const res = await skyWeatherFor(rounded, { now: clock(), cache: cache.current, fetch: p.fetch, save });
      cache.current = res.cache;
      setWeather((prev) => (prev.kind === res.weather.kind && prev.intensity === res.weather.intensity ? prev : res.weather));
      setWeatherAt(res.cache.fetchedAt);
    } finally {
      busy.current = false;
    }
  }, [save, clock]);

  // On mount, when turned back on, and every time RoadWise comes back to the front.
  useEffect(() => {
    if (!enabled) return;
    const wake = () => {
      setAt(clock());
      void refresh();
    };
    wake();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') wake();
    });
    return () => sub.remove();
  }, [enabled, refresh, clock]);

  // A weather answer that expires while RoadWise is on screen is asked again once.
  useEffect(() => {
    if (!enabled) return;
    const c = cache.current;
    if (!c || !c.weather) return;
    const wait = Math.max(60_000, c.fetchedAt + WEATHER_TTL_MS - clock());
    const timer = setTimeout(() => void refresh(), Math.min(wait, MAX_SLEEP_MS));
    return () => clearTimeout(timer);
  }, [enabled, weather, refresh, clock]);

  // The phase is read again at its next boundary (every 10 min inside a twilight window).
  useEffect(() => {
    if (!enabled) return;
    const wait = Math.max(1_000, Math.min(reading.nextAt - clock(), MAX_SLEEP_MS));
    const timer = setTimeout(() => setAt(clock()), wait);
    return () => clearTimeout(timer);
  }, [enabled, reading, clock]);

  return useMemo(
    () => ({ phase: reading.phase, glow: reading.glow, weather }),
    [reading.phase, reading.glow, weather]
  );
}
