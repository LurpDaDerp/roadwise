#!/usr/bin/env node
'use strict';
/**
 * Verifies that the three model files exist in all three places with identical contents and that
 * gaze_direct.onnx matches the sha256 recorded in gaze_direct.meta.json.
 *
 *   node scripts/check-models.js
 *
 * Exits non-zero (and prints what differs) when anything is out of sync. Run it after replacing a
 * promoted checkpoint; the native copies are what the app actually loads.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// This copy lives at <app>/scripts/, so the app root is one level up and the module is under it.
const APP_DIR = path.resolve(__dirname, '..');
const MODULE_DIR = path.join(APP_DIR, 'modules', 'dms-vision');

const FILES = ['face_landmarker.task', 'gaze_direct.onnx', 'gaze_direct.meta.json'];
/** The copy every other one is compared against (and the one meta.json is read from). */
const CANONICAL_LABEL = 'app assets';
const LOCATIONS = [
  { label: CANONICAL_LABEL, dir: path.join(APP_DIR, 'assets', 'models') },
  { label: 'ios bundle', dir: path.join(MODULE_DIR, 'ios', 'Resources') },
  { label: 'android assets', dir: path.join(MODULE_DIR, 'android', 'src', 'main', 'assets') },
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

let failed = false;
const digests = {};

for (const name of FILES) {
  const perLocation = [];
  for (const location of LOCATIONS) {
    const file = path.join(location.dir, name);
    if (!fs.existsSync(file)) {
      console.error(`MISSING  ${location.label}: ${path.relative(APP_DIR, file)}`);
      failed = true;
      continue;
    }
    perLocation.push({ label: location.label, file, digest: sha256(file) });
  }
  if (perLocation.length === 0) continue;
  // `assets/models/` is the canonical copy: the native bundles are copies OF it, so a mismatch
  // must always be reported against it and never against whichever copy happened to be first.
  const canonical = perLocation.find((entry) => entry.label === CANONICAL_LABEL);
  if (!canonical) {
    console.error(`MISSING  ${CANONICAL_LABEL} is the canonical copy of ${name}; nothing to compare against`);
    failed = true;
    continue;
  }
  const reference = canonical.digest;
  digests[name] = reference;
  for (const entry of perLocation) {
    const status = entry.digest === reference ? 'ok     ' : 'MISMATCH';
    if (entry.digest !== reference) failed = true;
    console.log(`${status} ${name.padEnd(24)} ${entry.label.padEnd(15)} ${entry.digest.slice(0, 16)}`);
  }
}

// The meta file records the sha256 the deployment stack verified the ONNX graph against.
const canonicalDir = LOCATIONS.find((l) => l.label === CANONICAL_LABEL).dir;
const metaFile = path.join(canonicalDir, 'gaze_direct.meta.json');
if (fs.existsSync(metaFile)) {
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const declared = meta.onnx_sha256;
  const actual = digests['gaze_direct.onnx'];
  if (declared && actual && declared !== actual) {
    console.error(`MISMATCH gaze_direct.onnx sha256 ${actual} != meta.json onnx_sha256 ${declared}`);
    failed = true;
  } else if (declared) {
    console.log(`ok      gaze_direct.onnx matches meta.json onnx_sha256 (${declared.slice(0, 16)})`);
  }
  if (meta.output_frame !== 'camera') {
    console.error(`MISMATCH meta.json output_frame is "${meta.output_frame}", expected "camera"`);
    failed = true;
  }
}

if (failed) {
  console.error('\ncheck-bundle: FAILED - re-copy assets/models/* into modules/dms-vision/ios/Resources/ and modules/dms-vision/android/src/main/assets/');
  process.exit(1);
}
console.log('\ncheck-bundle: all model copies are identical.');
