# The native layer — `modules/dms-vision`

Status: written 2026-09-18, **never compiled**. There is no Xcode and no Android SDK on the
machine this was written on; every Swift and Kotlin line was written against vendor headers and
published sources, and the first EAS build is the first compile. Companion documents:
`DETECTION_DESIGN.md` (§2 the per-frame record, §3 cadence, §4 focal scale),
`research/mobile_inference_options.md` (why an Expo Module and why ONNX Runtime),
`modules/dms-vision/README.md` (the API and the pinned versions).

---

## 1. What the module is

One local Expo Module, autolinked from `./modules`, that owns the front camera and both networks:

```
camera frame (no preview)
  -> MediaPipe FaceLandmarker, LIVE_STREAM, one pass          [native]
  -> 478 x 3 upright-normalized landmarks + camera scalars    -> onFrame event
  -> dms/gaze_inputs.js: cloud / context / validity           [JS]
  -> DmsVision.predictGaze -> ONNX Runtime, batch 1           [native]
  -> gaze(3) + rotation(9)                                    -> dms/monitor.js
```

JavaScript never sees a pixel. Per processed frame the bridge carries 1,434 + 7 + 478 floats in
and 12 out, about 30 KB at 20 fps in each direction.

The split is deliberate: the tensor pre-processing stays in JS because it is a fixture-tested
verbatim port of the reference stack and carries the stateful subject statistic, while the camera,
the mesh and the network are native because Expo SDK 53 exposes no frame API and because the
alternative (`onnxruntime-react-native`) ships unpinned native dependencies, a legacy bridge
module and an open iOS teardown crash.

---

## 2. Coordinate conventions

These must match `dms/gaze_inputs.js` and the research pipeline exactly. They are the part of this
module most likely to be silently wrong.

