"use strict";

// HERE proxy with a shared, persistent cache.
//
// Reverse geocoding is the app's most frequent paid call: every driver asks for the speed
// limit of the road they are on. Those requests are enormously repetitive - the same roads,
// by the same user day after day and by every other user in the same town - but each one
// used to be a fresh billed HERE transaction.
//
// Results are now cached at two levels, keyed by a ~220 m grid cell:
//   1. in the function instance (free, survives warm invocations)
//   2. in Firestore at geocache/{cell} (shared by every user and every instance)
// A Firestore read is roughly three orders of magnitude cheaper than a HERE transaction,
// and the second driver down a road pays nothing at all.

const admin = require("firebase-admin");
const {HttpsError} = require("firebase-functions/v2/https");

const {fetchJson} = require("./http");
const {MemoryCache} = require("./cache");
const limits = require("./limits");

// A cache cell answers for everyone who enters it, so its size is the blast radius of a
// wrong answer. At 220 m a lookup made on a side street became that side street's limit
// for every driver on the arterial road beside it. 0.0005 degrees is ~55 m of latitude,
// which is narrower than the gap between parallel roads in almost all street grids.
const GRID_RESOLUTION = 0.0005;
// Speed limits change, roads get rebuilt, and a wrong entry is invisible until someone
// notices the number is wrong. Seven days bounds how long a bad answer can persist.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AUTOCOMPLETE_TTL_MS = 60 * 60 * 1000;

const revGeocodeMemory = new MemoryCache({maxEntries: 2000, ttlMs: CACHE_TTL_MS});
const autocompleteMemory = new MemoryCache({maxEntries: 500, ttlMs: AUTOCOMPLETE_TTL_MS});

function gridKey(lat, lon) {
  return `${Math.round(lat / GRID_RESOLUTION)}_${Math.round(lon / GRID_RESOLUTION)}`;
}

// Only the fields the client actually reads are cached, so a cache entry stays small.
function trimRevGeocodeItem(item) {
  if (!item) return null;
  const speedLimits = item.navigationAttributes && item.navigationAttributes.speedLimits;
  return {
    title: item.title || null,
    address: {
      street: (item.address && item.address.street) || null,
      label: (item.address && item.address.label) || null,
      city: (item.address && item.address.city) || null,
      state: (item.address && item.address.state) || null,
      postalCode: (item.address && item.address.postalCode) || null,
      countryCode: (item.address && item.address.countryCode) || null,
    },
    navigationAttributes: Array.isArray(speedLimits) ?
      {speedLimits: speedLimits.slice(0, 2)} :
      undefined,
  };
}

function streetOf(items) {
  const address = items && items[0] && items[0].address;
  return (address && (address.street || address.label)) || null;
}

async function readSharedCache(cell) {
  try {
    const snap = await admin.firestore().doc(`geocache/${cell}`).get();
    if (!snap.exists) return null;
    const data = snap.data();
    const cachedAt = data.cachedAt ? data.cachedAt.toMillis() : 0;
    if (Date.now() - cachedAt > CACHE_TTL_MS) return null;
    return Array.isArray(data.items) ? {items: data.items, street: data.street || null} : null;
  } catch (err) {
    console.error("geocache read failed:", err);
    return null;
  }
}

async function writeSharedCache(cell, items) {
  try {
    await admin.firestore().doc(`geocache/${cell}`).set({
      items,
      // Denormalised so a client can tell at a glance whether this answer belongs to the
      // road it is actually on, and so the entry is legible when debugging a wrong limit.
      street: streetOf(items),
      // Indexed field for the Firestore TTL policy; see docs/BACKEND_AUDIT.md.
      cachedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + CACHE_TTL_MS),
    });
  } catch (err) {
    console.error("geocache write failed:", err);
  }
}

async function reverseGeocode(uid, lat, lon, apiKey) {
  const cell = gridKey(lat, lon);

  const memoryHit = revGeocodeMemory.get(cell);
  if (memoryHit) {
    return {items: memoryHit, source: "memory", street: streetOf(memoryHit)};
  }

  const sharedHit = await readSharedCache(cell);
  if (sharedHit) {
    revGeocodeMemory.set(cell, sharedHit.items);
    return {items: sharedHit.items, source: "firestore", street: sharedHit.street};
  }

  // Only a request that will actually reach HERE counts against the caller's allowance.
  await limits.consume(uid, "hereRevGeocode");

  const url =
    "https://revgeocode.search.hereapi.com/v1/revgeocode" +
    `?at=${lat},${lon}&lang=en-US&limit=1&showNavAttributes=speedLimits` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetchJson(url, {timeoutMs: 8000});
  if (!res.ok) {
    console.error("HERE revgeocode failed:", res.status);
    throw new HttpsError("internal", "HERE request failed.");
  }

  const items = (Array.isArray(res.body && res.body.items) ? res.body.items : [])
    .slice(0, 1)
    .map(trimRevGeocodeItem)
    .filter(Boolean);

  revGeocodeMemory.set(cell, items);
  await writeSharedCache(cell, items);

  return {items, source: "here", street: streetOf(items)};
}

async function autocomplete(uid, q, apiKey) {
  const key = q.toLowerCase();

  const memoryHit = autocompleteMemory.get(key);
  if (memoryHit) return memoryHit;

  await limits.consume(uid, "hereAutocomplete");

  const url =
    "https://autocomplete.search.hereapi.com/v1/autocomplete" +
    `?q=${encodeURIComponent(q)}&limit=5&apiKey=${encodeURIComponent(apiKey)}`;

  const res = await fetchJson(url, {timeoutMs: 8000});
  if (!res.ok) {
    console.error("HERE autocomplete failed:", res.status);
    throw new HttpsError("internal", "HERE request failed.");
  }

  const items = Array.isArray(res.body && res.body.items) ? res.body.items.slice(0, 5) : [];
  autocompleteMemory.set(key, items);
  return items;
}

module.exports = {reverseGeocode, autocomplete, gridKey};
