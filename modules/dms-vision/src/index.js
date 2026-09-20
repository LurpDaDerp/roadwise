// DmsVision - JS wrapper around the local Expo Module `modules/dms-vision`.
//
// The native layer owns the front camera, runs MediaPipe FaceLandmarker once per processed frame
// and runs the gaze network through ONNX Runtime. This file only marshals typed arrays and
// degrades gracefully when the native module is absent (Expo Go, web, a build without the
// module), where `isAvailable()` is false and `start()` rejects with a clear error.
//
// Contract (docs/dms/NATIVE_LAYER.md):
//   * landmarks are MediaPipe normalized (x / W, y / H, z / W) of the UPRIGHT image;
//   * `t` is seconds since the first processed frame of the session, from the camera clock;
//   * `focalScale` is fx / uprightWidth with the principal point at the frame centre;
//   * every float buffer crossing the bridge is little-endian float32.

import { requireOptionalNativeModule } from 'expo';

const NativeModule = requireOptionalNativeModule('DmsVision');

export const NUM_LANDMARKS = 478;
export const CLOUD_FLOATS = NUM_LANDMARKS * 3; // 1434
export const CONTEXT_FLOATS = 7;
export const VALIDITY_FLOATS = NUM_LANDMARKS; // 478
export const GAZE_OUTPUT_FLOATS = 12; // gaze[3] + rotation[9] row-major

const UNAVAILABLE =
  'The dms-vision native module is not available. It requires a development build ' +
  '(npx expo run:* or an EAS build); it cannot work in Expo Go or on web.';

function requireNative() {
  if (!NativeModule) {
    throw new Error(UNAVAILABLE);
  }
  return NativeModule;
}

// ---------------------------------------------------------------------------------------------
// Typed-array marshalling
// ---------------------------------------------------------------------------------------------

