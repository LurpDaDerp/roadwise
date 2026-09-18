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

import { distanceMeters, haversineM, bearingDeg, offsetPoint } from './geo';
// The same cell the Cloud Function caches under (functions/lib/here.js keeps its own copy;
// hooks/__tests__/gridKey.test.js asserts the two agree).
import { gridKey as getGridKey } from './gridKey';
import { fetchHereRevGeocode } from './here';

// v2: the grid resolution changed, so v1 keys address different ground. A version in
// the key drops the stale map in one go instead of leaving thousands of unreachable
// entries to age out of an LRU they can never be hit in.
const STORAGE_KEY = '@speedLimitCache.v2';
// Matches the server-side cell size in functions/lib/here.js. A wide cell hands one
// road's answer to the road beside it; ~55 m is narrower than the gap between parallel
// streets in almost all grids.
// The cell size lives in utils/gridKey.js, shared with the Cloud Function's own copy.
// A ~55 m cell covers ~1/16 the area of the old ~220 m one, so the same amount of
// travelled road needs proportionally more entries.
const MAX_ENTRIES = 8000;
// 7 days, matching the server-side cache in functions/lib/here.js. A 60-day client TTL meant a
// road whose limit changed kept serving the old value for weeks after the server had forgotten it.
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 4000;

// Network throttle: never more than one HERE lookup per 15 s, and never twice inside 250 m.
const MIN_FETCH_INTERVAL_MS = 15_000;
const MIN_FETCH_DISTANCE_M = 250;

const KPH_PER_MPH = 1.60934;
const MPH_PER_KPH = 0.621371;

// Polyline fill geometry.
// Must be no larger than the cell size or the fill leaves gaps along the road.
const FILL_STEP_M = 40;
const FILL_WIDTH_M = 30;

// Insertion order is LRU order: re-reading an entry moves it to the end.
const cache = new Map();
let loaded = false;
let persistTimer = null;
let lastFetchAt = 0;
let lastFetchCoords = null;
// Keyed by cell: a single shared promise collapsed concurrent callers onto a request for
// a completely different coordinate and handed them its answer.
const inFlight = new Map();

/* ---------------------------------------------------------------- *
 * Geometry (re-exported from utils/geo so callers need one import)
 * ---------------------------------------------------------------- */

export { distanceMeters, haversineM, bearingDeg, offsetPoint };



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
let loadPromise = null;

export async function loadSpeedLimitCache() {
  if (loaded) return;
  // `loaded` used to be set before the await, so a second caller arriving during the read
  // skipped the wait and saw an empty cache.
  if (loadPromise) return loadPromise;
  loadPromise = doLoadSpeedLimitCache().finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}

async function doLoadSpeedLimitCache() {
  if (loaded) return;
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
  } finally {
    loaded = true;
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

function sameStreet(a, b) {
  if (!a || !b) return true; // one side unknown: no evidence of a mismatch
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Cached limit for a position, or null. Never touches the network.
 *
 * `expectedStreet` is the road the caller believes it is on. A grid cell can straddle a
 * side street and an arterial road, and a cached answer for the wrong one is how a 25 mph
 * limit ends up displayed on a highway; when both street names are known and they differ,
 * the hit is refused and the caller falls through to a fresh lookup.
 */
export function lookupCachedSpeedLimit(lat, lon, { expectedStreet = null } = {}) {
  const key = getGridKey(lat, lon);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ENTRY_TTL_MS) {
    cache.delete(key);
    return null;
  }
  if (!sameStreet(entry.street, expectedStreet)) return null;
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
export async function getSpeedLimit(lat, lon, { allowNetwork = true, expectedStreet = null } = {}) {
  await loadSpeedLimitCache();

  const cached = lookupCachedSpeedLimit(lat, lon, { expectedStreet });
  if (cached) return { ...cached, cached: true };

  if (!allowNetwork) return null;

  const cellKey = getGridKey(lat, lon);

  // Collapse concurrent callers FOR THE SAME CELL onto one request. A single shared
  // promise used to hand a caller the answer for wherever the first caller happened to be.
  const existing = inFlight.get(cellKey);
  if (existing) return existing;

  const now = Date.now();
  if (!throttleAllows(lat, lon, now)) return null;

  lastFetchAt = now;
  lastFetchCoords = { latitude: lat, longitude: lon };

  const request = (async () => {
    try {
      const items = await fetchHereRevGeocode(lat, lon);
      const item = items?.[0];
      if (!item) return null;

      const street = item.address?.street || item.address?.label || null;
      const speedObj = item.navigationAttributes?.speedLimits?.[0];
      if (!speedObj?.maxSpeed || !speedObj?.speedUnit) return null;

      const unitSrc = String(speedObj.speedUnit).toLowerCase();
      const valueKph = unitSrc === 'mph' ? speedObj.maxSpeed * KPH_PER_MPH : speedObj.maxSpeed;

      setEntry(cellKey, { valueKph, timestamp: Date.now(), street });
      evictIfNeeded();
      schedulePersist();

      return { valueKph, street, cached: false };
    } catch (err) {
      console.error('Speed limit lookup failed:', err);
      return null;
    } finally {
      inFlight.delete(cellKey);
    }
  })();

  inFlight.set(cellKey, request);
  return request;
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

