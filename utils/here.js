// utils/here.js
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

const hereAutocomplete = httpsCallable(functions, "hereAutocomplete");
const hereRevGeocode = httpsCallable(functions, "hereRevGeocode");

export async function fetchHereAutocomplete(q) {
  if (typeof q !== "string" || q.trim().length < 2) return [];

  try {
    const { data } = await hereAutocomplete({ q });
    return data?.items || [];
  } catch (err) {
    console.error("HERE autocomplete error:", err);
    return [];
  }
}

export async function fetchHereRevGeocode(lat, lon) {
  // Reject nonsense before it costs a callable invocation; the function validates too.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return [];

  try {
    const { data } = await hereRevGeocode({ lat, lon });
    return data?.items || [];
  } catch (err) {
    console.error("HERE revgeocode error:", err);
    return [];
  }
}
