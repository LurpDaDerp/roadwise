# dms-vision — the native contract (v2)

Local Expo module for the driver-monitoring system (DMS). It owns the front camera and MediaPipe
FaceLandmarker, and it computes one **feature record per processed frame** natively. JavaScript
never receives pixels or landmarks: only the 38 derived numbers of the wire record (§4), in
batches.

The optional `gaze_direct` network runs in the same pipeline only in builds made with
`DMS_GAZE_NET=1`. That is a release gate: it never ships in a production binary until counsel
clears its licence (§7).

> **Status (Tasks 1–2 of the DMS rework).** This README and `src/` define the v2 contract, the TS reference of every native feature and the golden vectors. The Swift
> and Kotlin sources under `ios/` and `android/` are still the V1 implementation, which does not
> implement this contract. They are rewritten against it in Tasks 3 (iOS) and 4 (Android). No JS
> code starts the camera before then.

This README is **binding** for the Swift and Kotlin implementations. The TypeScript sources are
the machine-checked half of the same contract:

| File | What it pins |
|---|---|
| `src/constants.ts` | the wire fields, their NaN mask classes, the flag bits, the frame rates, the rotations, every timing constant, the thermal floor. It is the only place these numbers are defined (the DMS policy imports them) |
| `src/types.ts` | every method, event, payload and error code; `DMS_VISION_METHODS`, `DMS_VISION_EVENTS` |
| `src/wire.ts` | the record decoder and encoder, and the validators for every other payload |
| `src/index.ts` | the JS wrapper: argument checks, result validation, `requireOptionalNativeModule` |
| `src/fake.ts` | `createFakeDmsVision()`, the in-memory implementation every JS test runs against |

Where this README and the TypeScript disagree, the TypeScript wins and the README is a bug.
`__tests__/contract.test.ts` compares them.

---

## 1. Rules for both native modules

- **Event names.** Declare exactly `Events("frames", "status", "state")`, byte-identical on both platforms.
- **Methods.** Every name in `DMS_VISION_METHODS` is an `AsyncFunction("<name>")` on both platforms. `isAvailable` is a JS-only check. `addListener` is the Expo event emitter's.
- **Arguments.** `start` and `setPolicy` each take **one object** (an Expo `Record` on both platforms), with exactly the keys of `startOptionsSchema` / `capturePolicySchema` in `src/wire.ts`. The native text tests pin the `Record` field names to those keys.
- **Exact keys.** Results and event payloads carry exactly the keys in `src/types.ts`. JS validates with strict schemas.
- **Privacy.**
  - No pixels, landmarks or images ever leave native code.
  - No file writes, no image encoding, no photo library or media store, no network.
  - Logging goes only through `DmsLog.code(<enum>)`, with static codes and no values.
  - Pixel buffers and bitmaps are released per frame (in `finally`).
- **Silence while moving (SR9).** A failure never produces a notification, sound or modal. It becomes a `state` event and a status.
- **Battery.**
  - With no `start` in effect there is no camera session, no model in memory, no timer and no listener.
  - Native drives the camera at the policy's rate (it does not capture 30 fps and throw frames away).
  - One detection is in flight at a time; frames arriving while it is busy are dropped, never queued.

## 2. API

