# `modules/dms-vision`

> **Carried over from V1.** This module was kept intact for the camera-coaching milestone. The
> JavaScript side it describes below — `dms/gaze_inputs.js`, the rule engine under `dms/`, the
> parity fixture `dms/tests/fixtures/onnx_parity.json` and the design notes in
> `docs/dms/NATIVE_LAYER.md` — belonged to the V1 app and does not exist in V2 yet; it is rebuilt
> when camera coaching is wired in. The native API documented here is unchanged.

The on-device inference layer of the driver-monitoring feature: one local Expo Module that owns
the front camera, runs MediaPipe `FaceLandmarker` once per processed frame and runs the
`gaze_direct` network through ONNX Runtime. JavaScript never sees a pixel — it receives one
`onFrame` event per processed frame carrying the 478×3 landmark cloud plus the camera scalars the
network needs, and calls `predictGaze` with the tensors `dms/gaze_inputs.js` assembles.

Autolinked from `./modules` (Expo autolinking's default `nativeModulesDir`); nothing needs to be
added to `app.config.ts`. Requires a development build — it cannot work in Expo Go or on web.

```
modules/dms-vision/
  expo-module.config.json                      platforms + module class names
  index.js                                     re-exports src/index.js
  src/index.js                                 the JS wrapper (this file's API section)
  ios/DmsVision.podspec                        pinned pods + resource_bundles
  ios/DmsVisionModule.swift                    module definition, events, status timer
  ios/DmsVisionPipeline.swift                  AVCaptureSession + FaceLandmarker
  ios/DmsVisionGaze.swift                      ONNX Runtime session
  ios/DmsVisionSupport.swift                   bundle lookup, rotation, intrinsics, thermal
  ios/Resources/                               face_landmarker.task, gaze_direct.onnx, meta.json
  android/build.gradle                         pinned Maven deps
  android/src/main/AndroidManifest.xml         CAMERA permission
  android/src/main/assets/                     the same three model files
  android/src/main/java/expo/modules/dmsvision/
      DmsVisionModule.kt                       module definition, events, status timer, thermal
      DmsVisionPipeline.kt                     CameraX ImageAnalysis + FaceLandmarker
      DmsVisionGaze.kt                         ONNX Runtime session
      DmsVisionSupport.kt                      assets, rotation, intrinsics, thermal
  THIRD_PARTY.md                               prior art and licences
```

## Pinned native versions

| Dependency | Version | Verified on |
|---|---|---|
| `MediaPipeTasksVision` (iOS pod) | **0.10.35** | CocoaPods trunk API, published 2026-04-27; podspec `ios >= 15.0`, static framework |
| `com.google.mediapipe:tasks-vision` (Android) | **0.10.35** | Google Maven `maven-metadata.xml`; pulls `tasks-core:0.10.35` (the native graph) |
| `onnxruntime-objc` (iOS pod) | **1.30.0** | CocoaPods trunk API, published 2026-09-11; podspec `ios >= 15.1`, pulls `onnxruntime-c` 1.30.0 |
| `com.microsoft.onnxruntime:onnxruntime-android` | **1.30.0** | Maven Central `maven-metadata.xml` |
| `androidx.camera:camera-core / -camera2 / -lifecycle` | **1.4.2** | Google Maven; `camera-core-1.4.2.aar` declares `minCompileSdk=34` |

Nothing uses a dynamic version (`0.10.+`, `latest.integration`, `~> 0.10`): EAS builds must be
reproducible, and an optimistic operator is how the same source produces two different binaries a
month apart.

`MediaPipeTasksVision` 1.0.0 and `tasks-vision` 1.0.0 exist and are newer; 0.10.35 is pinned
because it is the version whose headers and rotation semantics were verified line by line for this
module (and the version of the `mediapipe` Python package the research pipeline runs).

## How the models are bundled

The three files are **native resources**, not downloads and not `expo-asset` copies:

* iOS — `s.resource_bundles = { 'DmsVision' => ['Resources/*'] }` in the podspec.
  `DmsVisionBundle` resolves them from the framework bundle, the main bundle's `DmsVision.bundle`
  and the main bundle root, so both CocoaPods linkage modes work.
* Android — `android/src/main/assets/`. The `.task` is handed to MediaPipe as a **direct
  `ByteBuffer`** (`BaseOptions.setModelAssetBuffer`) and the `.onnx` to ONNX Runtime as a byte
  array, so nothing depends on the asset being stored uncompressed and nothing is copied to the
  cache directory.

`assets/models/` (the JS-bundled copies) is kept as the source of truth. After replacing a
promoted checkpoint, re-copy it into both native locations and run:

```
node scripts/check-models.js
```

which fails loudly if the three copies differ or if `gaze_direct.onnx` no longer matches
`gaze_direct.meta.json`'s `onnx_sha256`.

## API

```js
import DmsVision from '../modules/dms-vision';
```

| Member | Notes |
|---|---|
| `isAvailable()` | `false` in Expo Go / web; every other call except `stop()` and `getThermalState()` throws there |
| `getPermissionsAsync()` / `requestPermissionsAsync()` | `{ status, granted, canAskAgain, expires }` for the camera |
| `start(options)` | `{ targetFps = 20, facing = 'front', landmarkFrame = 'upright', mirrorPair = false, rotationOffsetDegrees = 0 }` |
| `stop()` | idempotent, resolves even when unavailable |
| `setTargetFps(fps)` | synchronous; clamped to 1–30 |
| `setIdleMode(bool)` | true → ~5 fps |
| `getIntrinsics()` | `{ focalScale, intrinsicsSource, fx, fy, cx, cy, bufferWidth, bufferHeight, width, height, rotationDegrees, orientation, isMirrored }` for the most recent frame. `focalScale`, `orientation` and `isMirrored` are **null until a frame has been processed** (before that they would be placeholders, and the rule engine is built from them - docs/dms/NATIVE_LAYER.md §4) |
| `getThermalState()` | `'nominal' \| 'fair' \| 'serious' \| 'critical' \| 'unknown'` |
| `getModelInfo()` | `{ onnxSha256, parameters }` from the bundled meta.json |
| `predictGaze(cloudF32, contextF32, validityF32)` | `Promise<{ gaze: Float32Array(3), rotation: Float32Array(9) }>`; 1434 / 7 / 478 floats in |
| `addFrameListener(cb)` | `cb({ t, width, height, facePresent, score, isMirrored, focalScale, intrinsicsSource, orientation, landmarks })`; `landmarks` is a `Float32Array(1434)` or `null` |
| `addStatusListener(cb)` | `cb({ thermal, lowPower, fps, dropped, running })`, once per second while running |
| `addErrorListener(cb)` | `cb({ code, message })`: `FRAME_CONVERSION_FAILED`, `INFERENCE_FAILED`, and — when the OS takes the camera away — `CAMERA_INTERRUPTED` / `CAMERA_RUNTIME_ERROR` (iOS) or `CAMERA_CLOSED` (Android). The interruption cases also emit an `onStatus` with `running: false` |
| `selfTest(parityFixture)` | runs the 8 cases of `dms/tests/fixtures/onnx_parity.json` → `{ cases, maxAbsGaze, maxAbsRotation, ok }` |

`mirrorPair: true` is **rejected**. The promoted research recipe runs the mesh twice (frame and
horizontally flipped frame, averaged through the 478-point mirror permutation) and is worth about
0.32° of LBW error; it is out of scope for this version. The TODO markers are in
`DmsVisionModule.swift` / `DmsVisionModule.kt` and the work belongs in the pipeline, not in JS.

`rotationOffsetDegrees` is an escape hatch, not a feature — see "What the owner must verify".

### Conventions

* Landmarks are MediaPipe normalized `(x / W, y / H, z / W)` of the **upright** image, matching
  `dms/gaze_inputs.js` and the research pipeline. MediaPipe returns them in the *unrotated buffer*
  frame; the native layer rotates them.
* `t` is seconds since the first processed frame of the session, from the camera clock — never
  `Date.now()` of the JS callback.
* `focalScale = fx / uprightWidth`, principal point assumed at the frame centre.
* Every float buffer crossing the bridge is little-endian `float32`; the JS wrapper re-views it as
  `Float32Array` and copies when `byteOffset % 4 !== 0`.
* `isMirrored` is reported honestly. It is `false` on Android (CameraX's
  `ImageAnalysis.Builder.setMirrorMode` throws "setMirrorMode is not supported") and is read back
  from `connection.isVideoMirrored` after configuration on iOS, where mirroring is switched off
  explicitly.

### Camera configuration

Front camera, the lowest format whose long side is ≥ 640 px at 30 fps, zoom 1.0, video
stabilisation off (it stops iOS delivering the intrinsic matrix), no preview surface, no physical
buffer rotation, and exactly one MediaPipe detection in flight — frames that arrive while it is
busy are dropped, never queued.

## What the owner must verify on a device

Everything below was written blind against vendor headers and cannot be confirmed without a build.
`docs/dms/NATIVE_LAYER.md` has the full list with confidence levels; this is the short checklist.

1. **Build 1 — it links.** `npx expo prebuild --clean` then an EAS development build for both
   platforms. Failures here are podspec / Gradle / autolinking, not logic.
2. **Parity.** `await DmsVision.selfTest(require('../dms/tests/fixtures/onnx_parity.json'))` →
   `ok: true` with `maxAbsGaze` and `maxAbsRotation` ≤ 1e-4. This proves the on-device ONNX
   Runtime reproduces the research pipeline.
3. **Orientation.** Hold the phone in portrait with a face in view and log
   `getIntrinsics().rotationDegrees` plus, from one `onFrame`, the outer-eye corner landmarks
   (indices 33 and 263): in the upright frame their `y` values must be nearly equal and
   `landmarks[33*3] < landmarks[263*3]`. If the face comes out sideways, re-run with
   `start({ landmarkFrame: 'buffer' })` to see the raw MediaPipe frame, then set
   `rotationOffsetDegrees` to whatever multiple of 90 fixes it and report the value so the default
   table can be corrected. iOS is the one at risk (Android reads the rotation from CameraX).
4. **Mirroring.** Cover one eye. With `isMirrored: false` the covered eye must appear on the
   *opposite* side of the image from the side of the driver's face it is on
   (`image_right_is_driver_left`). If `getIntrinsics().isMirrored` ever comes back `true` on iOS,
   stop and report it — every asymmetric zone in `dms/` depends on this bit.
5. **Intrinsics sanity.** `getIntrinsics()` should report `intrinsicsSource: 'intrinsics'` on both
   platforms on most phones. Check `fx ≈ (W/2) / tan(hfov/2)`: for a typical 70–80° front camera
   and a 640×480 buffer, `fx` lands at 380–460 px and `focalScale` (portrait) at 0.79–0.96. A
   `focalScale` outside 0.5–1.5 means the formula picked the wrong crop; report the whole object.
6. **Cadence and thermal.** `addStatusListener` should report `fps` near `targetFps` with a small
   `dropped` count. On a 20-minute dash-mounted drive watch `thermal` go `nominal → fair → …` and
   confirm `setIdleMode(true)` drops the rate.

## Known unverified

* Whether `MediaPipeTasksVision` 0.10.35 and `onnxruntime-objc` 1.30.0 link into one iOS binary
  without duplicate symbols. ORT has no symbol overlap with TFLite, so this is expected to be
  fine, but it has not been built.
* Whether a local module's podspec `resource_bundles` lands in the framework bundle or the app
  bundle under Expo's default (non-`use_frameworks!`) Podfile. Both are searched, so this should
  not matter.
* The iOS buffer→upright rotation table (portrait → 90° clockwise). Reasoned from AVFoundation's
  documented `videoRotationAngle` ↔ `AVCaptureVideoOrientation` mapping plus the `.right` /
  `.leftMirrored` recipes; `rotationOffsetDegrees` exists because of it.
* Whether `isCameraIntrinsicMatrixDeliverySupported` is true for the front camera on the owner's
  devices (it is device-dependent). The `videoFieldOfView` fallback and the 70° default are wired.
* Real fps and thermal behaviour. The research budget is ~8–25 ms for the gaze net plus ~5–15 ms
  per mesh pass on a phone CPU; 20 fps is a target to measure, not a prediction.
* That `ProcessCameraProvider.bindToLifecycle` with no `Preview` use case keeps streaming with the
  screen on but nothing rendered (it should — `ImageAnalysis` is a full use case).
