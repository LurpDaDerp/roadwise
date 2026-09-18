// Speed-limit lookup with a persistent grid cache and polyline back-fill.
// Moved out of DriveScreen unchanged in behaviour; the HERE call goes through
// utils/here.js (Cloud Function) as before.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchHereRevGeocode } from './here';
import { KEYS } from './storageKeys';

const GRID_RESOLUTION = 0.002;
const FILL_STEP_M = 80;
const FILL_WIDTH_M = 30;
export const MIN_SEG_TO_FILL_M = 120;
export const HEADING_TOL_DEG = 20;
export const MAX_SEG_LEN_M = 4000;
export const FETCH_MIN_INTERVAL_MS = 15000;
export const FETCH_MIN_DISTANCE_M = 250;

const cache = new Map();
let loaded = false;

export function getGridKey(lat, lon) {
  return `${Math.round(lat / GRID_RESOLUTION)}_${Math.round(lon / GRID_RESOLUTION)}`;
}

export function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function haversineM(a, b) {
  return getDistanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);
}

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function bearingDeg(a, b) {
  const φ1 = toRad(a.latitude);
  const φ2 = toRad(b.latitude);
  const Δλ = toRad(b.longitude - a.longitude);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function offsetPoint(lat, lon, bearing, distM) {
  const R = 6371000;
  const br = toRad(bearing);
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const dr = distM / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br));
  const lon2 =
    lon1 + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
  return { latitude: toDeg(lat2), longitude: toDeg(lon2) };
}

export async function loadSpeedLimitCache() {
  if (loaded) return;
  loaded = true;
  try {
    const cached = await AsyncStorage.getItem(KEYS.speedLimitCache);
    if (!cached) return;
    const entries = JSON.parse(cached);
    for (const [key, val] of entries) {
      if (val && typeof val === 'object' && 'valueKph' in val) {
        cache.set(key, val);
      } else if (typeof val === 'number') {
        cache.set(key, { valueKph: val * 1.60934, timestamp: Date.now() });
      } else if (val && typeof val === 'object' && 'value' in val && 'unit' in val) {
        const kph = val.unit === 'mph' ? val.value * 1.60934 : val.value;
        cache.set(key, { valueKph: kph, timestamp: Date.now(), street: val.street });
      }
    }
  } catch (err) {
    console.warn('Failed to load speed limit cache:', err);
  }
}

export async function saveSpeedLimitCache() {
  try {
    await AsyncStorage.setItem(KEYS.speedLimitCache, JSON.stringify(Array.from(cache.entries())));
  } catch (err) {
    console.warn('Failed to save speed limit cache:', err);
  }
}

export function getCachedLimit(lat, lon) {
  return cache.get(getGridKey(lat, lon)) || null;
}

export function setCachedLimit(lat, lon, valueKph, street) {
  cache.set(getGridKey(lat, lon), { valueKph, timestamp: Date.now(), street });
}

export async function fillCachePolyline(points, valueKph, street) {
  if (!points || points.length < 2) return;
  for (let s = 0; s < points.length - 1; s++) {
    const a = points[s];
    const b = points[s + 1];
    const d = haversineM(a, b);
    if (!isFinite(d) || d < 1) continue;
    const steps = Math.max(1, Math.ceil(d / FILL_STEP_M));
    const brg = bearingDeg(a, b);
    for (let i = 0; i <= steps; i++) {
      const p = offsetPoint(a.latitude, a.longitude, brg, i * (d / steps));
      const key = getGridKey(p.latitude, p.longitude);
      if (!cache.has(key)) cache.set(key, { valueKph, timestamp: Date.now(), street });
      if (FILL_WIDTH_M > 0) {
        const left = offsetPoint(p.latitude, p.longitude, (brg + 270) % 360, FILL_WIDTH_M);
        const right = offsetPoint(p.latitude, p.longitude, (brg + 90) % 360, FILL_WIDTH_M);
        for (const q of [left, right]) {
          const k2 = getGridKey(q.latitude, q.longitude);
          if (!cache.has(k2)) cache.set(k2, { valueKph, timestamp: Date.now(), street });
        }
      }
    }
  }
  await saveSpeedLimitCache();
}

// HERE reverse geocode → { valueKph, street } | null
export async function fetchSpeedLimit(lat, lon) {
  try {
    const items = await fetchHereRevGeocode(lat, lon);
    const item = items?.[0];
    const street = item?.address?.street || item?.address?.label || '[Unknown Street]';
    const speedObj = item?.navigationAttributes?.speedLimits?.[0];
    if (!speedObj?.maxSpeed || !speedObj?.speedUnit) return null;
    const raw = speedObj.maxSpeed;
    const unitSrc = String(speedObj.speedUnit).toLowerCase();
    const valueKph = unitSrc === 'mph' ? raw * 1.60934 : raw;
    return { valueKph, street };
  } catch (err) {
    console.error('Failed to fetch speed limit via reverse geocode:', err);
    return null;
  }
}

export function kphToUnit(valueKph, unit) {
  return unit === 'mph' ? valueKph * 0.621371 : valueKph;
}
