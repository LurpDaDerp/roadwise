// utils/geo.js
//
// Great-circle geometry, in one place.
//
// There were three separate haversine implementations in the codebase (the background
// location task, the map screen and the speed-limit cache), written in three different
// styles and differing in their earth radius. They agree now because there is only one.
// This module deliberately has no imports: the background task loads it.

const EARTH_RADIUS_M = 6371000;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Distance in metres between two lat/lon pairs. */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Distance in metres between two { latitude, longitude } points. */
export function haversineM(a, b) {
  return distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);
}

/** Initial bearing in degrees from point a to point b. */
export function bearingDeg(a, b) {
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** The point `distM` metres from (lat, lon) along `bearing`. */
export function offsetPoint(lat, lon, bearing, distM) {
  const br = toRad(bearing);
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const dr = distM / EARTH_RADIUS_M;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(dr) * Math.cos(lat1),
      Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { latitude: toDeg(lat2), longitude: toDeg(lon2) };
}

/** Same as distanceMeters; kept for the Family components that were written against it. */
export const getDistance = distanceMeters;

/* ------------------------------------------------------------------ *
 * Family-screen helpers (addresses, reverse-geocode cache, map style).
 * These need AsyncStorage; the geometry above deliberately does not.
 * ------------------------------------------------------------------ */
import AsyncStorage from '@react-native-async-storage/async-storage';

const directionMap = { north: 'N', south: 'S', east: 'E', west: 'W', northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW' };
const streetTypeMap = { avenue: 'Ave', place: 'Pl', street: 'St', road: 'Rd', boulevard: 'Blvd', drive: 'Dr', court: 'Ct', lane: 'Ln', terrace: 'Ter', parkway: 'Pkwy', circle: 'Cir' };
const stateAbbreviations = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

function normalizeAddress(addr) {
  if (!addr) return '';
  let normalized = addr.toLowerCase().replace(/[.,]/g, '');
  Object.entries(directionMap).forEach(([word, abbr]) => {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, 'gi'), abbr);
  });
  Object.entries(streetTypeMap).forEach(([word, abbr]) => {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, 'gi'), abbr);
  });
  Object.entries(stateAbbreviations).forEach(([state, abbr]) => {
    normalized = normalized.replace(new RegExp(`\\b${state.toLowerCase()}\\b`, 'gi'), abbr);
  });
  normalized = normalized.replace(/\b\d{5}(?:-\d{4})?\b/g, '');
  normalized = normalized.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized;
}

function compareAddresses(addr1, addr2, threshold = 0.7) {
  if (!addr1 || !addr2) return false;
  const tokens1 = addr1.split(' ').filter(Boolean);
  const tokens2 = addr2.split(' ').filter(Boolean);
  if (tokens1.join(' ') === tokens2.join(' ')) return true;
  let i = 0;
  let j = 0;
  let matches = 0;
  while (i < tokens1.length && j < tokens2.length) {
    if (tokens1[i] === tokens2[j]) {
      matches++;
      i++;
      j++;
    } else {
      j++;
    }
  }
  const fractionMatched = matches / Math.min(tokens1.length, tokens2.length);
  return fractionMatched >= threshold;
}

// Reverse-geocode cache (7-day TTL, purged at most once a day).
const ADDR_CACHE_PREFIX = 'addr_';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_PURGE_THROTTLE_KEY = 'addr_cache_last_purge';
const CACHE_PURGE_THROTTLE_MS = 24 * 60 * 60 * 1000;

