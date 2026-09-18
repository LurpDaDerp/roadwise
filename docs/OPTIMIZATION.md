# RoadCash — whole-app performance and battery optimisation

Branch `app-optimization`, cut from `main` at `aa6edf3`.  Brief: *"make everything run smooth and
not drain battery", "optimise all models for efficient inference on mobile without significant
battery drain but keep at least 20 fps", "do NOT break anything"*.

Every change below is listed with **what** changed, **why**, and the **measured or estimated
effect**.  Nothing changes a detection threshold, an alert rule or a stored data shape; the
engine's 141 unit tests and the 75 integration tests are the behavioural contract and pass
unchanged after every step.  A section at the end lists what was deliberately **not** changed.

Baseline, measured on this branch before any change (`npx expo export`):

| | Hermes bundle | export total |
|---|---|---|
| ios | 7,829,221 B (7.83 MB) | 12,238,037 B |
| android | 7,853,198 B (7.85 MB) | 12,260,464 B |

---

## 1. Monitoring pipeline — per-frame JavaScript

The frame path is `onFrame` -> `monitor.prepareInputs` -> `DmsVision.predictGaze` (native) ->
`monitor.finishFrame` -> `bridge.update`, run up to 20x/s for the whole drive.  Everything on it
is now allocation-lean; **all of it is bit-identical**, verified two ways (below).

### 1.1 `dms/gaze_inputs.js` — stop copying the landmark cloud six times per frame

*What.*  Four changes, no arithmetic touched:

* `check()` builds its Float64Array with `new Float64Array(src)` instead of `Float64Array.from(src)`
  (the element-wise convert instead of the iterator protocol).
* New internal `checkFlat()`: validates a flat landmark source and returns it **without copying**.
  Every consumer that only reads (`landmarkValidity`, `rowStatistics`, `irisXInEye`,
  `eyeAspectRatios`, `mouthAspectRatio`, `eyeVisibility`, `mirrorCloud`) uses it.  Reading a
  float32 element yields exactly the double a Float64Array copy would have held, so results are
  unchanged.
* `weak3dCloud()` folds the aspect correction into its own single pass instead of calling
  `aspectCorrected()` (which allocated two more `Float64Array(1434)` per frame).
* `eyeCenterAndIod()` reads the two outer eye corners directly instead of aspect-correcting and
  copying all 478 landmarks to use 2 of them.  It is called twice per frame (camera context and
  features), so this alone removed four full-cloud allocations.

*Why.*  At 20 fps the old path allocated ~103 KB per frame (~2.1 MB/s of garbage) and walked the
478-point cloud eight times where two passes are needed.  On Hermes, which has no generational
nursery as fast as V8's, that is a steady GC tax on the same JS thread that runs the rule engine.

*Effect.*  Per-frame garbage **103 KB -> 19 KB (-81 %)**; measured CPU for the whole
prepare+features stage **-59 %** (0.0145 ms -> 0.0060 ms per frame on desktop V8; the Hermes
figure is larger in absolute terms and the same in ratio).

*Proof of identity.*  (a) A 60-trial x 3-input-form differential harness against the pre-change
file: every output bit-identical (`Object.is`) and every thrown error message identical, for
Float32Array, plain-number-array and nested `[[x,y,z],...]` inputs, at four frame sizes.  (b) The
141 engine tests, which compare against the Python reference fixtures, pass unchanged.

### 1.2 `dms/features.js` — no Float64Array copy of the validity vector

`computeFeatures` built a `Float64Array(478)` copy of the validity vector on every frame only to
hand it to `meanArray`, which merely indexes its argument.  Removed (-3.8 KB/frame).

### 1.3 `dms/monitor.js` — `new Float32Array(cloud64)` instead of `Float32Array.from`

Same rounding, the engine's element-wise convert instead of the iterator protocol, on the 1,434-float
buffer that crosses the bridge every frame.

---

## 2. Monitoring pipeline — the native layer

### 2.1 The camera is driven at the cadence instead of at 30 fps

*What.*  `modules/dms-vision/ios/DmsVisionPipeline.swift` and the Android `DmsVisionPipeline.kt`
now ask the CAMERA for the cadence the policy decided (20 / 10 / 5 fps) and re-apply it on every
`setTargetFps` / `setIdleMode`:

