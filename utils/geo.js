// Geo helpers shared by the Family screen (moved out of LocationScreen).
import AsyncStorage from '@react-native-async-storage/async-storage';

export function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRad = (x) => (x * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const directionMap = { north: 'N', south: 'S', east: 'E', west: 'W', northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW' };
const streetTypeMap = { avenue: 'Ave', place: 'Pl', street: 'St', road: 'Rd', boulevard: 'Blvd', drive: 'Dr', court: 'Ct', lane: 'Ln', terrace: 'Ter', parkway: 'Pkwy', circle: 'Cir' };
const stateAbbreviations = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

export function normalizeAddress(addr) {
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

export function compareAddresses(addr1, addr2, threshold = 0.7) {
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
export const ADDR_CACHE_PREFIX = 'addr_';
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
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
        { headers: { 'User-Agent': 'RoadCash/1.0 (contact@roadcash.app)', Accept: 'application/json' } }
      );
      if (response.ok) {
        const result = await response.json();
        if (result && result.address) {
          const { road, house_number, city, town, village, state, country } = result.address;
          const addrParts = [house_number ? `${house_number} ` : '', road || '', city || town || village || state || '', country || ''].filter(Boolean);
          address = addrParts.join(' ');
        }
        if (address !== 'Unknown location') {
          await AsyncStorage.setItem(cacheKey, JSON.stringify({ v: address, ts: Date.now() }));
        }
      }
    } catch (e) {
      console.warn('Reverse geocode failed:', e);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  const normalized = normalizeAddress(address);
  const match = savedLocations
    .map((loc) => ({ ...loc, normalizedAddress: loc.normalizedAddress || normalizeAddress(loc.address) }))
    .find((loc) => compareAddresses(normalized, loc.normalizedAddress));
  return { displayName: match ? match.name : null, address };
}

export function makeGroupCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
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