export async function purgeOldGeocodeCache() {
  try {
    const now = Date.now();
    const lastRun = Number((await AsyncStorage.getItem(CACHE_PURGE_THROTTLE_KEY)) || 0);
    if (now - lastRun < CACHE_PURGE_THROTTLE_MS) return;
    const keys = await AsyncStorage.getAllKeys();
    const addrKeys = keys.filter((k) => k.startsWith(ADDR_CACHE_PREFIX));
    if (addrKeys.length) {
      const pairs = await AsyncStorage.multiGet(addrKeys);
      const toRemove = [];
      for (const [k, v] of pairs) {
        if (!v) {
          toRemove.push(k);
          continue;
        }
        try {
          const parsed = JSON.parse(v);
          if (!parsed?.ts || now - parsed.ts > CACHE_TTL_MS) toRemove.push(k);
        } catch {
          toRemove.push(k);
        }
      }
      if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
    }
    await AsyncStorage.setItem(CACHE_PURGE_THROTTLE_KEY, String(now));
  } catch (e) {
    console.warn('Cache purge failed:', e);
  }
}

export async function getCachedAddressNear(lat, lon, tolerance = 0.00005) {
  const keys = await AsyncStorage.getAllKeys();
  const addrKeys = keys.filter((k) => k.startsWith(ADDR_CACHE_PREFIX) && k !== CACHE_PURGE_THROTTLE_KEY);
  for (const key of addrKeys) {
    const [, keyLat, keyLon] = key.split('_');
    const kLat = parseFloat(keyLat);
    const kLon = parseFloat(keyLon);
    if (Math.abs(lat - kLat) <= tolerance && Math.abs(lon - kLon) <= tolerance) {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.v) return parsed.v;
      } catch {
        return raw;
      }
    }
  }
  return null;
}

// Nominatim allows one request per second: every uncached lookup goes through
// a single-flight FIFO queue with a 1.1 s gap between requests.
const NOMINATIM_GAP_MS = 1100;
let nominatimChain = Promise.resolve();
let nominatimLastAt = 0;
function nominatimFetch(lat, lon) {
  const run = nominatimChain.then(async () => {
    const wait = NOMINATIM_GAP_MS - (Date.now() - nominatimLastAt);
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    nominatimLastAt = Date.now();
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      { headers: { 'User-Agent': 'RoadCash/1.0 (contact@roadcash.app)', Accept: 'application/json' } }
    );
    if (!response.ok) return null;
    return response.json();
  });
  nominatimChain = run.catch(() => {}); // a failure never blocks the queue
  return run;
}

// Reverse geocode one coordinate (cached). Returns { address, displayName }.
// `savedLocations` are matched to give a friendly name ("Home").
export async function reverseGeocode(latitude, longitude, savedLocations = []) {
  let address = 'Unknown location';
  const lat = Number(latitude).toFixed(5);
  const lon = Number(longitude).toFixed(5);
  const cacheKey = `${ADDR_CACHE_PREFIX}${lat}_${lon}`;
  let cachedRaw = null;
  try {
    cachedRaw = await AsyncStorage.getItem(cacheKey);
  } catch {}
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw);
      address = parsed && typeof parsed === 'object' && parsed.v ? parsed.v : cachedRaw;
    } catch {
      address = cachedRaw;
    }
  } else {
    try {
      const result = await nominatimFetch(lat, lon);
      if (result && result.address) {
        const { road, house_number, city, town, village, state, country } = result.address;
        const addrParts = [house_number ? `${house_number} ` : '', road || '', city || town || village || state || '', country || ''].filter(Boolean);
        address = addrParts.join(' ');
      }
      if (address !== 'Unknown location') {
        await AsyncStorage.setItem(cacheKey, JSON.stringify({ v: address, ts: Date.now() }));
      }
    } catch (e) {
      console.warn('Reverse geocode failed:', e);
    }
  }
  const normalized = normalizeAddress(address);
  const match = savedLocations
    .map((loc) => ({ ...loc, normalizedAddress: loc.normalizedAddress || normalizeAddress(loc.address) }))
    .find((loc) => compareAddresses(normalized, loc.normalizedAddress));
  return { displayName: match ? match.name : null, address };
}


// Dark map style for react-native-maps (Google provider on Android; ignored on Apple Maps).
export const DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#121418' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#858d9d' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0b0d10' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#22262c' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#191c21' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2d3139' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#06080a' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];