| Quantity | Convention |
|---|---|
| `landmarks` | MediaPipe normalized `(x / W, y / H, z / W)` of the **upright** image, point-major, 478 × 3 float32 little-endian |
| `width` / `height` | the **upright** image size in pixels (the buffer's short/long sides swap in portrait) |
| `t` | seconds since the first processed frame of the session, from the camera clock |
| `focalScale` | `fx / uprightWidth`, principal point assumed at the frame centre |
| `isMirrored` | true when the delivered image is a mirror of the scene; `image_right_is_driver_left = !isMirrored` |
| `orientation` | `'portrait' \| 'portraitUpsideDown' \| 'landscapeLeft' \| 'landscapeRight'`, the same PHYSICAL pose on both platforms (§2.3) |

### 2.1 Rotation: metadata in, landmarks out

Pixels are never rotated. The device orientation goes to MediaPipe as metadata —
`ImageProcessingOptions.rotationDegrees` on Android, `MPImage.orientation` on iOS — and the
landmarks come back **in the unrotated buffer frame**, so the module rotates them itself.

For a buffer that must be rotated `R` degrees clockwise to be upright:

| R | upright x | upright y | upright size |
|---|---|---|---|
| 0 | `x_b` | `y_b` | `W_b × H_b` |
| 90 | `1 − y_b` | `x_b` | `H_b × W_b` |
| 180 | `1 − x_b` | `1 − y_b` | `W_b × H_b` |
| 270 | `y_b` | `1 − x_b` | `H_b × W_b` |

**`z` is left alone.** This is a deliberate, measured deviation from the original brief, which
specified `z_u = z_b × (bufferWidth / bufferHeight)` when the rotation swaps the axes.

*Why.* MediaPipe scales the returned `z` by `CalculateZScale` in
`calculators/util/landmark_projection_calculator.cc`: the length, measured in the output
`(x / W, y / H)` frame, of the projected unit x-axis of the **face ROI**. The ROI's rotation
tracks the face (it is built from the detector's eye keypoints), not the image axes, so for a
sideways face in a landscape buffer that projected segment is vertical and its length is
`roi_width_px / H_b` — which is already `roi_width_px / uprightWidth`. Multiplying by
`W_b / H_b` would introduce a 4/3 error in the depth column that the gaze network reads.

*Measured.* A probe run against `mediapipe 0.10.35` and this exact `face_landmarker.task`
(2026-09-18, four face images, 480 × 640 upright reference vs the physically rotated 640 × 480
buffer with `rotation_degrees` set):

| R | `max abs` xy after the transform | `max abs` xy raw | `max abs` `z_b − z_ref` | `max abs` `z_b·W_b/H_b − z_ref` |
|---|---|---|---|---|
| 90 | 0.0037–0.0047 | 0.278–0.338 | 0.0004–0.019 | 0.054–0.080 |
| 270 | 0.0027–0.0040 | 0.277–0.337 | 0.0003–0.029 | 0.055–0.081 |
| 180 | 0.0040–0.0054 | 0.445–0.455 | 0.0030–0.030 | 0.040–0.061 |

The residual after the transform is detector noise from the resampling — the same magnitude as
the `z` residual. The raw column confirms the premise that the landmarks are in the unrotated
frame. (Only `face_detector` and `object_detector` docstrings say "expressed in the unrotated
input frame of reference"; `face_landmarker` does not, which is why this was measured rather than
assumed. The seed package `expo-mediapipe@0.4.1` records the same behaviour from the other side —
it tried `ImageProcessingOptions` rotation, saw "misaligned landmarks" because it did **not**
rotate the results, and reverted to rotating the bitmap.)

`start({ landmarkFrame: 'buffer' })` skips the transform and reports the raw MediaPipe frame and
the buffer's size. It exists for the device harness in §6.

### 2.2 Where R comes from

**Android** reads it: `ImageInfo.getRotationDegrees()` is documented as "a clockwise rotation in
degrees that needs to be applied to the image buffer", and
`ImageProcessingOptions.Builder.setRotationDegrees` is documented as clockwise. The app is
portrait-locked, so `Display.getRotation()` never changes; an `OrientationEventListener` updates
`ImageAnalysis.setTargetRotation` instead (the mapping is verbatim from the CameraX rotations
guidance), which is what makes `rotationDegrees` track a landscape mount.

**iOS** cannot read it, so it is a table over `UIDevice.current.orientation`:

| device orientation | R (clockwise) | `MPImage.orientation` |
|---|---|---|
| portrait | 90 | `.right` |
| landscapeLeft | 0 | `.up` |
| landscapeRight | 180 | `.down` |
| portraitUpsideDown | 270 | `.left` |

The `MPImage.orientation` column is verified against
`mediapipe/tasks/ios/vision/core/sources/MPPVisionTaskRunner.mm` (v0.10.35), which turns `.right`
into a 270° counter-clockwise `NormalizedRect` rotation, i.e. 90° clockwise, `.down` into 180° and
`.left` into 270° clockwise.

The R column is an inference, not a documented fact, and is the single least certain constant in
this module. The chain: AVFoundation's documented `videoRotationAngle` ↔ `AVCaptureVideoOrientation`
mapping is `.landscapeRight` ↔ 0, `.portrait` ↔ 90, `.landscapeLeft` ↔ 180,
`.portraitUpsideDown` ↔ 270; the same numeric angle is applied for the front and the back camera
(AVFoundation does not compensate per camera, which is why setting `.portrait` works on both); the
ubiquitous recipe for an un-rotated back-camera buffer in portrait is `UIImage.Orientation.right`
= 90° clockwise; and the equally ubiquitous front-camera recipe `.leftMirrored` is exactly
`mirror(.right)` in EXIF terms (orientation 5 = mirror of orientation 6), which is what a
*mirrored* front connection delivers. With `isVideoMirrored = false` the geometry is `.right`.

`start({ rotationOffsetDegrees })` adds a multiple of 90 to R on either platform. It is the
one-line fix if the harness says the table is wrong; the default table should then be corrected
and the option dropped back to 0.

**The offset corrects the rotation constant itself, so it applies to BOTH consumers of R** — the
rotation handed to MediaPipe (`ImageProcessingOptions.rotationDegrees` / `MPImage.orientation`)
and the landmark transform above. It is not a post-hoc fix-up of the landmarks: MediaPipe needs
the CORRECT rotation to find the face at all, and the transform needs the same value to put the
result upright. Both platforms do this (iOS composes `base + offset` once, before choosing the
`MPImage.orientation` and before serialising the landmarks; Android adds it to
`ImageInfo.rotationDegrees` once, before `setRotationDegrees` and before the transform). A value
that only reached one of them would silently mean two different frames.

### 2.3 The `orientation` string

The string names the PHYSICAL pose of the device, not the buffer rotation R: R folds in the
per-device sensor orientation (the same portrait mount reads R = 270 on a typical Android front
camera and R = 90 on iOS), so keying anything off R would not survive a second device — and the
string is the key of the persisted forward reference (`@monitorReference:front:{orientation}`,
`INTEGRATION.md` §6), which must mean the same mount every time.

| string | physical pose | iOS `UIDeviceOrientation` | Android `Surface.ROTATION_*` (from `OrientationEventListener`) | iOS R |
|---|---|---|---|---|
| `portrait` | upright, top edge up | `.portrait` | `ROTATION_0` | 90 |
| `landscapeLeft` | turned 90° counter-clockwise (right edge up, home button right) | `.landscapeLeft` | `ROTATION_90` | 0 |
| `portraitUpsideDown` | turned 180° | `.portraitUpsideDown` | `ROTATION_180` | 270 |
| `landscapeRight` | turned 90° clockwise (left edge up, home button left) | `.landscapeRight` | `ROTATION_270` | 180 |

The two platforms' spellings were checked against each other rather than assumed (this is the
classic place for a handedness error, and `UIInterfaceOrientation.landscapeLeft` is the OPPOSITE
pose from `UIDeviceOrientation.landscapeLeft`): Apple defines `UIDeviceOrientation.landscapeLeft`
as "home button on the right", i.e. turned 90° counter-clockwise; CameraX's rotation guidance maps
the sensor angle 225–315 ("right side at the top", also 90° counter-clockwise) to `ROTATION_90`,
because the display rotation is the inverse of the device rotation. Same pose, same string. The
device-facing harness of §6 V4 is what confirms it on hardware.

---

## 3. Camera configuration

| | iOS | Android |
|---|---|---|
| session | `AVCaptureSession`, `.inputPriority` preset, one `AVCaptureVideoDataOutput` on a serial queue, **no** `AVCaptureVideoPreviewLayer` | CameraX `ImageAnalysis` bound to the activity lifecycle, **no** `Preview` use case |
| format | lowest `AVCaptureDevice.Format` with long side ≥ 640 at 30 fps; `activeVideoMin/MaxFrameDuration` = 1/30 | `ResolutionSelector` 4:3 + `ResolutionStrategy(Size(640, 480), FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)` |
| pixels | `kCVPixelFormatType_32BGRA` (what `MPImage(pixelBuffer:)` accepts) | `OUTPUT_IMAGE_FORMAT_RGBA_8888`, one `ImageProxy.toBitmap()` per processed frame |
| backpressure | `alwaysDiscardsLateVideoFrames = true` | `STRATEGY_KEEP_ONLY_LATEST` |
| zoom | `videoZoomFactor = 1.0` | default (no `setZoomRatio` call) |
| stabilisation | `preferredVideoStabilizationMode = .off` — it invalidates the intrinsic matrix and iOS then stops delivering it | n/a |
| mirroring | `automaticallyAdjustsVideoMirroring = false`, `isVideoMirrored = false`, read back after configuration | impossible: `ImageAnalysis.Builder.setMirrorMode` throws `"setMirrorMode is not supported."` |
| rotation | connection rotation left at 0 (never `videoRotationAngle` / `videoOrientation`) | `setOutputImageRotationEnabled` left off (its javadoc costs 10–15 ms per 640 × 480 frame) |

**Cadence.** A frame is accepted only if at least `1 / fps` has passed since the last accepted one
(`targetFps`, default 20; `setIdleMode(true)` → 5) *and* no detection is in flight. MediaPipe's
LIVE_STREAM mode documents that it may drop an input without emitting a result, so a 1 s watchdog
clears the in-flight flag; both paths increment the `dropped` counter reported by `onStatus`. The
pending frame carries the timestamp handed to `detectAsync`, and a result that does not match it
is dropped rather than paired with the metadata of the NEW pending frame (iOS compares the
delegate's `timestampInMilliseconds`, Android the result's own `timestampMs()`).

**Lifecycle.** Neither module has a background handler any more: the JS `AppState` listener is the
single owner of the camera across app-state changes (`INTEGRATION.md` §3), because two owners left
the JS-visible state and the native session disagreeing. The OS still takes the camera away by
itself, and that is now REPORTED instead of hidden: iOS observes
`AVCaptureSessionWasInterrupted` / `RuntimeError` / `InterruptionEnded` and emits `onError`
(`CAMERA_INTERRUPTED`, `CAMERA_RUNTIME_ERROR`) plus an `onStatus` whose `running` is false;
Android observes `CameraInfo.getCameraState()` and emits `onError` (`CAMERA_CLOSED`) when CameraX
closes the camera with an error. The JS watchdog restarts the session when the app is active
again. `dms/monitor.js` is not reset — the reference gap logic applies.

`start()` and `stop()` are serialised on each side (iOS: both run on the pipeline's
`sessionQueue` through `AsyncFunction(...).runOnQueue(_:)`, so neither nests a `sync` on it;
Android: a `ReentrantLock` around both). Android's `stop()` drops the `landmarker` reference
FIRST, so `analyze()`'s `?: return` short-circuits every new frame, then shuts the analysis
executor down and waits up to 500 ms for the frame in flight to leave `analyze()`, and only then
calls `close()`: MediaPipe's `TaskRunner.close()` is not synchronised against `detectAsync()`.
`start()` creates the graph and the thread only AFTER the provider is obtained and releases both
if anything below throws. Nothing blocks the main thread on teardown (both `OnDestroy`s dispatch
the stop), and every wait is bounded (`bindToLifecycle` 2 s, `ProcessCameraProvider.getInstance`
5 s).

**Thermal.** `ProcessInfo.thermalState` plus `thermalStateDidChangeNotification` on iOS;
`PowerManager.getCurrentThermalStatus()` plus `addThermalStatusListener` on Android API 29+,
`'unknown'` below. `LIGHT`/`MODERATE` map to `'fair'`, `SEVERE` to `'serious'`,
`CRITICAL`/`EMERGENCY`/`SHUTDOWN` to `'critical'`, which is the mapping `DETECTION_DESIGN` §3
keys its fps reductions off. Low-power mode comes from `isLowPowerModeEnabled` /
`isPowerSaveMode`.

---

## 4. Camera intrinsics

`DETECTION_DESIGN` §4 needs `focalScale = fx / uprightWidth`. The module computes `fx`, `fy`,
`cx`, `cy` in the **delivered buffer's** frame and converts at the end: a 90°/270° rotation swaps
the image axes, so the upright horizontal focal length is the buffer's *vertical* one (identical
for square pixels, which is what both paths produce) and the upright width is the buffer height.

