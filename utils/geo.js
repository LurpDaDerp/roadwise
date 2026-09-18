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