| Method | Behaviour |
|---|---|
| `isAvailable()` | JS only: whether the native module is linked into this binary. |
| `getPermission()` | `{ status: 'granted' \| 'denied' \| 'undetermined', canAskAgain }` for the camera. |
| `requestPermission()` | Shows the OS prompt when `undetermined`; resolves the same shape. |
| `start(options)` | `{ gateToken, fps, gazeNet, gazeNetEvery, delegate, rotationOffsetDegrees }` (§2.1). Loads the models if released, starts the session, resolves once running. Registers `gateToken` for the session. Rejects `E_BAD_ARGS` (a missing or empty token, a value outside its set), `E_PERMISSION`, `E_NOT_FOREGROUND`, `E_MODEL`, `E_CAMERA`. While already running: the same token is idempotent and applies the options as a policy; another token → `E_BAD_ARGS`. `gazeNet: true` on a build without the net is **not** an error: `status.gazeNetAvailable` is false and no record carries `NET_RAN`. |
| `setPolicy(policy)` | `{ gateToken, capture: 'run' \| 'pause', fps, gazeNet, gazeNetEvery, setupMode, previewAllowed }`. Also the **heartbeat** (§6). Rejects `E_STATE` while stopped, and `E_BAD_ARGS` when the token differs from the registered one. The thermal floor overrides it. |
| `stop()` | Stops the session, releases both models and every timer, clears the token. Idempotent. |
| `getStatus()` | The current `NativeStatus` (§3). |
| `getModelInfo()` | `{ landmarkerSha256, gazeNetAvailable, gazeSha256, mediapipe: '0.10.35', onnxruntime }`. `gazeSha256` and `onnxruntime` are `null` exactly when `gazeNetAvailable` is false. The digests are computed on first call and cached (diagnostics only). |
| `selfTest(vectorsJson)` | Runs the **production** feature classes over the golden vectors (Task 2 adds §8). |

### 2.1 Values

- `fps` ∈ {5, 8, 10, 15}; `gazeNetEvery` ∈ {1, 2}; `delegate` ∈ {`cpu`, `gpu`} (`gpu` is for diagnostics only); `rotationOffsetDegrees` ∈ {0, 90, 180, 270}.
- `gateToken` is a non-empty string minted only by the DMS policy's `gateOpen()`. Native checks only that it is present and consistent. It is defence in depth against a stray caller, not authentication.

### Errors

| Code | When |
|---|---|
| `E_UNAVAILABLE` | JS only: the native module is not in this binary (Jest, Expo Go, web). |
| `E_PERMISSION` | `start` without the camera permission. |
| `E_NOT_FOREGROUND` | `start` while the app is not active. |
| `E_BAD_ARGS` | An argument outside the contract, or a missing or mismatched gate token. |
| `E_CAMERA` | The camera could not be opened or configured. |
| `E_MODEL` | A bundled model could not be loaded. |
| `E_STATE` | `setPolicy` while stopped. |
| `E_RESULT` | JS only: native returned a result outside the contract. This is a native bug, and the message names the method. |

## 3. Events

| Event | Payload |
|---|---|
| `frames` | `{ v: 1, anchorTMs, anchorEpochMs, n, data }`. `data` holds `n` records of 38 little-endian float32 (§4). It is emitted at most every `BATCH_MS = 100` ms while records are pending, and never while paused or stopped. **`anchorTMs` is a double (Swift `Double`, Kotlin `Double`): the FIRST record's clock value in ms.** `anchorEpochMs` (a double) is the wall clock sampled together with it (§5). `data` is `Data` (iOS) / `ByteArray` (Android), which JS receives as a `Uint8Array`. The decoder also accepts an `ArrayBuffer` or another typed-array view. |
| `status` | Once per second while running or paused: `{ state, fpsTarget, fpsActual, dropped, gazeNetAvailable, gazeNetOn, thermal, thermalLevel, lowPower, latLandmarkP50, latLandmarkP95, latGazeP50, latGazeP95, latTotalP50, latTotalP95, procCpuMsPerS }`. Latencies are `null` until measured (`latGaze*` while the net is off). `procCpuMsPerS` is **process** CPU (iOS `getrusage(RUSAGE_SELF)`, Android `Process.getElapsedCpuTime()`), because MediaPipe runs on threads the module does not own. |
| `state` | On every change: `{ state: 'stopped' \| 'starting' \| 'running' \| 'paused', reason: 'user' \| 'policy' \| 'background' \| 'interrupted' \| 'thermal' \| 'watchdog' \| 'error' \| 'permission' \| 'released' }`. |

## 4. The frame record (wire v1, frozen at the D1 build)