**iOS.** `isCameraIntrinsicMatrixDeliveryEnabled` is set on the video connection before
`startRunning()` when `isCameraIntrinsicMatrixDeliverySupported` allows it, and every sample
buffer's `kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix` is read as a `matrix_float3x3`
(`fx = columns.0.x`, `fy = columns.1.y`, `cx = columns.2.x`, `cy = columns.2.y`, in pixels of the
delivered buffer) → `intrinsicsSource: 'intrinsics'`. When the attachment is absent, the fallback
is `activeFormat.videoFieldOfView` (documented as the format's horizontal field of view in
degrees) with `fx = W_b / (2 tan(hfov / 2))` → `'fov'`. When that is 0 or out of range, 70°
→ `'default'`.

**Android.** The Camera2 characteristics of the first front-facing camera, through the AOSP
centre-crop rule:

```
mmPerPx   = SENSOR_INFO_PHYSICAL_SIZE / SENSOR_INFO_PIXEL_ARRAY_SIZE     (note: pixel array)
active_mm = SENSOR_INFO_ACTIVE_ARRAY_SIZE * mmPerPx
the stream is a CENTRED crop of the active array at the stream's aspect ratio
fx_px     = LENS_INFO_AVAILABLE_FOCAL_LENGTHS[0] * W_b / cropW_mm
```

