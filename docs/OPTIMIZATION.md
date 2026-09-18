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