`FRAME_BYTES = 152`: 38 little-endian float32 per record, in this order. **NaN is the only
"not computed" value, and it is required exactly where the mask class says:**
- **A:** always finite.
- **F:** NaN ⇔ no face.
- **P:** NaN ⇔ no face or `POSE_MISSING`.
- **N:** finite ⇔ `NET_RAN`.
- **R** / **L:** NaN ⇔ no face or `EYE_CLIPPED_R` / `EYE_CLIPPED_L`.
- **M:** NaN ⇔ no face or `MOUTH_CLIPPED`.

±Infinity is never valid.

| # | Field | Mask | Meaning |
|---|---|---|---|
| 0 | `tOffMs` | A | the record's time minus the header's `anchorTMs`, ms: 0 ≤ `tOffMs` ≤ `MAX_T_OFF_MS = 10000` (a larger one is dropped as implausible), and under a second in practice (§5) |
| 1 | `face` | A | 0 or 1 |
| 2 | `boxCx` | F | face box centre x, upright frame, 0–1 |
| 3 | `boxCy` | F | face box centre y |
| 4 | `boxW` | F | face box width |
| 5 | `boxH` | F | face box height |
| 6 | `iod` | F | inter-ocular distance (33–263), upright-width units |
| 7 | `headYaw` | P | degrees, camera frame, + toward image right |
| 8 | `headPitch` | P | degrees, + up |
| 9 | `headRoll` | P | degrees, + clockwise in the upright image |
| 10 | `netYaw` | N | `gaze_direct` gaze, degrees, camera frame |
| 11 | `netPitch` | N | `gaze_direct` gaze, degrees, + up |
| 12 | `earR` | R | 6-point eye aspect ratio, subject-right eye (landmark 33 side) |
| 13 | `earL` | L | left eye |
| 14 | `eyeWR` | R | eye corner width, px of the upright frame |
| 15 | `eyeWL` | L | |
| 16 | `eyeLumaR` | R | eye ROI mean luma ÷ face ROI mean luma |
| 17 | `eyeLumaL` | L | |
| 18 | `irisContrastR` | R | sclera-ring luma − iris-disk luma, 0–255 |
| 19 | `irisContrastL` | L | |
| 20 | `eyeSatR` | R | fraction of eye ROI pixels with luma ≥ 250 |
| 21 | `eyeSatL` | L | |
| 22 | `irisOxR` | R | iris offset along û, in eye widths (below) |
| 23 | `irisOyR` | R | iris offset along v̂, in eye widths |
| 24 | `irisOxL` | L | |
| 25 | `irisOyL` | L | |
| 26 | `irisInR` | F | 0/1: the iris centre lies inside the eye contour and the image; 0 when that eye is clipped |
| 27 | `irisInL` | F | |
| 28 | `faceLuma` | F | face ROI mean luma, 0–255 |
| 29 | `blur` | F | 3×3 Laplacian variance over the face box resampled to 64×64 luma |
| 30 | `mar` | M | inner-lip gap (13–14) ÷ mouth width (61–291) |
| 31 | `mouthW` | M | mouth width (61–291) ÷ IOD |
| 32 | `frameLuma` | A | whole-frame mean luma (every 8th pixel of every 8th row), 0–255 |
| 33 | `rotationDeg` | A | the buffer → upright rotation applied to this frame (incl. `rotationOffsetDegrees`): 0, 90, 180 or 270 |
| 34 | `latLandmarkMs` | A | MediaPipe submit → result, ms |
| 35 | `latTotalMs` | A | capture timestamp → record queued, ms |
| 36 | `flags` | A | integer bits: `NET_RAN` 1, `EYE_CLIPPED_R` 2, `EYE_CLIPPED_L` 4, `MOUTH_CLIPPED` 8, `POSE_MISSING` 16. **0 when there is no face.** |
| 37 | `reserved` | A | 0 |

