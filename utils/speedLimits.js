// utils/speedLimits.js
//
// Speed limit lookup and caching (TODO.md item 2, "optimize speed limit/geocoding API
// calls").
//
// The cache is a grid: coordinates are rounded to a ~220 m cell and the HERE answer for
// that cell is reused for every later fix inside it. When a limit is confirmed over a run
// of road, the cells along that run are filled in too, so a road costs one lookup no
// matter how often it is driven.
//
// What this fixes relative to the copy that lived inside DriveScreen:
//
// * Every cache fill rewrote the ENTIRE cache to AsyncStorage from inside the position
//   callback. Filling one 4 km segment touches ~150 cells, i.e. ~150 full serializations
//   of a map that grew forever. Persistence is now debounced to one write per burst.
// * The cache had no size bound and no expiry, so it grew without limit and kept speed
//   limits that had since changed. It is now LRU-bounded and entries expire.
// * The request throttle was a module global in a screen file. It lives with the cache.
// * Callers had to know about the throttle, the cache and the HERE response shape. They
//   now call getSpeedLimit() and get a value or null.

import AsyncStorage from '@react-native-async-storage/async-storage';

import { fetchHereRevGeocode } from './here';

const STORAGE_KEY = '@speedLimitCache';
const GRID_RESOLUTION = 0.002; // ~220 m
const MAX_ENTRIES = 4000;
const ENTRY_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const PERSIST_DEBOUNCE_MS = 4000;

// Network throttle: never more than one HERE lookup per 15 s, and never twice inside 250 m.
const MIN_FETCH_INTERVAL_MS = 15_000;
const MIN_FETCH_DISTANCE_M = 250;

const KPH_PER_MPH = 1.60934;
const MPH_PER_KPH = 0.621371;

// Polyline fill geometry.
const FILL_STEP_M = 80;
const FILL_WIDTH_M = 30;

// Insertion order is LRU order: re-reading an entry moves it to the end.
const cache = new Map();
let loaded = false;
let persistTimer = null;
let lastFetchAt = 0;
let lastFetchCoords = null;
let inFlight = null;

/* ---------------------------------------------------------------- *
 * Geometry helpers
 * ---------------------------------------------------------------- */

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function haversineM(a, b) {
  return distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);
}

export function bearingDeg(a, b) {
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function offsetPoint(lat, lon, bearing, distM) {
  const R = 6371000;
  const br = toRad(bearing);
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const dr = distM / R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br)
  );
  const lon2 =
    lon1 +
    Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
  return { latitude: toDeg(lat2), longitude: toDeg(lon2) };
}

export function getGridKey(lat, lon) {
  return `${Math.round(lat / GRID_RESOLUTION)}_${Math.round(lon / GRID_RESOLUTION)}`;
}

/* ---------------------------------------------------------------- *
 * Cache persistence
 * ---------------------------------------------------------------- */

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistNow() {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(cache.entries())));
  } catch (err) {
    console.warn('Failed to save the speed limit cache:', err);
  }
}

/** Flush any pending cache write. Call when a drive ends. */
export async function flushSpeedLimitCache() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistNow();
}

function evictIfNeeded() {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function setEntry(key, entry) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, entry);
}

/** Load the persisted cache. Safe to call repeatedly; only the first call does work. */
export async function loadSpeedLimitCache() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const now = Date.now();
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;

    for (const [key, val] of entries) {
      const normalized = normalizeStoredEntry(val, now);
      if (normalized) setEntry(key, normalized);
    }
    evictIfNeeded();
  } catch (err) {
    console.warn('Failed to load the speed limit cache:', err);
  }
}

// Three cache formats have shipped; keep reading all of them.
function normalizeStoredEntry(val, now) {
  if (val && typeof val === 'object' && 'valueKph' in val) {
    const timestamp = val.timestamp ?? now;
    if (now - timestamp > ENTRY_TTL_MS) return null;
    return { valueKph: val.valueKph, timestamp, street: val.street };
  }
  if (typeof val === 'number') {
    return { valueKph: val * KPH_PER_MPH, timestamp: now };
  }
  if (val && typeof val === 'object' && 'value' in val && 'unit' in val) {
    const kph = val.unit === 'mph' ? val.value * KPH_PER_MPH : val.value;
    return { valueKph: kph, timestamp: now, street: val.street };
  }
  return null;
}