→ `'intrinsics'`, falling back to 70° → `'default'` when any key is null or degenerate. Two
deliberate choices: `LENS_INTRINSIC_CALIBRATION` is **not** used (AOSP marks it optional, it is
commonly null or zeroed on front cameras, and its units are the pre-correction active-array
coordinate system, a different frame from the delivered buffer); and the characteristics are read
through `CameraManager` rather than CameraX's `Camera2CameraInfo`, which is an opt-in experimental
interop API whose enforcement differs between Kotlin and Lint. `CameraSelector.DEFAULT_FRONT_CAMERA`
resolves to the first front-facing id, which is the one this reads.

`getIntrinsics()` reports `focalScale`, `isMirrored` and `orientation` as **null until the first
frame has been processed**. Before that both platforms only have a placeholder (iOS has no buffer
size yet, Android reports a 1 × 1 default), and the JS side builds the rule engine from these
values: a latched placeholder runs the whole drive on the wrong focal length and, worse, on the
wrong `image_right_is_driver_left`, which mirrors every asymmetric zone. The hook adopts the
values from the frames instead and rebuilds the engine when one of them changes
(`hooks/monitor/frameMeta.js`).

Sanity check on device: `fx ≈ (W / 2) / tan(hfov / 2)`. For a 70–80° front camera on a 640 × 480
buffer that is 380–460 px, and `focalScale` in portrait (`fx / 480`) is 0.79–0.96. The research
default for a generic webcam is 0.75 and the LBW cameras sit at 1.16, so anything outside
0.5–1.5 means the crop rule picked the wrong branch.