**Iris offsets, per eye, in the upright frame, aspect-corrected (x and y both in upright-width units):**
- `u` = the unit vector from the eye's outer corner to its inner corner (right eye 33 → 133, left eye 263 → 362).
- `s = +1` (right eye) or `−1` (left eye), so **`û = s·u` points toward image right for both eyes**.
- **`v̂` is `û` rotated 90° toward image-up**: in (x, y-down) coordinates `v̂ = (û.y, −û.x)`.
- `w` = the corner distance; `m` = the corner midpoint; `c` = the iris centre (468 right, 473 left).
- `irisOx = ((c − m)·û) / w` and `irisOy = ((c − m)·v̂) / w`. Positive means image right and image up, for **both** eyes.
- Native computes the offsets for every eye that is not clipped. Deciding whether an eye is reliable, which eye is the near one, and the gaze itself are **engine** decisions (`src/core/dms/engine`), never native ones.

**Rules:**
- A face-absent frame is still emitted, one record per processed frame, so the engine sees time pass.
- JS drops and counts a record that breaks any rule, and keeps the rest of its batch.
- Only a broken header (`v`, `n × FRAME_BYTES ≠ byteLength`, unknown keys, non-finite anchors) drops a batch.
- A record earlier than the previous accepted one is dropped.

## 5. Time bases

The record clock `tMs` counts from device boot, so it is large, and it is **never** put in a float32. Float32 holds whole milliseconds only up to 2²⁴ ms (4.66 h of uptime), and steps by 64 ms after a week. So:
- the batch header carries `anchorTMs` as a double: the first record's `tMs`;
- each record carries `tOffMs = tMs − anchorTMs` as a float32, computed in double precision natively before the float32 store;
- JS rebuilds `tMs = anchorTMs + tOffMs` in double precision.

Per platform:
- **iOS:** `tMs` = the `CMSampleBuffer` presentation timestamp on the host-time clock, in ms. `anchorEpochMs` is derived at the batch's first frame by sampling `CACurrentMediaTime()` (the same clock) and `Date()` together: `anchorEpochMs = dateMs − (nowMs − anchorTMs)`.
- **Android:** `tMs` = `ImageInfo.timestamp` / 1e6. At session start native picks the timestamp base: whichever of `SystemClock.elapsedRealtimeNanos()` or `SystemClock.uptimeNanos()` lies within 1 s of the first frame's timestamp. `anchorEpochMs` is derived the same way from that clock and `System.currentTimeMillis()`.
- Every duration the engine measures uses `tMs`, never frame counts.
- **Per session.** The clock base can differ between native sessions (a restart after a stop may pick the other Android base). JS keeps `tMs` monotonic only within one session: the host resets its last-accepted `tMs` to null on every new session (`state` → `starting`/`running` after `stopped`).

## 6. Lifecycle owned by native

These hold whatever JavaScript does.

- **Background:** the app leaving the foreground stops the session (`state stopped/background`) and clears the token (iOS `OnAppEntersBackground`, Android `OnActivityEntersBackground`). Native never restarts by itself.
- **Watchdog:** no `setPolicy` for `WATCHDOG_PAUSE_MS = 10000` while running → `paused/watchdog`. Another `WATCHDOG_STOP_MS = 60000` with no heartbeat → `stopped/watchdog`, and everything is released. A `setPolicy` with `capture: 'run'` resumes a watchdog pause.
- **Release:** paused for `MODEL_RELEASE_AFTER_PAUSE_MS = 300000` → the models are released and the state becomes `stopped/released`.
- **Thermal floor:**
  - level 1 (iOS `fair`, Android `MODERATE`), after the OS state has held for `THERMAL_L1_ENTRY_DWELL_MS = 60000`: at most 8 fps;
  - level 2 (`serious` / `SEVERE`), at once: at most 8 fps with the net off;
  - level 3 (`critical` / `CRITICAL`, `EMERGENCY`, `SHUTDOWN`), at once: `paused/thermal`, and a `run` policy cannot resume it while level 3 holds.
  - A cooler state must hold for `THERMAL_COOL_DWELL_MS = 60000` before the floor steps down.