/* ---------------------------------------------------------------- *
 * Lookup
 * ---------------------------------------------------------------- */

/** Cached limit for a position, or null. Never touches the network. */
export function lookupCachedSpeedLimit(lat, lon) {
  const key = getGridKey(lat, lon);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ENTRY_TTL_MS) {
    cache.delete(key);
    return null;
  }
  setEntry(key, entry); // refresh LRU position
  return entry;
}

function throttleAllows(lat, lon, now) {
  if (now - lastFetchAt < MIN_FETCH_INTERVAL_MS) return false;
  if (!lastFetchCoords) return true;
  return (
    distanceMeters(lastFetchCoords.latitude, lastFetchCoords.longitude, lat, lon) >=
    MIN_FETCH_DISTANCE_M
  );
}

/**
 * Speed limit for a position.
 *
 * Returns { valueKph, street, cached } or null. Answers from the cache when it can; goes
 * to HERE (via the authenticated Cloud Function proxy) only when the cache misses and the
 * throttle allows it, so a stationary or slow-moving device never generates traffic.
 */
export async function getSpeedLimit(lat, lon, { allowNetwork = true } = {}) {
  await loadSpeedLimitCache();

  const cached = lookupCachedSpeedLimit(lat, lon);
  if (cached) return { ...cached, cached: true };

  if (!allowNetwork) return null;

  const now = Date.now();
  if (!throttleAllows(lat, lon, now)) return null;

  // Collapse concurrent callers onto one request.
  if (inFlight) return inFlight;

  lastFetchAt = now;
  lastFetchCoords = { latitude: lat, longitude: lon };

  inFlight = (async () => {
    try {
      const items = await fetchHereRevGeocode(lat, lon);
      const item = items?.[0];
      if (!item) return null;

      const street = item.address?.street || item.address?.label || null;
      const speedObj = item.navigationAttributes?.speedLimits?.[0];
      if (!speedObj?.maxSpeed || !speedObj?.speedUnit) return null;

      const unitSrc = String(speedObj.speedUnit).toLowerCase();
      const valueKph = unitSrc === 'mph' ? speedObj.maxSpeed * KPH_PER_MPH : speedObj.maxSpeed;

      setEntry(getGridKey(lat, lon), { valueKph, timestamp: Date.now(), street });
      evictIfNeeded();
      schedulePersist();

      return { valueKph, street, cached: false };
    } catch (err) {
      console.error('Speed limit lookup failed:', err);
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Convert a cached kph value into the unit the UI is showing. */
export function toDisplayUnits(valueKph, unit) {
  if (valueKph == null) return null;
  return unit === 'mph' ? valueKph * MPH_PER_KPH : valueKph;
}

/**
 * Fill the grid cells along a driven segment with a confirmed limit, plus a 30 m skirt on
 * each side so the return trip on the other carriageway also hits the cache.
 */
export function fillCachePolyline(points, valueKph, street) {
  if (!points || points.length < 2 || valueKph == null) return;

  for (let s = 0; s < points.length - 1; s++) {
    const a = points[s];
    const b = points[s + 1];
    const d = haversineM(a, b);
    if (!Number.isFinite(d) || d < 1) continue;

    const steps = Math.max(1, Math.ceil(d / FILL_STEP_M));
    const brg = bearingDeg(a, b);

    for (let i = 0; i <= steps; i++) {
      const p = offsetPoint(a.latitude, a.longitude, brg, i * (d / steps));
      const candidates = [p];
      if (FILL_WIDTH_M > 0) {
        candidates.push(offsetPoint(p.latitude, p.longitude, (brg + 270) % 360, FILL_WIDTH_M));
        candidates.push(offsetPoint(p.latitude, p.longitude, (brg + 90) % 360, FILL_WIDTH_M));
      }
      for (const q of candidates) {
        const key = getGridKey(q.latitude, q.longitude);
        if (!cache.has(key)) {
          cache.set(key, { valueKph, timestamp: Date.now(), street });
        }
      }
    }
  }

  evictIfNeeded();
  schedulePersist();
}

/** Diagnostics for the audit document and manual testing. */
export function speedLimitCacheStats() {
  return { entries: cache.size, maxEntries: MAX_ENTRIES, loaded };
}
