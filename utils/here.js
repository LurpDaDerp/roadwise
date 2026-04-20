// utils/here.js
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

const hereAutocomplete = httpsCallable(functions, "hereAutocomplete");
const hereRevGeocode = httpsCallable(functions, "hereRevGeocode");

export async function fetchHereAutocomplete(q) {
  try {
    const { data } = await hereAutocomplete({ q });
    return data?.items || [];
  } catch (err) {
    console.error("HERE autocomplete error:", err);
    return [];
  }
}

export async function fetchHereRevGeocode(lat, lon) {
  try {
    const { data } = await hereRevGeocode({ lat, lon });
    return data?.items || [];
  } catch (err) {
    console.error("HERE revgeocode error:", err);
    return [];
  }
}