- **Interruptions:** the OS taking the camera → `paused/interrupted`, or `paused/error` for a camera error. JS decides whether to restart.
- **Preview (C2):** attached only while the latest policy has both `setupMode` and `previewAllowed` true. It is detached on the next policy without them, and on pause, stop and watchdog.
- The DMS policy pauses the camera after `PAUSE_AFTER_STOP_MS = 5000` at a known stop. That is the policy's rule, not native's; it is listed here because the numbers live together.

## 7. The gaze-net release gate

`gaze_direct.onnx`, its meta file, ONNX Runtime and the Swift/Kotlin that uses them are compiled and bundled **only** when the build environment has `DMS_GAZE_NET=1`.
- **iOS** (`ios/DmsVision.podspec`, evaluated at `pod install`): with the switch, it adds `onnxruntime-objc 1.30.0`, the `GazeNetResources/*` resources, the `GazeNet/**` sources and the compilation condition `DMS_GAZE_NET`. Without it, it compiles `GazeNetStub/**` instead.
- **Android** (`android/build.gradle`): with the switch (or `-PdmsGazeNet=1`), it adds `onnxruntime-android 1.30.0`, `src/gazenet/java` and `src/gazenet/assets`. Without it, it adds `src/nogazenet/java`.
- **The stub** reports `available = false`, so `getModelInfo().gazeNetAvailable` is false, `gazeSha256` and `onnxruntime` are null, and no record carries `NET_RAN`.
- **Refusal:** the podspec raises and Gradle throws `DMS_GAZE_NET=1 is refused in a production build (release gate, U-2)` when the switch meets `EAS_BUILD_PROFILE=production`. Gradle also throws on any `release` task with no EAS profile.
- **Profiles:** only the `development` EAS profile sets the switch. `preview` and `production` build without it.
- **Provenance:** see `THIRD_PARTY.md`. The training data is unknown, which blocks the gate.

## 8. The per-frame feature pass, the golden vectors and the self-test

### 8.1 What native computes (the TS reference is binding)

`src/reference/` is the reference implementation the Swift and Kotlin ports reproduce. Port each file's logic verbatim, including the index lists, thresholds and orders of operation:

| Reference | Native class (both platforms) | What it does |
|---|---|---|
| `landmarks.ts` | part of `FeatureExtractor` | index sets; buffer → upright landmark rotation |
| `features.ts`, `irisOffset.ts` | `FeatureExtractor` | box, IOD, per-eye EAR, width, iris offsets, iris-inside, clipping; MAR and mouth width. All on UPRIGHT landmarks, in upright PIXELS |
| `roi.ts` | `Roi` | BT.601 integer luma; frame, face and eye luma statistics, iris contrast, glare, blur. All in the BUFFER frame, on MediaPipe's buffer-frame landmarks |
| `headPose.ts` | `HeadPose` | pose from the column-major facial transformation matrix, rotated upright; the net's vector → angles |
| `record.ts` | `FeatureExtractor` + `RecordEncoder` | the whole record, per the §4 mask |
| `gazeInputs.ts`, `decayingHistogram.ts` | `GazeInputs`, `StatsTracker` | the net's inputs, and the subject-statistic tracker (net builds only run the net, but both platforms port the assembly) |
| `wire.ts` `buildFrameBatch` | `Batcher` + `RecordEncoder` | `anchorTMs` = the first record's `tMs` (Double); `tOffMs = tMs − anchorTMs` in Double, then stored as Float |

**Porting rules:**
- Compute in `Double` and store each record field as `Float` at the end.
- MediaPipe landmarks and matrices arrive as `Float`; widen them to `Double` before any arithmetic.
- `probe(...)` calls are test instrumentation. Do not port them.
- `pairwiseSum` may be a plain left-to-right sum.
- Luma is read per pixel inside each region. Never build a full-frame luma plane.
- Pixels are BGRA on iOS (`kCVPixelFormatType_32BGRA`) and RGBA on Android (`OUTPUT_IMAGE_FORMAT_RGBA_8888`). Honour the row stride, which may exceed `width × 4`.
- The net's statistic tracker admits a frame only when neither eye is clipped and the mean raw EAR is at least `0.18`.
- `prepare` uses the tracker state **before** the frame.
- The tracker time is the record clock in seconds.
- The tracker is reset on every new session.