/** Float32Array (or any float source) -> a Uint8Array view of little-endian float32 bytes. */
function toBytes(values, expectedFloats, name) {
  let source;
  if (values instanceof Float32Array) {
    source = values;
  } else if (ArrayBuffer.isView(values)) {
    source = Float32Array.from(values);
  } else if (Array.isArray(values)) {
    source = Float32Array.from(values);
  } else {
    throw new TypeError(`${name} must be a Float32Array or an array of numbers`);
  }
  if (source.length !== expectedFloats) {
    throw new RangeError(`${name} must have ${expectedFloats} floats, got ${source.length}`);
  }
  // A view whose byteOffset is not a multiple of 4 cannot be re-viewed as float32 on the other
  // side, and the native argument converter copies `byteLength` bytes from `byteOffset`; copying
  // into a fresh, zero-offset buffer removes both hazards.
  if (source.byteOffset !== 0 || source.buffer.byteLength !== source.byteLength) {
    source = new Float32Array(source);
  }
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

/** Uint8Array of little-endian float32 -> Float32Array, copying when the offset is unaligned. */
export function bytesToFloat32(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('expected a Uint8Array');
  }
  if (bytes.byteLength % 4 !== 0) {
    throw new RangeError(`byte length ${bytes.byteLength} is not a multiple of 4`);
  }
  if (bytes.byteOffset % 4 !== 0) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function decodeFrame(event) {
  const landmarks =
    event && event.landmarks ? bytesToFloat32(event.landmarks) : null;
  return {
    t: event.t,
    width: event.width,
    height: event.height,
    facePresent: !!event.facePresent && landmarks !== null,
    score: event.score,
    isMirrored: typeof event.isMirrored === 'boolean' ? event.isMirrored : null,
    focalScale: Number.isFinite(event.focalScale) && event.focalScale > 0 ? event.focalScale : null,
    intrinsicsSource: event.intrinsicsSource,
    orientation: event.orientation,
    landmarks,
  };
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

export const DmsVision = {
  /** True when the native module is linked into this binary. */
  isAvailable() {
    return !!NativeModule;
  },

  /** `{ status, granted, canAskAgain, expires }` for the camera permission. */
  async getPermissionsAsync() {
    return requireNative().getPermissionsAsync();
  },

  async requestPermissionsAsync() {
    return requireNative().requestPermissionsAsync();
  },

  /**
   * Starts the front camera and the landmarker.
   *
   * @param {object} [options]
   * @param {number} [options.targetFps=20]   process at most this many frames per second
   * @param {'front'} [options.facing='front']
   * @param {'upright'|'buffer'} [options.landmarkFrame='upright']
   *        'buffer' skips the upright rotation and reports the raw MediaPipe frame - for the
   *        on-device orientation harness only.
   * @param {boolean} [options.mirrorPair=false]  rejected; the mirror pair is not implemented yet
   * @param {number} [options.rotationOffsetDegrees=0]
   *        added to the automatic buffer->upright rotation (multiple of 90). Escape hatch for the
   *        one value that cannot be verified without a device; leave at 0 unless the harness says
   *        otherwise.
   */
  async start(options = {}) {
    const {
      targetFps = 20,
      facing = 'front',
      landmarkFrame = 'upright',
      mirrorPair = false,
      rotationOffsetDegrees = 0,
    } = options;
    if (mirrorPair) {
      throw new Error(
        'mirrorPair is not implemented in this version of dms-vision (single pass only)'
      );
    }
    return requireNative().start(
      Number(targetFps),
      String(facing),
      String(landmarkFrame),
      false,
      Number(rotationOffsetDegrees)
    );
  },

  async stop() {
    if (!NativeModule) return;
    return NativeModule.stop();
  },

  setTargetFps(fps) {
    requireNative().setTargetFps(Number(fps));
  },

  setIdleMode(idle) {
    requireNative().setIdleMode(!!idle);
  },

  /**
   * `{ focalScale, intrinsicsSource, fx, fy, cx, cy, bufferWidth, bufferHeight, width, height,
   *    rotationDegrees, orientation, isMirrored }` for the most recent frame.
   *
   * `focalScale`, `isMirrored` and `orientation` are **null until a frame has been processed**:
   * before that the natives know neither the delivered buffer size nor what the connection did
   * with mirroring, and a caller that latched the placeholder would run the rule engine on the
   * wrong camera and the wrong driver-relative left / right (docs/dms/DETECTION_DESIGN.md §2).
   * The nulls are passed through here, and normalised so an older native build cannot report a
   * zero focal scale as if it were real.
   */
  getIntrinsics() {
    const raw = requireNative().getIntrinsics() || {};
    return {
      ...raw,
      focalScale: Number.isFinite(raw.focalScale) && raw.focalScale > 0 ? raw.focalScale : null,
      isMirrored: typeof raw.isMirrored === 'boolean' ? raw.isMirrored : null,
      orientation: typeof raw.orientation === 'string' && raw.orientation ? raw.orientation : null,
    };
  },

  /** 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown'. */
  getThermalState() {
    if (!NativeModule) return 'unknown';
    return NativeModule.getThermalState();
  },

  /** `{ onnxSha256, parameters }` read from the bundled gaze_direct.meta.json. */
  getModelInfo() {
    return requireNative().getModelInfo();
  },

  /**
   * One batch-1 forward pass of the gaze network.
   *
   * @param {Float32Array} cloudF32     1434 floats, (478, 3) weak3d cloud
   * @param {Float32Array} contextF32   7 floats
   * @param {Float32Array} validityF32  478 floats
   * @returns {Promise<{ gaze: Float32Array, rotation: Float32Array }>} gaze(3), rotation(9)
   */
  async predictGaze(cloudF32, contextF32, validityF32) {
    const native = requireNative();
    const raw = await native.predictGaze(
      toBytes(cloudF32, CLOUD_FLOATS, 'cloud'),
      toBytes(contextF32, CONTEXT_FLOATS, 'context'),
      toBytes(validityF32, VALIDITY_FLOATS, 'validity')
    );
    const floats = bytesToFloat32(raw);
    if (floats.length !== GAZE_OUTPUT_FLOATS) {
      throw new Error(`expected ${GAZE_OUTPUT_FLOATS} output floats, got ${floats.length}`);
    }
    return {
      gaze: floats.slice(0, 3),
      rotation: floats.slice(3, 12),
    };
  },

  /**
   * @param {(frame: object) => void} callback receives
   *   `{ t, width, height, facePresent, score, isMirrored, focalScale, intrinsicsSource,
   *      orientation, landmarks }` with `landmarks` a Float32Array(1434) or null.
   */
  addFrameListener(callback) {
    return requireNative().addListener('onFrame', (event) => callback(decodeFrame(event)));
  },

  /** `{ thermal, lowPower, fps, dropped, running }`, once per second while running. */
  addStatusListener(callback) {
    return requireNative().addListener('onStatus', callback);
  },

  /** `{ code, message }`. */
  addErrorListener(callback) {
    return requireNative().addListener('onError', callback);
  },

  /**
   * Runs the 8 reference cases from `dms/tests/fixtures/onnx_parity.json` through the on-device
   * session and returns `{ maxAbsGaze, maxAbsRotation, ok }` (ok = both <= 1e-4).
   *
   * The fixture is the flattened form the reference generator writes:
   * `{ cloud, context, validity, gaze, rotation, shapes }` with `shapes.cloud = [8, 478, 3]`.
   * A nested form (arrays of per-case arrays) is accepted too.
   */
  async selfTest(parityFixture) {
    if (!parityFixture) {
      throw new Error('selfTest needs the parity fixture (dms/tests/fixtures/onnx_parity.json)');
    }
    const cases = normalizeParityFixture(parityFixture);
    let maxAbsGaze = 0;
    let maxAbsRotation = 0;
    for (const item of cases) {
      const out = await this.predictGaze(item.cloud, item.context, item.validity);
      for (let i = 0; i < 3; i += 1) {
        maxAbsGaze = Math.max(maxAbsGaze, Math.abs(out.gaze[i] - item.gaze[i]));
      }
      for (let i = 0; i < 9; i += 1) {
        maxAbsRotation = Math.max(maxAbsRotation, Math.abs(out.rotation[i] - item.rotation[i]));
      }
    }
    return {
      cases: cases.length,
      maxAbsGaze,
      maxAbsRotation,
      ok: maxAbsGaze <= 1e-4 && maxAbsRotation <= 1e-4,
    };
  },
};

function normalizeParityFixture(fixture) {
  const shapes = fixture.shapes || {};
  const batch =
    (shapes.cloud && shapes.cloud[0]) ||
    (Array.isArray(fixture.gaze) && Array.isArray(fixture.gaze[0]) ? fixture.gaze.length : null) ||
    (Array.isArray(fixture.gaze) ? fixture.gaze.length / 3 : 0);
  if (!batch || !Number.isInteger(batch)) {
    throw new Error('cannot infer the parity fixture batch size');
  }
  const flat = (value, perCase, index) => {
    if (Array.isArray(value) && Array.isArray(value[0])) {
      return Float32Array.from(flatten(value[index]));
    }
    return Float32Array.from(value.slice(index * perCase, (index + 1) * perCase));
  };
  const cases = [];
  for (let i = 0; i < batch; i += 1) {
    cases.push({
      cloud: flat(fixture.cloud, CLOUD_FLOATS, i),
      context: flat(fixture.context, CONTEXT_FLOATS, i),
      validity: flat(fixture.validity, VALIDITY_FLOATS, i),
      gaze: flat(fixture.gaze, 3, i),
      rotation: flat(fixture.rotation, 9, i),
    });
  }
  return cases;
}

function flatten(value) {
  if (!Array.isArray(value)) return [value];
  const out = [];
  for (const item of value) {
    if (Array.isArray(item)) out.push(...flatten(item));
    else out.push(item);
  }
  return out;
}

export default DmsVision;