---

## 5. Gaze network

ONNX Runtime, pinned, linked natively in the same module. Batch 1, two intra-op threads, one
inter-op thread, all graph optimisations, CPU provider, inputs `cloud` (1, 478, 3), `context`
(1, 7), `validity` (1, 478) float32, outputs `gaze` (1, 3) and `rotation` (1, 3, 3) — identical to
`deployment-stack/dms/gaze_model.py`. The session is created at `start()` and lazily on the first
`predictGaze`, so `selfTest` works without the camera. Calls are serialised by a lock; the JS side
never queues, so only one is ever in flight.

Mirror TTA (`meta.json`'s `mirror_tta`) is **not** implemented: this version is single-pass on both
the mesh and the network, matching `DETECTION_DESIGN` §1. The far-eye visibility gate lives inside
the graph, so `validity` is only "is this landmark present".

---

## 6. Verification plan (the owner, on a device)

Nothing below can be checked from the development machine. Run them in this order; each one fails
in a different layer.

**V1 — it links.** `npx expo prebuild --clean`, then an EAS development build for iOS and Android.
Expected failures here are podspec / Gradle / autolinking, not logic. If CocoaPods reports
duplicate symbols between `MediaPipeTasksVision` and `onnxruntime-objc`, report it — the fallback
is the measured-exact TFLite conversion in `research/mobile_inference_options.md` §8.2.

**V2 — the module is there.** `DmsVision.isAvailable() === true`, `getModelInfo()` returns
`onnxSha256` equal to `gaze_direct.meta.json`'s value and `parameters === 867069`.

**V3 — ONNX parity.**
`await DmsVision.selfTest(require('../dms/tests/fixtures/onnx_parity.json'))` →
`{ cases: 8, ok: true }` with both maxima ≤ 1e-4. The reference run on the desktop gives
1.34e-7, so anything above 1e-5 means the on-device runtime is not reproducing the research
pipeline. **This is the single most valuable test**: it turns "does ORT on this phone match" into
a boolean.

**V4 — orientation harness.** Phone in portrait, face in view, log per frame:
`getIntrinsics().rotationDegrees`, `orientation`, and landmarks 33 (subject's right outer eye
corner) and 263 (left).

* In the upright frame the two `y` values must agree to a few percent (the eye line is
  horizontal), `x[33] < x[263]`, and the nose tip (index 1) must sit between them.
* If the face is sideways, restart with `start({ landmarkFrame: 'buffer' })` and compare: the raw
  frame tells you which rotation the buffer actually needs.
* Set `rotationOffsetDegrees` to the multiple of 90 that fixes it, confirm, and report the value
  so §2.2's table can be corrected at source.
* Repeat with the phone physically in landscape (the UI stays portrait — it is locked) to confirm
  the orientation listener tracks the mount.

**V5 — mirroring.** Cover one eye with a hand. With `isMirrored: false`, the covered eye must
appear on the image side *opposite* to the side of the driver's body it is on
(`image_right_is_driver_left = !isMirrored`). Do this on **both** platforms and compare: the
iOS/Android mirroring asymmetry is the most likely source of a left/right sign error in the zone
logic. If `getIntrinsics().isMirrored` is ever `true` on iOS, stop and report it rather than
compensating downstream.

**V6 — intrinsics.** `getIntrinsics()` on three devices if possible. Record
`intrinsicsSource`, `fx`, `bufferWidth/Height`, `focalScale`. Check `fx ≈ (W/2)/tan(hfov/2)`
against the phone's published front-camera FOV. A device that reports `'fov'` or `'default'` is
not a bug, but it is a known accuracy cost (§4).

**V7 — cadence, drops, thermal.** `addStatusListener` for 20 minutes dash-mounted while driving
(or a bench equivalent): `fps` near `targetFps`, `dropped` small and not growing, `thermal`
transitions logged, and `setIdleMode(true)` visibly halving the rate. This is also where the real
per-frame latency budget gets measured for the first time.

**V8 — end to end.** Feed `onFrame` into `dms/gaze_inputs.js` and `predictGaze` into
`dms/monitor.js` and confirm the forward-gaze calibration converges (the reference stack confirms
in a median 105 s).

---

## 7. Claims that could not be verified without a build

Ordered by how much damage a wrong answer does.

| Claim | Confidence | If wrong |
|---|---|---|
| The iOS portrait rotation is 90° clockwise (§2.2) | medium | Faces come out sideways; the mesh degrades or fails. Fixed by `rotationOffsetDegrees`, no rebuild of the logic. |
| `MPImage.orientation` behaves like the measured `rotation_degrees` path (§2.1, §2.2) | medium | **The probe that established "landmarks come back in the unrotated frame, `z` unscaled" ran through the PYTHON API's `rotation_degrees`, not through iOS's `MPImage.orientation`.** The iOS column of §2.2 is read from `MPPVisionTaskRunner.mm` (which turns the orientation into the same `NormalizedRect` rotation the other bindings apply), so the two are believed to be the same code path below the binding — but that equivalence is inferred, not measured. If it is wrong the landmarks are rotated twice or not at all, which V4 shows immediately, and `rotationOffsetDegrees` is the device-side escape hatch that fixes it without a rebuild of the logic. |
| Both static frameworks (MediaPipe + ORT) link into one iOS binary | medium-high | V1 fails at link time. Fallback: TFLite (converted and measured exact) or a dynamic-framework Podfile. |
| A local module's `resource_bundles` is findable at runtime | high | `DmsVisionBundle` searches four locations; if all fail, `start()` throws with a clear message and the fallback is `expo-asset` + a `file://` path. |
| MediaPipe returns landmarks in the unrotated frame, `z` unscaled (§2.1) | **measured**, high | Would show as a sideways face (V4) or a systematically wrong depth column. The probe is reproducible with the research venv. |
| `ImageInfo.getTimestamp()` is monotonic nanoseconds on all devices | high | `t` drifts or jumps; the rules are all time-based, so this would show as nonsense dwell times. |
| Expo local modules build on EAS without committing `ios/` and `android/` | high (inferred from autolinking's `./modules` default plus EAS's prebuild step; no Expo doc names EAS) | V1 fails with "module not found". |
| `AsyncFunction` bodies run off the main thread (the module blocks on `bindToLifecycle` / `startRunning`) | high | A deadlock at `start()`. Android has a `Looper.myLooper()` guard; iOS uses `sessionQueue.sync`. |
| Sending a `Data` / `ByteArray` inside an event payload arrives as a `Uint8Array` | high (expo-modules-core 2.5.0; the 2024 corruption bug was fixed in 2.0.3) | `landmarks` arrives as a string id; the wrapper would throw in `bytesToFloat32`. |
| `PowerManager.OnThermalStatusChangedListener` SAM-converts and the listener is accepted | high | `onStatus.thermal` sticks at its initial value; polling still works through `getThermalState()`. |
| 20 fps end to end on a mid-range phone | unmeasured | The cadence gate already degrades gracefully; the monitor is time-based, not frame-based. |
| `MPImage(pixelBuffer:)` accepts the 32BGRA buffers this session produces | high | `onError` with `FRAME_CONVERSION_FAILED` on every frame. |
| `ImageProxy.toBitmap()` handles the RGBA row stride correctly | high (CameraX does it internally) | Skewed images, so no face detected on affected devices. |

## 7a. Build evidence (EAS, 2026-09-18)

* **iOS development build `5d646a0f-6f68-463d-a59c-9f1e14ec4d65` — FINISHED** (profile `development`,
  SDK 53, `EAS_NO_VCS=1` upload from the worktree).  The Xcode log shows the pod `DmsVision` compiled
  (`DmsVisionGaze/Module/Pipeline/Support.swift`, one redundant-`_ =` warning since removed), the
  `DmsVision.bundle` resource bundle populated with `face_landmarker.task`, `gaze_direct.onnx` and
  `gaze_direct.meta.json`, `onnxruntime.xcframework` and the `MediaPipeTasksVision` frameworks
  embedded, and `** ARCHIVE SUCCEEDED **`.  This settles §7's "links into one binary", "resource
  bundle location" and "local module builds on EAS" items for iOS; it does not exercise the camera.
* **Android development build `cc91ab36-…` — ERRORED** on one Kotlin compile error
  (`DmsVisionModule.kt:114`, a bare `return@AsyncFunction` in a generic lambda: "expected Any?, actual
  Unit"); fixed in commit 229f78b (void bodies end with `Unit`) and resubmitted as build
  `3077954a-81bb-46bc-b972-31d0a166ecfd` (result recorded in the final report / INTEGRATION.md §10).
  The Gradle log confirmed the module is autolinked (`:dms-vision:*` tasks) and that
  `tasks-vision 0.10.35`, CameraX 1.4.2 and `onnxruntime-android 1.30.0` resolved.
* EAS note: the worktree's `.git` file points at a WSL path, so Windows `eas` cannot see the
  repository; builds are submitted with `EAS_NO_VCS=1`, which uploads the directory filtered by
  `.easignore` (it mirrors `.gitignore` plus the untracked `GoogleService-Info.plist` the iOS prebuild
  needs and minus `.env`).

## 7b. Review fixes (2026-09-18, not yet compiled)

Applied after an independent review of this branch; none of them has been through a build:

* Android `stop()` no longer closes the MediaPipe graph under a live `detectAsync` (§3
  Lifecycle), `start()` no longer leaks a graph and a thread when the bind throws, and both are
  serialised by a lock with `@Volatile` fields.
* Both result callbacks drop a result whose timestamp is not the pending frame's (§3 Cadence).
* Both `getIntrinsics()` report null until the first processed frame (§4).
* iOS: `start` / `stop` run on the session queue (`.runOnQueue`), the status timer is created,
  resumed and cancelled on its own queue, the device-orientation notifications are balanced with
  a flag across every stop path, session interruptions are observed, and the `focalScale` of a
  `landmarkFrame: 'buffer'` frame is now `fx / bufferWidth` (it was reported in the upright frame
  while the width and height were the buffer's — the harness's numbers only).
* Android: the same `focalScale` fix, a bounded `ProcessCameraProvider.getInstance(...).get()`
  and a bounded main-thread wait, a `CameraState` observer, no main-thread block in `OnDestroy`,
  and the orientation listener is started before the use case is built (so a rotation the sensor
  can already report seeds `targetRotation`; it usually cannot, which costs a few wrongly rotated
  frames at start — they carry no usable face and the engine's in-frame checks drop them).

* **Post-review builds (2026-09-18, commit 6fbcc48 + 7e0e04c):** iOS development build
  `b42bc5b0-af5e-4d91-8571-26ff3495233e` — FINISHED (the session-queue functions, the interruption
  observers and the status-timer rework compiled).  Android `e334cbc2-…` ERRORED on Gradle dependency
  resolution only (an explicit `compileOnly androidx.lifecycle:lifecycle-livedata-core:2.6.2` pin
  conflicted with camera-core's transitive 2.1.0 under consistent resolution); the pin was removed in
  7e0e04c (`Observer` / `LiveData` come from camera-core's own API dependency) and the build
  resubmitted as `3bbf783c-a2f6-4d8e-8621-3431b38def98` — FINISHED (.apk artifact on the EAS build page).

## 8. Deliberate omissions

* **Mirror pair.** The promoted recipe runs the mesh on the frame and its horizontal flip and
  averages through the 478-point mirror permutation (~0.32° of LBW error). `mirrorPair: true` is
  rejected with an error and the TODOs are in both module files. It belongs in the pipeline (two
  `FaceLandmarker` instances, each with its own tracking state) and it roughly doubles the mesh
  cost, so it should land only after V7 says there is headroom.
* **Network mirror TTA.** Same reasoning, `meta.json`'s `mirror_tta`; batch 2 instead of batch 1.
* **The §46 ROI mesh.** Out of reach: the MediaPipe Tasks API exposes no region-of-interest on
  `FaceLandmarker`, and the recipe needs a second bare TFLite interpreter plus a per-frame warp for
  0.005° over the plain task-graph mirror pair.
* **A config plugin.** Nothing in `app.json` needs changing: local modules autolink, the Android
  `CAMERA` permission is declared in the module's own manifest, `NSCameraUsageDescription` is
  already present, and Expo SDK 53's default iOS deployment target (15.1) already satisfies
  `onnxruntime-objc`. The one text change the owner should make is the *wording* of
  `NSCameraUsageDescription`, which currently says the camera is for scanning QR codes.