### 8.2 The golden vectors (`assets/vectors/*.json`)

Regenerate them with `node --experimental-strip-types --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON modules/dms-vision/scripts/make-vectors.ts`. When the ONNX inputs change, also run `scripts/make-onnx-vectors.py` (Python onnxruntime 1.30.0 in a throwaway venv), then `make-vectors.ts` again. Never edit the files by hand. `__tests__/vectors.test.ts` fails when a file differs from a fresh generation.

| Kind | Inputs | Native returns |
|---|---|---|
| `record` | `images` (w, h, `bgra`\|`rgba`, base64 pixels, tightly packed); `frames` (tMs, image index, rotationDeg, buffer-frame landmarks or null, buffer-frame matrix or null, the net's vector or null, latencies); `anchorEpochMs` | `batch: { anchorTMs, anchorEpochMs, n, data }`. That is the production encoder's batch of all frames, with `data` in base64 and `anchorEpochMs` echoed from the input |
| `gazeInputs` | width, height, focalScale, frames (tSec, **upright** landmarks) | `frames: [{ cloud, context, validity, admitted }]` |
| `statsTracker` | trainingMean, warmup, windowS, t[], pushes[] (null = NaN) | `current: [[4]…]` |
| `headPose` | cases (column-major matrix, rotationDeg) | `poses: [[yaw, pitch, roll]…]` |
| `onnx` | cases (cloud, context, validity) | `cases: [{ gaze[3], rotation[9] }]`. A build without the net answers `skipped` |

The vectors are synthetic (`THIRD_PARTY.md`). The generator refuses any vector in which a threshold comparison lies within `MARGIN_MIN = 1e-6` (relative) of its threshold.

### 8.3 The self-test protocol

1. JS (the diagnostics panel) validates the vector files with `parseVectors` and calls `selfTest(JSON.stringify(vectors))`.
2. Native runs its **production** classes over each vector. It never runs a copy kept for testing. The ports' selfTest must go through the same `FeatureExtractor`, `Roi`, `HeadPose`, `RecordEncoder`, `GazeInputs` and `GazeNet` the camera path uses.
3. Native resolves one JSON string:
   ```jsonc
   { "version": 1, "platform": "ios" | "android", "gazeNetAvailable": bool,
     "results": [ { "name", "kind", ...output } | { "name", "kind", "error": "message" }
                | { "name", "kind": "onnx", "skipped": "reason" } ] }   // one per vector, in order
   ```
   A vector that throws natively yields the `error` form. The promise rejects (`E_BAD_ARGS`) only if the input is not parseable at all.
4. JS diffs the output with `diffSelfTest(vectors, outputJson)`.
   - Numbers must satisfy |native − expected| ≤ 1e-4 + 1e-5·|expected|. A record's time is held to an absolute 1e-3 ms.
   - Nulls (NaN) and lengths must match exactly.
   - A record batch must decode with 0 dropped records.
   - `skipped` is accepted only for `onnx`, and only when `gazeNetAvailable` is false.

## 9. JS usage

```ts
import DmsVision, { decodeFrameBatch, createFakeDmsVision } from '../../../modules/dms-vision';
```

Only the DMS host controller (`src/core/dms/host`) and the dev diagnostics route import this module. Tests inject `createFakeDmsVision({ gazeNetAvailable, permission, asyncDelivery })`. The fake follows this contract:
- it rejects what native rejects;
- frames flow only while running;
- it stops on `setForeground(false)`;
- it runs the watchdog, release and thermal dwells on its own clock (`advance(ms)`).
