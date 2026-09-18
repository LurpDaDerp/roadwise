// utils/weather.js
//
// Open-Meteo forecast + air quality, behind a coarse-grid cache.
//
// Both endpoints used to be called on the first GPS fix of EVERY drive, with no cache at all:
// a `useRef` throttle that resets on every mount. Stopping and restarting a drive three times
// cost six requests and up to three OpenAI road-condition summaries for weather that had not
// changed. The cache is keyed on a ~1 km cell (the same distance the drive session already uses
// as its "moved far enough to re-check" threshold) and persists across launches.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KEYS } from './storageKeys';

const CACHE_TTL_MS = 15 * 60 * 1000;   // conditions do not change on a shorter timescale
const CACHE_MAX_CELLS = 8;
const CELL_DECIMALS = 2;               // ~1.1 km

/** cell key -> { at, data } */
const memory = new Map();
/** cell key -> in-flight promise, so two fixes in the same cell make one request */
const inFlight = new Map();
let hydrated = false;

function cellKey(lat, lon) {
  return `${Number(lat).toFixed(CELL_DECIMALS)},${Number(lon).toFixed(CELL_DECIMALS)}`;
}

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(KEYS.weatherCache);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const entry of list) {
      if (!entry || typeof entry.key !== 'string') continue;
      if (!entry.at || now - entry.at > CACHE_TTL_MS) continue;
      memory.set(entry.key, { at: entry.at, data: entry.data });
    }
  } catch {
    // an unreadable cache is simply a cold one
  }
}

async function persist() {
  try {
    const list = Array.from(memory.entries())
      .map(([key, value]) => ({ key, at: value.at, data: value.data }))
      .slice(-CACHE_MAX_CELLS);
    await AsyncStorage.setItem(KEYS.weatherCache, JSON.stringify(list));
  } catch {
    // best effort
  }
}

async function request(lat, lon) {
  // Weather API
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,precipitation_probability,visibility,windspeed_10m,weathercode&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch&timezone=auto`;

  // Air Quality API
  const airQualityUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm10,pm2_5,carbon_monoxide,ozone,uv_index,us_aqi&timezone=auto`;

  const [weatherRes, airRes] = await Promise.all([fetch(weatherUrl), fetch(airQualityUrl)]);

  if (!weatherRes.ok) throw new Error('Weather fetch failed');
  if (!airRes.ok) throw new Error('Air quality fetch failed');

  const [weather, airQuality] = await Promise.all([weatherRes.json(), airRes.json()]);
  return { ...weather, airQuality };
}

export async function fetchWeather(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const key = cellKey(lat, lon);

  await hydrate();
  const cached = memory.get(key);
  if (cached && Date.now() - cached.at <= CACHE_TTL_MS) return cached.data;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = (async () => {
    try {
      const data = await request(lat, lon);
      memory.set(key, { at: Date.now(), data });
      while (memory.size > CACHE_MAX_CELLS) memory.delete(memory.keys().next().value);
      persist();
      return data;
    } catch (err) {
      console.error('Weather fetch error:', err);
      // A stale entry beats no conditions at all when the network is gone.
      return cached ? cached.data : null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, run);
  return run;
}

