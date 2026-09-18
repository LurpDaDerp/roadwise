"use strict";

const {HttpsError} = require("firebase-functions/v2/https");

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }
  return request.auth.uid;
}

function requireObject(value, name, {maxKeys = 60, maxBytes = 8000} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpsError("invalid-argument", `${name} required.`);
  }
  if (Object.keys(value).length > maxKeys) {
    throw new HttpsError("invalid-argument", `${name} has too many fields.`);
  }
  // Bounds the prompt, and therefore the token bill, on data the client controls.
  const serialized = JSON.stringify(value);
  if (serialized.length > maxBytes) {
    throw new HttpsError("invalid-argument", `${name} is too large.`);
  }
  return serialized;
}

function requireCoordinates(data) {
  const lat = Number(data && data.lat);
  const lon = Number(data && data.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new HttpsError("invalid-argument", "lat/lon (number) required.");
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new HttpsError("invalid-argument", "lat/lon out of range.");
  }
  return {lat, lon};
}

function requireQueryString(data, {maxLength = 120, minLength = 2} = {}) {
  const q = typeof data?.q === "string" ? data.q.trim() : "";
  if (q.length < minLength) {
    throw new HttpsError("invalid-argument", "q (query) required.");
  }
  return q.slice(0, maxLength);
}

module.exports = {requireAuth, requireObject, requireCoordinates, requireQueryString};