* iOS: `activeVideoMinFrameDuration` / `activeVideoMaxFrameDuration` = 1 / cadence, clamped to a
  rate the active format's `videoSupportedFrameRateRanges` can actually produce (never below the
  cadence).  `activeMaxExposureDuration` is pinned at 1/30 s so a 5 fps frame duration cannot let
  auto-exposure expose for 200 ms and smear the face — the slower capture must cost battery, never
  image quality.
* Android: `CONTROL_AE_TARGET_FPS_RANGE` through `Camera2CameraControl.setCaptureRequestOptions`,
  choosing only among the ranges the device advertises in
  `CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES` and preferring the highest lower bound (a fixed
  `[20, 20]` over `[7, 20]`), which serves the same anti-blur purpose as the iOS exposure cap.
  Anything unavailable or unexpected leaves the camera exactly as it was.

*Why.*  The pipeline pinned the sensor at 30 fps and threw away the surplus in software.  Sensor
read-out, the ISP, the 32BGRA / RGBA_8888 conversion and the buffer traffic are per-frame costs —
640 × 480 × 4 B = 1.2 MB per delivered frame, 37 MB/s at 30 fps — and at the 5 fps no-face idle
cadence five of every six of those frames were produced only to be dropped.

*Effect.*  Camera-side per-frame work −33 % at the 20 fps target, −67 % at the 10 fps
stationary/thermal cadence and −83 % in the 5 fps no-face idle.  Nothing downstream changes: the
landmark frames still arrive at the cadence, carry the same camera timestamps, and every rule is
time-based.

### 2.1a … which also fixes the cadence the pipeline actually achieved

The software throttle accepted a frame when `now − lastAccepted >= 1/fps − 0.002`.  With a 30 fps
sensor and a 20 fps target, frames arrive every 33.3 ms and 33.3 < 48 ms, so **every second frame
was rejected and the pipeline ran at 15 fps, not the 20 fps design target** (a 10 fps request ran
at 7.5).  The slack is now 15 % of the cadence period, so a sensor delivering exactly at the
cadence is accepted, and a device whose format cannot produce the cadence keeps the old behaviour
exactly (33.3 ms is still outside a 42.5 ms window).  Net effect at the 20 fps target: the camera
produces 20 frames instead of 30 and all 20 are monitored instead of 15.

### 2.2 ONNX Runtime: intra-op thread spinning off

*What.*  Both `DmsVisionGaze` implementations add
`session.intra_op.allow_spinning = 0` (and `session.inter_op.allow_spinning = 0` on Android, whose
Java API exposes it) to the session options.  Thread count (2) and graph optimisation level (ALL)
are unchanged, so the numerics the `onnx_parity.json` self-test guards are untouched.

*Why.*  ONNX Runtime's thread pool busy-waits after each `Run` so that the next one starts without
a wake-up.  This model is called ~20 times a second with ~45 ms gaps — longer than the inference
itself and shorter than the default spin window — so a worker thread would spin for essentially
the whole drive, keeping a core hot and defeating the SoC's idle states.  The model is 867 k
parameters and runs in single-digit milliseconds, so the wake-up it saves is irrelevant.

*Effect.*  Estimated: removes up to one continuously-busy core from a 20 fps drive.  Not measurable
without a device; the config key is a documented no-op on a runtime that does not know it, and both
call sites swallow a failure so session creation can never break.

### 2.3 Not changed in the native layer, and why

* **MediaPipe GPU delegate.**  The Tasks API would accept `Delegate.GPU`, but the face mesh's
  landmark values change slightly under the GPU (fp16) path, and nothing in the repo can validate
  landmark accuracy without a device — the `onnx_parity.json` self-test only covers the gaze
  network.  Changing the detector's numerics is exactly the "break something" case: the gaze model
  is trained on the CPU mesh's response.  Left on CPU, noted here as the next thing to measure on
  a real phone.
* **CoreML / NNAPI execution providers for the gaze network.**  Both run this model in fp16 on the
  ANE/DSP, which will not hold the ≤ 1e-4 parity the module's own self-test requires.  The brief
  allows them "only if parity is preserved", so they stay off.
* **Capture resolution.**  Already the lowest format with a long side ≥ 640 px; MediaPipe's
  detector runs at 128 px and the mesh at 192/256 px, so there is nothing to win below it.
