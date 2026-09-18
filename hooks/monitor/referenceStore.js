'use strict';
/**
 * The persisted forward-gaze reference (DETECTION_DESIGN §5.2).
 *
 * At drive end, a CONFIRMED reference is stored per camera facing and device orientation under
 * `@monitorReference:{facing}:{orientation}`.  At the next drive start the calibrator is seeded
 * with it in the STALE state (`ForwardReference.seedStale`), so its own re-validation path
 * confirms it from 15-20 s of agreeing frames or replaces it if the mount moved.  The prior is
 * dropped after 30 days or when the model bundle changes.
 *
 * Pure: the storage is injected ({getItem, setItem, removeItem} -> Promises, i.e. AsyncStorage).
 */

const VERSION = 1;
const PREFIX = '@monitorReference';
const MAX_AGE_DAYS = 30;

function referenceKey(facing, orientation) {
  const f = facing ? String(facing) : 'front';
  const o = orientation ? String(orientation) : 'unknown';
  return `${PREFIX}:${f}:${o}`;
}

function finiteVec3(v) {
  if (!v || v.length !== 3) return null;
  const out = [Number(v[0]), Number(v[1]), Number(v[2])];
  if (!out.every((x) => Number.isFinite(x))) return null;
  const n = Math.hypot(out[0], out[1], out[2]);
  if (!(n > 1e-6)) return null;
  return out;
}

function finitePair(v) {
  if (!v || v.length !== 2) return null;
  const out = [Number(v[0]), Number(v[1])];
  return out.every((x) => Number.isFinite(x)) ? out : null;
}

/**
 * @param {object} p  {reference:[3], headMode:[yaw,pitch]|null, facing, orientation,
 *                     modelSha, focalScale, savedAtMs}
 * @returns {string|null} the JSON to store, or null when the reference is not storable
 */
function serializeReference(p) {
  const reference = finiteVec3(p && p.reference);
  if (reference === null) return null;
  const payload = {
    v: VERSION,
    savedAt: Number.isFinite(p.savedAtMs) ? Math.round(p.savedAtMs) : Date.now(),
    facing: p.facing ? String(p.facing) : 'front',
    orientation: p.orientation ? String(p.orientation) : 'unknown',
    modelSha: p.modelSha ? String(p.modelSha) : null,
    focalScale: Number.isFinite(p.focalScale) ? p.focalScale : null,
    reference,
    headMode: finitePair(p && p.headMode),
  };
  return JSON.stringify(payload);
}

/**
 * @returns {{ok: boolean, reason: string, value: object|null}}
 *   reason: 'ok' | 'empty' | 'corrupt' | 'version' | 'expired' | 'model' | 'mount'
 */
function parseReference(raw, opts = {}) {
  if (!raw) return { ok: false, reason: 'empty', value: null };
  let p;
  try {
    p = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'corrupt', value: null };
  }
  if (!p || typeof p !== 'object') return { ok: false, reason: 'corrupt', value: null };
  if (p.v !== VERSION) return { ok: false, reason: 'version', value: null };
  const reference = finiteVec3(p.reference);
  if (reference === null) return { ok: false, reason: 'corrupt', value: null };

  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const maxAgeMs = (Number.isFinite(opts.maxAgeDays) ? opts.maxAgeDays : MAX_AGE_DAYS) * 86400000;
  if (!Number.isFinite(p.savedAt) || nowMs - p.savedAt > maxAgeMs || p.savedAt - nowMs > 86400000) {
    return { ok: false, reason: 'expired', value: null };
  }
  if (opts.modelSha && p.modelSha && String(p.modelSha) !== String(opts.modelSha)) {
    return { ok: false, reason: 'model', value: null };
  }
  if (opts.facing && p.facing && String(p.facing) !== String(opts.facing)) {
    return { ok: false, reason: 'mount', value: null };
  }
  if (opts.orientation && p.orientation && String(p.orientation) !== String(opts.orientation)) {
    return { ok: false, reason: 'mount', value: null };
  }
  return {
    ok: true,
    reason: 'ok',
    value: {
      reference,
      headMode: finitePair(p.headMode),
      savedAt: p.savedAt,
      facing: p.facing || null,
      orientation: p.orientation || null,
      modelSha: p.modelSha || null,
      focalScale: Number.isFinite(p.focalScale) ? p.focalScale : null,
    },
  };
}

async function loadReference(storage, opts = {}) {
  if (!storage || typeof storage.getItem !== 'function') return { ok: false, reason: 'empty', value: null };
  const key = referenceKey(opts.facing, opts.orientation);
  let raw = null;
  try {
    raw = await storage.getItem(key);
  } catch (err) {
    return { ok: false, reason: 'corrupt', value: null };
  }
  const parsed = parseReference(raw, opts);
  if (!parsed.ok && parsed.reason !== 'empty' && typeof storage.removeItem === 'function') {
    try { await storage.removeItem(key); } catch (err) { /* best effort */ }
  }
  return parsed;
}

async function saveReference(storage, p) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  const json = serializeReference(p);
  if (json === null) return false;
  try {
    await storage.setItem(referenceKey(p.facing, p.orientation), json);
    return true;
  } catch (err) {
    return false;
  }
}

async function clearReference(storage, opts = {}) {
  if (!storage || typeof storage.removeItem !== 'function') return false;
  try {
    await storage.removeItem(referenceKey(opts.facing, opts.orientation));
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  VERSION,
  PREFIX,
  MAX_AGE_DAYS,
  referenceKey,
  serializeReference,
  parseReference,
  loadReference,
  saveReference,
  clearReference,
};
