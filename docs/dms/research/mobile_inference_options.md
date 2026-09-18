# On-device MediaPipe + ONNX gaze inference in RoadCash-dms (Expo 53 / RN 0.79.5)

**Status:** research only — nothing implemented, no app files changed except this document.
**Date:** 2026-09-18. All versions and dates below were checked against the npm registry,
Maven Central, CocoaPods trunk, the GitHub API and vendor docs on that date.
**Question answered:** what is the most reliable way to run (1) MediaPipe FaceLandmarker
(`face_landmarker.task`, BlazeFace short-range + 478-point attention mesh, 3.7 MB) and (2) the
`gaze_direct.onnx` network (3.6 MB, 867,069 params) on-device at >= 20 fps, on iOS **and**
Android, with no camera preview required.

---

## 1. Executive summary

**Recommendation: build one local Expo Module (`modules/dms-vision`) that owns the camera
session, runs FaceLandmarker in LIVE_STREAM mode and runs the gaze network natively, and emits
only the finished gaze vector to JS.** Vendor [`expo-mediapipe@0.4.1`](https://www.npmjs.com/package/expo-mediapipe)
(MIT, ~2,400 lines of Swift + Kotlin + C++) as the starting skeleton rather than writing it from
a blank file — it is already an Expo Module with an iOS `AVCaptureSession` + Android CameraX
camera, a `FaceLandmarker` LIVE_STREAM task runner on both platforms, a working config plugin,
and an Android JSI `Float32Array` fast path. It is not safe to *depend* on (its GitHub repo does
not exist and it has ~172 downloads/month), but it is safe and very valuable to *read and fork*.

**Gaze runtime inside that module: ONNX Runtime (`onnxruntime-objc` / `onnxruntime-android`, pinned
to 1.30.0).** The `.onnx` runs as-is. TFLite is a measured, ~25 MB-smaller, slightly faster
alternative — I converted and verified the model to **0.000000 degrees** of gaze error (§8.2) — but it
stacks a second static copy of TFLite against the one inside `MediaPipeTasksVision`, which is an
unverified link-time question. Try it in the first EAS build; take ORT if it does not link.

**Fallback if the module cannot be made to work blind: `react-native-vision-camera@4.7.3` +
`react-native-worklets-core@1.6.3` + a custom frame-processor plugin.** This is *more* native
code than the Expo Module, not less — the only thing it buys is a battle-tested camera layer.

**What is ruled out:**

| Ruled out | Reason |
|---|---|
| `expo-camera` frames | No frame API at all in SDK 53. Android's `ImageAnalysis` is `private`; iOS's `session` is public but unsupported. |
| `react-native-vision-camera` v5.x | v5's frame processors pull `react-native-worklets`, which peer-pins `react-native: "0.83 - 0.87"`. You are on 0.79.5. |
| `react-native-vision-camera-face-detector` | ML Kit, not MediaPipe. Contours only, 2D, no 478-point mesh, no `z`. Also now requires VisionCamera >= 5.0.10 + Nitro. |
| `@thinksys/react-native-mediapipe` | Pose landmarks only. No face mesh. |
| `react-native-executorch` | 0.6.0+ peer-requires `expo >= 54.0.0`; 0.10.x requires `react-native-worklets` (RN 0.83+). Also needs a `.pte` export we cannot produce (no PyTorch checkpoint here, only ONNX). |
| `react-native-mediapipe` (cdiddy77) | Right capability, wrong transport and wrong vintage — see §5.2. Keep as a reference, not a dependency. |

**Three facts most likely to change the decision** are in §2.

---

## 2. The three facts a decision should turn on

### 2.1 The New Architecture is ON in this app today

`app.json` has no `newArchEnabled` key, and the Expo SDK 53 changelog says, verbatim:
*"In SDK 53, the New Architecture is enabled by default in all projects."*
([expo.dev/changelog/sdk-53](https://expo.dev/changelog/sdk-53); repeated in
[expo.dev/blog/out-with-the-old-in-with-the-new-architecture](https://expo.dev/blog/out-with-the-old-in-with-the-new-architecture),
2025-04-21, which also gives the 74.6 %-of-SDK-52-EAS-builds rollout figure.)

You can still opt out with `"expo": { "newArchEnabled": false }` (or per-platform under
`expo.ios` / `expo.android`) — but that escape hatch expires:
SDK 54 changelog: *"SDK 54 is the final release to include Legacy Architecture support."*
New Architecture guide: *"SDK 55 and later do not support disabling the New Architecture."*
So **pick a New-Arch-native approach now**; anything that only works via Fabric interop is on
borrowed time. A local Expo Module is New-Arch-native by construction. VisionCamera v4 is not
(see §5.1).

### 2.2 The pipeline does *not* need landmarks in JavaScript — and if it did, VisionCamera would be the wrong shape

The full chain is: pixels -> 478x3 landmarks -> 1,434-float tensor -> gaze vector. Every stage
except the last is native-side data. Sending 478x3 floats to JS at 20 fps is ~115 KB/s, which is
*fine* on any modern transport, but it is also **pointless work**: JS has nothing to do with the
cloud except hand it straight back to an inference call.

Keeping MediaPipe **and** ONNX inside one native module means:

* one event per frame carrying 3 floats instead of 1,434;
* no worklet runtime, no `react-native-worklets-core`, no Babel plugin;
* no coupling of the gaze pipeline to VisionCamera's RN-version treadmill (§5.1);
* the frame's `CVPixelBuffer` / `ImageProxy` never leaves native memory.

The whole value proposition of a frame-processor library is getting pixels *into* JS/worklets.
That is precisely what this pipeline does not want.

### 2.3 The ONNX model converts to TFLite with *exact* parity — so the runtime choice is genuinely open

I ran the conversion (§8.2). `onnx2tf -b 1 -kat cloud context validity` produced a 3.53 MB float32
TFLite model that reproduces all 8 reference cases from `gaze_direct.parity.npz` to
**max abs error 1.8e-7 and 0.000000 degrees of gaze angular error**, using 36 *builtin* TFLite ops
(no Flex / SELECT_TF_OPS), all at operator version **v1**.

This matters because it means the "everything native" module is not locked to ONNX Runtime. It can
link either:

* **ONNX Runtime** (`onnxruntime-c` pod / `com.microsoft.onnxruntime:onnxruntime-android` AAR — both
  *full* builds, all ops), or
* **TFLite / LiteRT** (`TensorFlowLiteC` pod / `com.google.ai.edge.litert:litert` AAR), which is
  already being linked anyway if you ever add `react-native-fast-tflite`, and which measured
  *faster* than ORT in my x86 benchmark (3.06 ms vs 4.16 ms single-thread at batch 1).

---

## 3. What the shipping pipeline actually requires

Pulled from `deployment-stack/models/gaze_direct.meta.json`, `deployment-stack/dms/gaze_inputs.py`,
`deployment-stack/dms/mesh_roi.py` and the research log §46. The app team should treat these as
hard requirements on whatever runtime is chosen.

**a. Two mesh passes per frame, not one.** Module 1 is *mirror-averaged*: each frame is read as
captured and horizontally flipped, the flipped cloud un-mirrored through
`mediapipe_mirror_permutation_478.npy` and averaged with the direct one. Research log §46 measured
the alternatives on one pinned CPU thread at 800 px:

| Extraction | LBW error | Cost |
|---|---|---|
| `face_landmarker.task` graph, single pass | 6.583 deg (deployed replay 6.652) | 5.3 ms |
| `face_landmarker.task` graph, **mirror pair** | **6.2648 deg** | 12.6 ms |
| Custom ROI mesh, single pass | worse than task-graph single (+0.064) | 3.2 ms |
| Custom ROI mesh, **mirror pair** (promoted) | **6.2599 deg** | 5.9 ms |

**The promoted §46 recipe and the plain task-graph mirror pair are within 0.005 deg of each
other.** That is the single most important engineering consequence in this document: the mobile app
can use the stock MediaPipe Tasks `FaceLandmarker` — run twice, once on the frame and once on the
horizontally flipped frame — and land on the promoted accuracy. It does **not** need to reimplement
the §46 ROI warp.

It could not easily do so anyway: the MediaPipe Tasks `FaceLandmarker` API takes only
`detect(mpImage)` / `detectForVideo(mpImage, ts)` / `detectAsync(mpImage, ts)` and exposes no
`regionOfInterest`. The §46 recipe runs the bare `face_landmarks_detector.tflite` on its own
rotated 256 px crop, which on mobile would mean a second TFLite interpreter plus a per-frame
image warp. Not worth it for 0.005 deg.

Practical shape: **two `FaceLandmarker` instances** (each keeps its own LIVE_STREAM tracking
state), one fed the frame, one fed the mirrored frame.

**b. The gaze net runs at batch 2.** `meta.json`: `"mirror_tta": "run on [cloud; mirror(cloud)]
with context x negated; average after negating the mirrored gaze x"`. Budget batch-2 inference,
not batch-1 (§8.1 has measured numbers for both).

**c. Camera intrinsics are a real input, not a nicety.** `context` is
`(ray_x, ray_y, iod/focal, + 4 subject statistics)` where
`ray = ((u - cx)/f, (v - cy)/f)` and `focal_scale = fx / image_width`, principal point assumed at
the frame centre (`dms/gaze_inputs.py`). The deployment default is `focal_scale = 0.75`; typical
phone front cameras (HFOV 70-80 deg) sit at 0.60-0.71, so **using the default unchanged is a real
error source.** See §7.

**d. Subject statistics are stateful.** `context[3:7]` carries an expanding causal *median* over
the frames seen so far, with `training_mean` used for the first 30 frames. That state must live
wherever the tensor is assembled — another reason to assemble it natively.

**e. The far-eye visibility gate runs inside the ONNX graph.** `validity` is just "is this landmark
present"; the caller does not implement the gate.

---

## 4. Comparison matrix

| Option | Version checked | Published | RN 0.79 / Expo 53 / New Arch | iOS | Android | Config plugin | Native code we must write | Preview-free | fps expectation | Verifiable without local toolchain | Risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **A. Local Expo Module (fork of `expo-mediapipe`)** | `expo-mediapipe@0.4.1` as seed | 2026-06-13 | New-Arch-native (Expo Modules API); nothing pins RN version | Yes (Swift, `MediaPipeTasksVision` pod) | Yes (Kotlin, CameraX + `tasks-vision`) | Write our own (~120 LOC, or adapt theirs) | **~600-900 LOC net new** on top of ~2,400 vendored | **Yes** — we own the session; no view needed if we move it off `ExpoView` | 20-30 fps plausible; needs throttling | Poor before first EAS build; good after (small surface, own code) | **Medium** — all risk is "does our Swift/Kotlin compile and behave", discoverable in 1-2 EAS builds |
| **B. VisionCamera v4 + custom frame-processor plugin** | `react-native-vision-camera@4.7.3`, `react-native-worklets-core@1.6.3` | 2025-11-12 / 2026-02-12 | Works, but **Fabric interop only** — v4 has no `codegenConfig`; [#3286](https://github.com/mrousavy/react-native-vision-camera/issues/3286) "Support React Native New Arch" closed **as not planned** | Yes | Yes | Yes (`react-native-vision-camera` plugin, `enableFrameProcessors: true`) | **~700-1,000 LOC** (Swift + Kotlin plugin wrapping MediaPipe) *plus* the worklets/Babel setup | Yes — v4 has `preview?: boolean` (default `true`) | 20-30 fps | Poor; VisionCamera+Expo build failures are a known genre ([#3639](https://github.com/mrousavy/react-native-vision-camera/issues/3639), [#3424](https://github.com/mrousavy/react-native-vision-camera/issues/3424), [#2507](https://github.com/mrousavy/react-native-vision-camera/issues/2507), [#3504](https://github.com/mrousavy/react-native-vision-camera/issues/3504)) | **Medium-high** — EOL branch, interop-only New Arch, more native code than A |
| **C. `react-native-mediapipe` (cdiddy77)** | `0.6.0` on npm | npm 2024-12-12; last code commit 2025-08-13; 48 open issues | Built against RN **0.73.4** / VisionCamera ^4.5.3; uses legacy `NativeModules` + `NativeEventEmitter`; New Arch never addressed ([#154](https://github.com/cdiddy77/react-native-mediapipe/issues/154) open since 2024-10) | Yes | Yes | No | 0 (but see risk) | Not designed for it — needs the `<Camera>` mounted | Unclear; delivers **478 JS objects** `{x,y,z}` per frame over the legacy bridge | Moderate (it's published and used: 2,698 dl/month) | **High** — 21-month-old npm release, wrong transport, unowned |
| **D. `expo-vision-camera-v4-mediapipe`** | `1.4.0` | 2026-09-12 | Requires VisionCamera >= 4 | **No** — README: *"This plugin currently supports **Android only**. iOS support is not available."* | Yes (Kotlin) | Yes | 0 on Android, everything on iOS | n/a | n/a | n/a | **Disqualified** (Android-only). Useful as MIT-licensed Kotlin reference. |
| **E. `expo-camera` frames** | SDK 53 | — | n/a | — | — | — | — | — | — | — | **Impossible**, see §5.5 |
| **F. `@thinksys/react-native-mediapipe`** | `0.0.21` | 2026-04-10 | Not stated | Yes | Yes | No | — | No | — | — | **Disqualified** — pose only |
| **G. `expo-mediapipe` as a *dependency*** | `0.4.1` | 2026-06-13 | devDeps target RN 0.81 / expo-modules-core 3.x | Yes | Yes | Yes | 0 | Needs a view mounted | Face path present and correct | **Very poor** — GitHub repo 404s, ~172 dl/month | **High as a dependency, low as a fork** |

**Gaze runtime sub-matrix** (all usable from inside option A or B):

| Runtime | Version | Published | RN 0.79 / New Arch | Model format | Native code | Notes |
|---|---|---|---|---|---|---|
| ORT native inside our module (`onnxruntime-objc`/`-c` pod + `onnxruntime-android` AAR) | 1.30.0 | 2026-09-10/11 | n/a (we call C++/Swift/Kotlin) | `.onnx` unchanged | ~60 LOC each side | **Recommended default.** No JS runtime involved, no `patch-package`, no autolinking question. Pin the version. Costs ~31 MB of arm64 `.so` (§8.3). |
| LiteRT/TFLite native inside our module (`TensorFlowLiteC` pod + `com.google.ai.edge.litert:litert`) | 2.17.0 / 1.4.0-2.2.0 | — | n/a | needs `.tflite` — **conversion verified exact** (§8.2) | ~70 LOC each side | ~25 MB smaller and measured *faster*, but one **unverified** iOS static-framework symbol question against `MediaPipeTasksVision` (§8.3). |
| `onnxruntime-react-native` | **1.24.3** | **2026-03-05** | Works but is a legacy module + JSI install (no `codegenConfig`); PR [#16669](https://github.com/microsoft/onnxruntime/pull/16669) "Support New Architecture" **closed unmerged 2025-07-03** | `.onnx` unchanged, **full** op set (§8.1) | 0 | ~6 months / 6 minors behind ORT core. Needs a `patch-package` for an iOS teardown segfault, and both native deps are **unpinned**. Only if inference must live in JS. |
| `react-native-fast-tflite` | `1.6.1` (pre-Nitro) / `3.0.1` (Nitro) | 2025-04-08 / 2026-04-21 | 1.6.1: plain RN module. 3.0.1: Nitro (RN >= 0.75, NDK >= 27), explicitly New Arch + bridgeless | needs `.tflite` (§8.2) | 0 | `runSync` (real sync, works outside worklets) + `run`; Expo plugin with `enableCoreMLDelegate` / `enableAndroidGpuLibraries`. `TensorFlowLiteC 2.17.0` **pinned**. RN 0.79 + nitro 0.37 is an untested pairing. |
| `react-native-executorch` | 0.10.2 | 2026-09-18 | **Blocked**: docs say *"React Native 0.83+"* or *"Expo SDK 55+"* and *"Expo SDK 54 cannot be supported"* | needs `.pte`; **no ONNX -> ExecuTorch path exists** | — | **Disqualified** |

---

## 5. Per-option notes

### 5.1 `react-native-vision-camera` — v5 is out of reach, v4 is workable but EOL

**v5.2.3 (2026-08-20) cannot be used on RN 0.79.5.** The registry peer deps are deceptively
permissive (`"react-native": "*"`), but the real gate is transitive:

* v5 is *"fully rewritten to Nitro Modules"* ([margelo.com/blog/whats-new-in-visioncamera-v5](https://margelo.com/blog/whats-new-in-visioncamera-v5)),
  so `CameraView` is a Nitro View. Nitro docs: *"Nitro Views require react-native 0.78.0 or higher,
  and require the new architecture"* ([nitro.margelo.com/docs/guides/view-components](https://nitro.margelo.com/docs/guides/view-components)).
  RN 0.79.5 clears that.
* But v5's release notes say *"The default Worklets implementation is now `react-native-worklets`
  (Software Mansion) instead of `react-native-worklets-core`"*, and
  **`react-native-worklets@0.12.2` declares `peerDependencies.react-native: "0.83 - 0.87"`**
  (even 0.10.0 declares `"0.83 - 0.86"`). Frame processors — the entire reason to adopt v5 — will
  not install cleanly.
* `react-native-vision-camera@5.2.3` dev-builds against `react-native 0.85.3`.
* Nitro also wants `compileSdkVersion >= 34` and **`ndkVersion >= 27`**
  ([minimum requirements](https://nitro.margelo.com/docs/getting-started/minimum-requirements));
  the NDK floor would need `expo-build-properties` if you ever try it.

No primary source states v5's minimum RN version outright — the "RN 0.81+" figure circulating in
secondary sources is unverified. The 0.83 worklets peer range is the hard, checkable constraint.

**v4.7.3 (2025-11-12) works, with two caveats.**

* *New Architecture is interop only.* v4's `package.json` has **no `codegenConfig`** — it ships an
  old-architecture `CameraViewManager`/`CameraViewModule` and runs on the New Arch through RN's
  Fabric interop layer. The feature request
  [#3286 "Support React Native New Arch"](https://github.com/mrousavy/react-native-vision-camera/issues/3286)
  was **closed as not planned**; native support is what v5 delivers instead. In practice v4-on-
  New-Arch works, but it is interop, and v4 is now an EOL branch.
* *Frame processors need `react-native-worklets-core@1.6.3`* (2026-02-12, dev-tested on RN 0.76.1,
  peer `react-native: "*"`) plus `plugins: [['react-native-worklets-core/plugin']]` in
  `babel.config.js`. This coexists with your `react-native-reanimated ~3.17.4` — do **not** add
  `react-native-worklets` (the Reanimated-4 package) alongside it.

**Preview-free operation: yes, and it is documented.** v4 `CameraProps.ts` has
`preview?: boolean` with default `true`: *"Enables preview streaming. Preview is enabled by
default, and disabled when using a Skia Frame Processor."* So
`<Camera preview={false} isActive={true} frameProcessor={fp} />` runs the processor with nothing
rendered. Avoid the `opacity: 0` / zero-size trick — a view with `display: none` can be dropped
from the native hierarchy and stop the session.

**Expo config plugin:** ships with the package; add
`["react-native-vision-camera", { "cameraPermissionText": "...", "enableFrameProcessors": true }]`.
Requires a dev client (you have `expo-dev-client`), never works in Expo Go.

**Known Expo friction** (no Expo-53-specific tracking issue found, but a persistent genre):
[#3639](https://github.com/mrousavy/react-native-vision-camera/issues/3639) "Can't build Expo app
after adding Frame Processors", [#3424](https://github.com/mrousavy/react-native-vision-camera/issues/3424)
"Frame processor usage crashes Expo app", [#2507](https://github.com/mrousavy/react-native-vision-camera/issues/2507),
and — most relevant to us — [#3504](https://github.com/mrousavy/react-native-vision-camera/issues/3504)
"Creating custom frame processor plugin for Expo Modules", where users note that EAS doesn't let
them edit `ios/`/`android/`. That is exactly our constraint.

**`react-native-vision-camera-face-detector@2.1.0` (2026-09-11) does not fit**, on two independent
grounds. (i) It wraps **ML Kit**, whose face detection returns *contours* — face oval, eyes,
eyebrows, lips, nose — as 2-D points with no `z` and no dense mesh. The 478-point attention mesh
with a depth channel is MediaPipe-specific, and `cloud` is `(B,478,3)`. (ii) Its peer deps are now
`react-native-vision-camera >= 5.0.10` and `react-native-nitro-modules >= 0.35`, i.e. the v5 stack
we cannot use.

### 5.2 `react-native-mediapipe` (cdiddy77) — right capability, wrong transport

I read the source rather than the README (which is thin).

* **It does expose what we need.** `src/faceLandmarkDetection/index.ts` wires a
  `VisionCameraProxy.initFrameProcessorPlugin("faceLandmarkDetection")` plugin and returns
  `FaceLandmarkerResult { faceLandmarks: Landmark[][], faceBlendshapes, facialTransformationMatrixes }`
  with `interface Landmark { x: number; y: number; z: number; visibility?; presence? }`
  (`src/shared/types.ts`). `Delegate.CPU | GPU`, `RunningMode.IMAGE | VIDEO | LIVE_STREAM`, and a
  `fpsMode` throttle via `runAtTargetFps` are all there. iOS 12+ and Android SDK 26+.
* **But the transport is the legacy bridge.** Results arrive via
  `new NativeEventEmitter(NativeModules.FaceLandmarkDetection)` →
  `eventEmitter.addListener("onResults", ...)`, delivering **478 JavaScript objects** `{x,y,z}` per
  frame. That is the slowest possible shape for this payload, and `NativeEventEmitter` over a
  legacy module under bridgeless RN is exactly the kind of thing that breaks quietly.
* **Vintage.** `package.json` devDeps: `react-native 0.73.4`, `react-native-vision-camera ^4.5.3`.
  npm `0.6.0` was published **2024-12-12**; the last non-dependabot commit is 2025-08-13; 48 open
  issues; New Architecture raised in [#154](https://github.com/cdiddy77/react-native-mediapipe/issues/154)
  (open since 2024-10-27) and never resolved.
* Useful detail for us: its default `mirrorMode` is `"mirror-front-only"` on Android and
  `"no-mirror"` on iOS, and the mirroring is applied only in a view-coordinate helper — the raw
  `faceLandmarks` in the event are un-mirrored. That matches the platform reality in §7.3.

Verdict: excellent prior art, unacceptable as a shipping dependency.

### 5.3 `expo-mediapipe@0.4.1` — the fork candidate

This is the closest thing on npm to "option 5, already written". Contents (105 files):

```
ios/ExpoMediapipe.podspec        s.dependency 'MediaPipeTasksVision', '~> 0.10'
ios/ExpoMediapipeModule.swift    168 lines   View(...) + Events("onResults","onError","onStatusChange")
ios/ExpoMediapipeView.swift      377 lines   AVCaptureSession, .hd1280x720, front/back
ios/TaskRunner.swift             518 lines   FaceLandmarker/HandLandmarker/PoseLandmarker, LIVE_STREAM
android/.../ExpoMediapipeView.kt 408 lines   CameraX ImageAnalysis, RGBA_8888, KEEP_ONLY_LATEST
android/.../TaskRunner.kt        461 lines
android/.../MediapipeJsi.kt       63 lines   System.loadLibrary("expomediapipejsi")
android/src/main/cpp/...Jsi.cpp  171 lines   installs global.__expoMediapipeReadLatest -> Float32Array
build/plugin/index.js            119 lines   config plugin: Podfile + app build.gradle + model copy
```

**What is right:**

* Real cross-platform Expo Module (`expo-module.config.json` declares `["apple","android"]`).
* Genuine `FaceLandmarker` + `detectAsync` in LIVE_STREAM mode on both platforms.
* `serializeFaceResult` emits **`landmarksFlat`** — a flat 1,434-element array with
  `landmarksPerEntity: 478, landmarksStride: 3` — not 478 objects. Correct shape.
* Android JSI fast path: `global.__expoMediapipeReadLatest(streamId, task)` returns a
  `Float32Array` built from one `memcpy` of ~1.4k floats. Exactly the right idea.
* Config plugin injects the pod and the Gradle dep and copies `.task` files.
* MIT licensed, source shipped in the tarball.

**What is wrong (and why it must be forked, not depended on):**

1. **The GitHub repo does not exist.** `repository.url` points at
   `github.com/AyushJadaun/expo-mediapipe`, which returns 404; the podspec still contains the
   placeholder `s.homepage = 'https://github.com/your-org/expo-mediapipe'`. No issue tracker, no
   commit history, no way to report a bug. ~172 downloads/month.
2. **MediaPipe timestamps are a frame counter,** not milliseconds:
   `frameTimestamp += 1` on both platforms. MediaPipe accepts it (monotonic), but the real frame
   time never reaches JS — and this pipeline needs it for the causal subject-statistic median.
3. **No throttling.** Every camera frame is fed to MediaPipe.
4. **Android does `imageProxy.toBitmap()` and then `Bitmap.rotated(degrees)` per frame** — an
   allocation plus a full-image rotate on every frame. Both should go.
5. **iOS uses the deprecated `connection.videoOrientation = .portrait`** (deprecated in iOS 17 in
   favour of `videoRotationAngle`) and physically rotates every buffer, which Apple's QA1744 warns
   costs real work.
6. **The iOS `asset://` model path is almost certainly broken.** The config plugin copies `.task`
   files to `ios/models/` with `withDangerousMod` but never touches the `.pbxproj`, so
   `Bundle.main.path(forResource:inDirectory:)` will not find them. Workaround already in the code:
   `resolveModelPath` also accepts `file://`, so ship the model via `expo-asset` and pass
   `Asset.localUri`.
7. **No camera intrinsics, no FOV, no `isMirrored` / orientation exposure to JS.** All of §7 is
   missing and must be added.
8. **Android Gradle uses a dynamic version**, `com.google.mediapipe:tasks-vision:0.10.+`, in both
   the module and the injected app-level dependency. Pin it for reproducible EAS builds.
9. **iOS has no JSI path** — results go through `Events(...)` on an `ExpoView`, so a view must be
   mounted. For preview-free operation the camera should be moved off `ExpoView` onto the module
   object itself.
10. `@modelcontextprotocol/sdk` and `zod` sit in runtime `dependencies` (for a docs MCP server).
    Metro only bundles what is imported, so this is bloat rather than breakage — but it is a
    quality signal.

**Version notes:** the podspec's `'~> 0.10'` resolves to `MediaPipeTasksVision 0.10.35`; CocoaPods
trunk now also has **1.0.0 (2026-07-28)**. Android CameraX is pinned at 1.3.0 (current released
`androidx.camera:camera-camera2` is 1.6.2).

### 5.4 `expo-vision-camera-v4-mediapipe@1.4.0` — Android only

README, verbatim: *"This plugin currently supports **Android only**. iOS support is not
available."* It is a Kotlin frame-processor plugin with an Expo config plugin that *"Automatically
configures `build.gradle`, `MainApplication.kt`, and native assets"*, supports *"Up to 478 face
landmarks via `FaceLandmarker` — enable with `enableFace`"* with x/y/z, needs Expo >= 50, RN >= 0.73,
VisionCamera >= 4.0.0, Android minSdk 24. MIT.

Disqualified for this app, but it is the best MIT-licensed reference for the **Android half** of a
VisionCamera frame-processor plugin wrapping MediaPipe, if option B is ever chosen.

### 5.5 `expo-camera` — confirmed dead end

Read from the SDK 53 branch, not the docs. `packages/expo-camera/src/Camera.types.ts` (sdk-53) lists
the complete `CameraViewProps` surface: `facing, flash, zoom, mode, mute, mirror, autofocus, active,
videoQuality, videoBitrate, animateShutter, pictureSize, selectedLens, enableTorch,
videoStabilizationMode, barcodeScannerSettings, poster, responsiveOrientationWhenOrientationLocked,
ratio, onCameraReady, onMountError, onBarcodeScanned, onResponsiveOrientationChanged,
onAvailableLensesChanged`. **No `onFrame`, no frame processor, no pixel-buffer callback.** Methods
are capture-only.

The "next" API is not a separate thing any more — `expo-camera/next` became the default in SDK 51
and the legacy API was removed in SDK 52.

Attaching from outside:

* **Android is sealed.** `ExpoCameraView.kt` (sdk-53) does build an `ImageAnalysis` use case with
  `STRATEGY_KEEP_ONLY_LATEST`, but `private var imageAnalysisUseCase`, `private var cameraProvider`,
  `private fun createImageAnalyzer()`, and the analyzer is attached only
  `if (shouldScanBarcodes)` with a hard-wired `BarcodeAnalyzer`.
* **iOS is theoretically reachable** — `CameraView.swift` declares
  `public var session: AVCaptureSession!` — but there is no supported hook and it would break on any
  expo-camera patch.

Margelo's own comparison marks Expo Camera ❌ for *"Realtime Frame Processing"* and ❌ for
*"Native Frame Processor Plugins"*
([visioncamera.margelo.com/docs/visioncamera-vs-expo-camera](https://visioncamera.margelo.com/docs/visioncamera-vs-expo-camera)).

### 5.6 The custom local Expo Module (recommended) — mechanics and cost

**Creation and linking.** `npx create-expo-module@latest --local` creates `modules/<name>/` with
`android/`, `ios/`, `src/`. Autolinking finds it automatically: Expo's autolinking doc defines
`nativeModulesDir` as *"A path relative to the app's root directory that Expo Autolinking should
search for local modules to autolink. This option defaults to `"./modules"`."* Discovery needs an
`expo-module.config.json` at the module root declaring `platforms` and the module class names.
On EAS, `expo prebuild` generates `ios/`/`android/` in the build container and autolinking runs as
part of it, so nothing needs to be committed. *(Caveat: there is no Expo doc sentence naming EAS
specifically; this follows from the `./modules` default plus EAS's prebuild step, and is what the
community does in practice.)*

**Third-party native deps from a local module are documented.**
[docs.expo.dev/modules/third-party-library](https://docs.expo.dev/modules/third-party-library/)
shows exactly the pattern we need — iOS `s.dependency 'DGCharts', '~> 5.1.0'` in the module's
podspec, Android `implementation 'com.github.PhilJay:MPAndroidChart:v3.1.0'` in the module's
`build.gradle`. So `s.dependency 'MediaPipeTasksVision', '0.10.35'` and
`implementation 'com.google.mediapipe:tasks-vision:0.10.35'` (pinned, not `0.10.+`) are on the
documented path, and both resolve from public CocoaPods/Maven on EAS.

**Shipping the models.** Three documented options, in order of preference:

1. **Native resources.** iOS: `s.resource_bundles = { 'DmsVision' => ['assets/*'] }` in the podspec.
   Android: `modules/<name>/android/src/main/assets/` — MediaPipe's
   `BaseOptions.setModelAssetPath(...)` reads straight from the asset manager. No download, no
   first-run latency, guaranteed path.
2. **`expo-asset` config plugin:** `["expo-asset", { "assets": ["assets/models/face_landmarker.task"] }]`
   *"generates native resources so files are available before app logic runs"*; then
   `Asset.fromModule(require(...)).localUri` gives a `file://` path to hand to native. This is also
   the workaround for the `asset://` bug in §5.3.
3. **`downloadAsync()` + `expo-file-system`** — works, but the docs warn *"there is no guarantee
   that files downloaded via downloadAsync persist between app sessions"*. Avoid for required models.

**Getting results out.** The Expo Modules API convertibles table has `Data` (iOS) / `kotlin.ByteArray`
(Android) <-> **`Uint8Array`** (SDK 50+). **There is no `Float32Array` convertible** — the pattern is
to send `Uint8Array` and re-view it:
`new Float32Array(u8.buffer, u8.byteOffset, u8.length / 4)` (guard `byteOffset % 4`). A historical
Android bug where `ByteArray` in a `sendEvent` payload arrived as a string ID
([expo/expo#29566](https://github.com/expo/expo/issues/29566), fixed by
[#32945](https://github.com/expo/expo/pull/32945) in expo-modules-core 2.0.3) **does not affect
SDK 53**, which ships expo-modules-core 2.5.0 — but it is worth knowing because it corrupted data
silently rather than throwing.

`SharedObject` / `SharedRef` also exist
([docs.expo.dev/modules/shared-objects](https://docs.expo.dev/modules/shared-objects/)) if a native
buffer ever needs to be handed around by reference.

**But per §2.2, the right design sends 3 floats per frame, not 1,434** — so none of this is on the
critical path. Keep a debug-only landmark event behind a flag.

**LOC estimate, net new on top of the vendored ~2,400 lines:**

| Work | LOC |
|---|---|
| Move the camera off `ExpoView` onto the module object (preview-free) | ~120 (60 per platform) |
| Second `FaceLandmarker` instance + horizontal flip of the frame | ~80 |
| Mirror permutation + averaging + `(478,3)` tensor assembly + `context` | ~180 |
| Camera intrinsics (iOS FOV + intrinsic matrix; Android Camera2 formula) | ~150 |
| ONNX Runtime (or TFLite) session, batch 2, output plumbing | ~120 |
| Real timestamps, fps throttle, thermal hook | ~80 |
| Fixes from §5.3 (pinning, deprecated APIs, per-frame bitmap) | ~100 |
| **Total** | **~830** |

Against a blank file this would be ~3,000 LOC. The fork is the difference.

**There is no official Expo example of a local module running a camera** — but
**expo-camera itself is an ordinary Expo module**, and its
`ios/Current/CameraView.swift` (AVCaptureSession on a dedicated serial `sessionQueue`) and
`android/.../ExpoCameraView.kt` (CameraX use cases bound to a lifecycle owner) are the reference
implementation. Read those alongside the `expo-mediapipe` fork.

---

## 6. fps budget

Measured on this machine (AMD Ryzen 7 9800X3D), single thread, batch 1 / batch 2:

| Runtime | batch 1 | batch 2 (mirror TTA) |
|---|---|---|
| ONNX Runtime 1.28 CPU, 1 thread | 4.16 ms | 8.09 ms |
| ONNX Runtime, 2 threads | 2.59 ms | 4.92 ms |
| ONNX Runtime, 4 threads | 1.78 ms | 3.31 ms |
| TFLite (LiteRT 2.1.2 + XNNPACK), 1 thread | **3.06 ms** | not measured |

A modern phone big core is roughly 2-3x slower per core than this desktop on this workload, so
budget **~8-25 ms per frame for the gaze net at batch 2** on the CPU, less with 2 threads.

MediaPipe: research-side cost for the task-graph mirror pair is 12.6 ms on one pinned desktop CPU
thread at 800 px. On a phone with the GPU delegate the attention mesh is typically in the 5-15 ms
range per pass, so **~10-30 ms for the pair**. Google publishes no CPU/GPU latency table for the
Face Landmarker task, so this is an estimate, not a citation.

**Total ~20-55 ms/frame.** 20 fps (50 ms) is achievable on mid-to-high-end hardware but is **not
free**: plan an explicit frame throttle (process every Nth frame, or drop while busy), run the two
mesh passes concurrently if the delegate allows, and wire the thermal signal in §9 to a graceful
fps reduction. A dash-mounted phone running camera + two neural nets continuously *will* throttle.

---

## 7. Camera intrinsics and frame orientation

This section is where a silent, systematic gaze error is most likely to come from.

### 7.1 iOS

**`AVCaptureDevice.Format.videoFieldOfView`** — Apple, verbatim: *"Indicates the format's
horizontal field of view in degrees."* `var videoFieldOfView: Float { get }`; *"Returns zero if the
format's field of view is unknown."* So `fx_px ≈ (W/2) / tan(FOV_h/2)`, giving
`focal_scale = fx/W = 1 / (2 tan(FOV_h/2))`. **Apple does not say whether this is the full sensor or
the cropped output**, and it does not account for `videoZoomFactor` or for `videoSettings` that
request a different aspect ratio. Treat it as a fallback and verify on device.

**The camera intrinsic matrix is the better source, with real constraints.**

* `isCameraIntrinsicMatrixDeliverySupported`, verbatim: *"The property is only `true` if both the
  connection's input device format and output type support delivering camera intrinsics. In iOS 11,
  the `AVCaptureVideoDataOutput` class is the only output type that supports camera intrinsics."*
* `isCameraIntrinsicMatrixDeliveryEnabled`, verbatim: *"You can set this property to `true` for a
  video connection if `isCameraIntrinsicMatrixDeliverySupported` is `true`, and **only before
  calling the `AVCaptureSession` `startRunning()` method. The default value is `false`.**"*
* Then each sample buffer may carry `kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix` — *"a 3x3
  camera intrinsic matrix"*, read via `CMGetAttachment` / `sampleBuffer.attachments[.cameraIntrinsicMatrix]`
  as a `matrix_float3x3`.
* Units: Apple states on `AVCameraCalibrationData` that `K = [fx 0 ox; 0 fy oy; 0 0 1]` and *"The
  equation expresses all values in pixels… `ox` and `oy` values are the offsets of the principal
  point, from the top-left corner of the image frame."*
* **Caveat:** the sample-buffer attachment carries no reference-dimensions companion. For
  `AVCaptureVideoDataOutput` the working assumption is "relative to the delivered buffer", but Apple
  does not state it. Verify with `fx ≈ (W/2)/tan(FOV_h/2)` on device.
* **Video stabilization blocks it.** An Apple Media Engineer, Apple Developer Forums thread 82668:
  *"The reason you're not getting intrinsics is because you're setting the video stabilization mode
  to something other than None. Video stabilization moves the pixels around in the frame such that
  the values in the intrinsic matrix can no longer be relied upon."* VisionCamera v5 treats this as
  hard: `enableCameraMatrixDelivery` is documented `@throws If video stabilization is enabled`.
* **Front-camera support is device-dependent** (community reports: iPhone X yes, iPhone 7 Plus yes,
  iPad Pro no). **Probe at runtime and always keep the FOV fallback.**

**Mirroring.** `AVCaptureConnection.isVideoMirrored`, verbatim: *"Capture connections to
`AVCaptureVideoDataOutput` and `AVCaptureDepthDataOutput` instances mirror video frames they provide
to their `captureOutput(_:didOutput:from:)` … delegate methods… Each `AVCaptureVideoDataOutput`
instance uses hardware acceleration to mirror every frame."* And
`automaticallyAdjustsVideoMirroring` defaults to `true`, so the value *can* change on you. The
widely reported behaviour is that AVFoundation auto-mirrors the **preview layer** but not the
**video data output** — this is the one item that could not be pinned to an Apple doc sentence.
**Set `automaticallyAdjustsVideoMirroring = false; isVideoMirrored = false` explicitly** and do any
mirroring yourself.

**Orientation.** The front camera streams in the sensor's native landscape orientation regardless of
how the phone is held, so a portrait device gives a buffer that is 90 deg off. `videoRotationAngle`
(iOS 17+), verbatim: *"Connections to `AVCaptureVideoDataOutput` and `AVCaptureDepthDataOutput`
instances deliver physically rotated buffers instead, which costs work on every frame… If your app
rotates buffers itself, set `videoRotationAngle` to `0` to keep the connection from rotating them
again."* QA1744 says the same about the deprecated `videoOrientation`.

**Recommendation: leave rotation at 0 and mirroring off**, hand MediaPipe the native landscape
buffer with an orientation flag, and keep the intrinsics in that same un-rotated buffer frame.
(Whether the intrinsic attachment is rotated when `videoRotationAngle != 0` is undocumented —
another reason to keep it at 0.) Note that `expo-mediapipe@0.4.1` does the opposite
(`connection.videoOrientation = .portrait`, and `MPImage(pixelBuffer:)` with no orientation), so
this is one of the things a fork should change.

### 7.2 Android

`LENS_INTRINSIC_CALIBRATION` is **not** the answer: AOSP marks it *"Optional - The value for this
key may be `null` on some devices"*, it is populated mainly on depth/multi-camera devices, it is
commonly `null` or `[0,0,0,0,0]` on front cameras, and its units are *"Pixels in the
`android.sensor.info.preCorrectionActiveArraySize` coordinate system"* — a different frame from the
delivered image.

**Compute it instead.** AOSP javadoc: `LENS_INFO_AVAILABLE_FOCAL_LENGTHS` is in millimetres and
*"is available on all devices"*; `SENSOR_INFO_PHYSICAL_SIZE` is *"The physical dimensions of the
**full pixel array**"* in millimetres (note: pixel array, **not** active array).

```
mmPerPx_x = physicalSize.width  / pixelArraySize.width
mmPerPx_y = physicalSize.height / pixelArraySize.height
activeW_mm = activeArray.width()  * mmPerPx_x
activeH_mm = activeArray.height() * mmPerPx_y

outAR = outW / outH ;  actAR = activeW_mm / activeH_mm
if (outAR > actAR) { cropW_mm = activeW_mm; cropH_mm = activeW_mm / outAR; }
else               { cropH_mm = activeH_mm; cropW_mm = activeH_mm * outAR; }

fx_px = focalLengthMm * outW / cropW_mm          // focal_scale = fx_px / outW
cx = outW / 2 ; cy = outH / 2
```

The centre-crop step is documented behaviour (source.android.com, *Camera cropping*): *"If the
stream's aspect ratio is wider than the crop region, the stream should be further cropped
vertically… In all cases, the stream crop must be centered within the full crop region."*
**Counter-caveat, verbatim from `SCALER_CROP_REGION`:** *"the application shouldn't assume the
maximum crop region always maps to the same aspect ratio or field of view for the sensor output"* —
some devices apply in-sensor crop/binning. So the formula is a good estimate, not a guarantee.

**Better: use `ImageInfo.getSensorToBufferTransformMatrix()`** — *"a mapping from sensor coordinates
to buffer coordinates, which is, from the value of `CameraCharacteristics#SENSOR_INFO_ACTIVE_ARRAY_SIZE`
to `(0, 0, image.getWidth, image.getHeight)`"*. It already encodes crop, scale and flip, so it
carries active-array intrinsics into delivered-frame pixels without hand-rolled crop math.

Access from CameraX: `Camera2CameraInfo.from(cameraInfo).getCameraCharacteristic(key)` (requires
`@ExperimentalCamera2Interop`). Note that in `androidx-main` the whole `Camera2CameraInfo` class is
now **deprecated** in favour of `Camera2Interop.getCameraCharacteristics` / `CameraInfo.cameraCharacteristics`;
check which your pinned `androidx.camera:camera-camera2` exposes (latest released is 1.6.2).

**Mirroring: Android buffers are never mirrored.** Proof from `ImageAnalysis.Builder` source:

```java
/** setMirrorMode is not supported on ImageAnalysis. */
@Override public @NonNull Builder setMirrorMode(@MirrorMode.Mirror int mirrorMode) {
    throw new UnsupportedOperationException("setMirrorMode is not supported.");
}
```

Mirroring on Android is a presentation concern (PreviewView transform, `VideoCapture` mirror mode,
`ImageCapture` EXIF). **This iOS/Android asymmetry is the single biggest left/right sign risk in the
gaze pipeline.**

**Orientation.** `SENSOR_ORIENTATION`, verbatim: *"Clockwise angle through which the output image
needs to be rotated to be upright on the device screen in its native orientation… Range: 0, 90, 180,
270. This key is available on all devices."* Front cameras are commonly **270**. Official formula:

```kotlin
val sign = if (lensFacing == LENS_FACING_FRONT) 1 else -1
return (sensorOrientationDegrees - surfaceRotationDegrees * sign + 360) % 360
```

For a portrait phone (`surfaceRotationDegrees = 0`) and a front sensor at 270, that is **270 deg
clockwise**. Foldables caveat (API 32+): logical cameras can change orientation with fold state —
*"Clients are advised to not cache or store the orientation value of such logical sensors."*

CameraX `ImageAnalysis` delivers `YUV_420_888` by default (also `RGBA_8888`, `NV21`, `PRIVATE`), and
`ImageInfo.getRotationDegrees()` gives *"a clockwise rotation in degrees that needs to be applied to
the image buffer"*. `setOutputImageRotationEnabled` would do it for you, but the javadoc warns:
*"Turning this on will add more processing overhead to every image analysis frame. The average
processing time is about 10-15 ms for 640x480 image on a mid-range device… By default, the rotation
is disabled."* Keep it disabled.

### 7.3 What VisionCamera exposes (relevant only if option B is chosen)

* **v4.7.3 `CameraDeviceFormat.fieldOfView: number`** — *"The video field of view in degrees"*. But
  **the two platforms compute different quantities under this one name:**
  * iOS (`CameraDeviceFormat.swift`): `format.videoFieldOfView` -> **horizontal**, per format.
  * Android (`CameraDeviceDetails.kt`): a **diagonal** FOV, `2*atan2(sensorDiagonal, 2*focalLength)`,
    computed from `SENSOR_INFO_PHYSICAL_SIZE` (the *full pixel array*) at the **shortest** available
    focal length, and written into **every** format with the same device-level value —
    it does not vary with resolution and ignores output crop.
  **Do not use `format.fieldOfView` on Android as a camera scalar.**
* **v4 exposes no camera intrinsic matrix.** The feature request
  [#3093](https://github.com/mrousavy/react-native-vision-camera/issues/3093) was answered only by v5.
* **v5 does expose it** — `Frame.cameraIntrinsicMatrix?: number[]`, column-major 3x3, top-left
  origin, pixels (`fx = m[0], fy = m[4], cx = m[6], cy = m[7]`), gated on
  `FrameOutputOptions.enableCameraMatrixDelivery` and documented `@platform iOS`. Android is
  explicitly `// TODO: Implement cameraIntrinsicMatrix` returning `null`. Note the iOS
  implementation silently no-ops if `isCameraIntrinsicMatrixDeliverySupported` is false. **v5 is
  unusable on RN 0.79 anyway** (§5.1) — recorded here in case the app later moves to Expo 55+.
* **`Frame`** in v4: `isValid, width, height, bytesPerRow, planesCount, isMirrored, timestamp,
  orientation, pixelFormat, toArrayBuffer(), getNativeBuffer()`. `timestamp` is *"relative to the
  host system's clock"*.
* **Orientation is relative, not absolute** — in both v4 and v5 `frame.orientation` is defined
  against the *output's target orientation*, not the device and not the sensor. VisionCamera's own
  guide: *"Orientation is not applied automatically - instead, it is passed alongside as metadata,
  relative to what the CameraOutput's target `outputOrientation` is."* Pin `outputOrientation`
  explicitly.
* **`isMirrored: false` does not mean "the pixels are un-mirrored"** — it means "the buffer matches
  the target mirror mode". Worse, in v5 the iOS implementation under the default `mirrorMode: 'auto'`
  hardcodes `isMirrored = false` without consulting `connection.isVideoMirrored`. Force
  `mirrorMode: 'off'` on both platforms.

---

## 8. Runtime and operator coverage

### 8.1 ONNX

Verified locally with `onnx 1.22` / `onnxruntime 1.28`:

```
ir_version 8, opset [("", 17)], 35 op types:
Add Atan Cast Clip Concat Constant ConstantOfShape Cos Div Equal Erf Expand Flatten Gather Gemm
Greater LayerNormalization Less MatMul Mul Neg ReduceL2 ReduceSum Reshape Shape Sin Slice Softmax
Split Sqrt Squeeze Sub Transpose Unsqueeze Where
inputs : cloud ['batch',478,3] f32 | context ['batch',7] f32 | validity ['batch',478] f32
outputs: gaze ['batch',3] f32 | rotation ['batch',3,3] f32
```

**`onnxruntime-react-native` ships the FULL ORT build — no `.ort` conversion is needed.** Evidence
from the published tarball of 1.24.3:

* `onnxruntime-react-native.podspec`: `spec.dependency "onnxruntime-c"` — the full ORT C pod, not
  `onnxruntime-mobile-c`.
* `android/build.gradle`:
  `extractLibs "com.microsoft.onnxruntime:onnxruntime-android:latest.integration@aar"`, immediately
  under the comment `// By default it will just include onnxruntime full aar package`.

So `LayerNormalization` (opset 17), `Atan`, `Erf`, `Where`, `ConstantOfShape`, `ReduceL2` are all
covered, and the `.onnx` file can be loaded as-is.

README, verbatim: *"ONNX Runtime React Native version 1.13 supports both ONNX and ORT format
models, and includes all operators and types. Previous ONNX Runtime React Native packages use the
ONNX Runtime Mobile package…"* (the switch is visible in the tarballs: 1.12.1 used
`onnxruntime-mobile-c` / `onnxruntime-mobile`, 1.13.1 moved to `onnxruntime-c` / `onnxruntime-android`).
ORT's own mobile docs on those packages: *"The above packages all contain the full ONNX Runtime
feature and operator set and support for the ONNX format."*

Execution providers compiled in (`cpp/SessionUtils.cpp`): `cpu`, `xnnpack`, `coreml` (iOS, via
`-DUSE_COREML` in the podspec), `nnapi` (Android, on by default), `qnn`. Usable session options
include `executionProviders`, `intraOpNumThreads`, `interOpNumThreads`, **`freeDimensionOverrides`**
(pin the dynamic batch), `graphOptimizationLevel`, `coreMlFlags`. For an unquantized model ORT's own
guidance is to start with XNNPACK.

**Marshalling is genuinely zero-copy since 1.24.1** (2026-02-05 — that release added 13 C++ files,
`cpp/InferenceSessionHostObject.cpp`, `TensorUtils.cpp`, `AsyncWorker.h`, …, upstreamed from
`mybigday/onnxruntime-react-native-jsi`). `lib/binding.ts` now does
`if (typeof globalThis.OrtApi === 'undefined') Module.install()` and everything runs through a JSI
HostObject. `TensorUtils.cpp` hands your `Float32Array`'s backing store straight to
`Ort::Value::CreateTensor` — no base64, no bridge serialisation, no copy for the 1,434-float input.
Output is one `memcpy` into a fresh typed array (48 bytes here), and passing pre-allocated tensors in
`fetches` makes the output zero-copy too (`onnxruntime-common`: *"If an OnnxValue is present it will
be used as a pre-allocated value by the inference engine"*). Historic pre-JSI overheads (Pixel 6, RN
0.71: *"Android: 20 ~ 30 ms on Hermes"* per `run()`) no longer apply.

**Five caveats that matter for this app:**

1. **Both native dependencies are unpinned.** iOS `spec.dependency "onnxruntime-c"` with no version,
   Android `latest.integration`. CocoaPods trunk currently has `onnxruntime-c` / `onnxruntime-objc`
   at **1.30.0 (2026-09-10/11)** and Maven has `onnxruntime-android` at **1.30.0**, while the npm
   package's JS/JNI layer is at **1.24.3 (2026-03-05)**. A build today links a native runtime ~6
   minor versions ahead of the wrapper, and a build next month may link a different one. Pin both.
2. **It is a legacy bridge module + JSI install, not a TurboModule.** `codegenConfig` is `null`; the
   New-Architecture PR [#16669](https://github.com/microsoft/onnxruntime/pull/16669) was **closed
   unmerged on 2025-07-03**. `OnnxruntimeModule.java` calls
   `getCatalystInstance().getJSCallInvokerHolder()` — normally a bridgeless landmine, but RN
   v0.79.5's `BridgelessCatalystInstance.kt` *does* implement both `javaScriptContextHolder` and
   `jsCallInvokerHolder` (most other methods `throw UnsupportedOperationException`). iOS uses
   `RCTCxxBridge`, and under bridgeless RN 0.79.5's `RCTBridgeProxy.mm` implements `runtime` and
   `jsCallInvoker` while logging "Please migrate to C++ TurboModule" warnings. So: expect console
   noise, not a failure — but smoke-test it in build 1.
3. **iOS teardown segfault, unfixed on npm.**
   [#29197](https://github.com/microsoft/onnxruntime/issues/29197) — `OnnxruntimeModule.mm` clears a
   static `jsi::Env` in `-dealloc`, which runs *after* the JSI runtime is destroyed;
   *"reliably reproducible on cold-launch followed by app close, on fast refresh, and on bridge
   reload."* Fixed on `main` (move `env.reset()` into `-invalidate`), **not in 1.24.3**.
   [#29678](https://github.com/microsoft/onnxruntime/issues/29678) is the same class of defect and is
   still open. Budget a `patch-package`.
4. **Expo Android package registration.** The published `app.plugin.js` only adds the Gradle project
   and the Podfile line — it does **not** register `OnnxruntimePackage` in `MainApplication`, and the
   package still ships a `unimodule.json`. That combination has produced
   `TypeError: Cannot read property 'install' of null` on Expo 54
   ([#26796](https://github.com/microsoft/onnxruntime/issues/26796),
   [#19510](https://github.com/microsoft/onnxruntime/issues/19510),
   [#29004](https://github.com/microsoft/onnxruntime/issues/29004) — the latter closed as *stale*,
   and the fixing PR [#29005](https://github.com/microsoft/onnxruntime/pull/29005) is still open).
   *Mitigating evidence specific to SDK 53:* `expo@53.0.23` pins
   `expo-modules-autolinking@2.1.14`, whose `reactNativeConfig/reactNativeConfig.ts` contains **no
   Expo-module exclusion at all** (it skips only packages that declare `platforms`, and
   `react-native` itself), and whose `androidResolver.ts` finds packages by scanning for
   `**/*Package.{java,kt}` — which hits `OnnxruntimePackage.java`. SDK 54's autolinking 3.0.27
   *does* early-return on Expo modules. So SDK 53 should be fine, but **check `PackageList.java` on
   the first failed boot**; the fix is the `withMainApplication` block from `main`'s `app.plugin.js`.
5. **Loading the model from an Expo asset is a known iOS failure.**
   [#26738](https://github.com/microsoft/onnxruntime/issues/26738) (open): *"In the Expo dev client,
   loading a bundled model via `Asset.fromModule(...).localUri` works. In the standalone iOS build,
   `InferenceSession.create(localUri)` fails when the model stays in the app bundle."* Workaround:
   `FileSystem.copyAsync` into `documentDirectory` first, or load the bytes as a `Uint8Array`
   (1.24.x accepts both; the old "ArrayBuffer not supported" README line is stale). Also add `onnx`
   to `resolver.assetExts` in `metro.config.js`.

**Two behavioural notes for a 20 fps loop:** `run()` is **Promise-only** — there is no sync JSI
path, which is good (inference runs off the JS thread) — but `AsyncWorker::toPromise()` **spawns a
new `std::thread` for every call**, i.e. 20-30 thread creations per second. And because the input
tensor *wraps* your `Float32Array` rather than copying it, **mutating that array while a `run()` is
in flight corrupts the inference** — double-buffer.

**Preferred alternative: link ORT natively inside the module** (`onnxruntime-objc` / `onnxruntime-c`
pod + `com.microsoft.onnxruntime:onnxruntime-android` AAR, both pinned). ~60 LOC per platform, and
it removes caveats 2-5 entirely — no bridgeless interop question, no teardown patch, no autolinking
question, no asset-path bug.

### 8.2 ONNX -> TFLite conversion experiment (run, and it works exactly)

Ran in a throwaway venv (`onnx2tf 2.6.9`, `tensorflow 2.21.0`, `onnx 1.20.1`):

```bash
python -m onnx2tf -i gaze_direct.onnx -o tf_kat -b 1 -kat cloud context validity -osd
```

* `-b 1` fixes the dynamic batch to 1.
* **`-kat cloud context validity` is required.** Without it, onnx2tf's automatic layout conversion
  rewrites `cloud` from `(1,478,3)` to `(1,3,478)`, so the JS side would have to transpose.

Results:

| Artifact | Size | Parity vs `gaze_direct.parity.npz` (8 cases) | Speed (1 thread, Ryzen 9800X3D) |
|---|---|---|---|
| `gaze_direct_float32.tflite` | 3.53 MB | **max abs err 1.788e-7** (gaze), 2.682e-7 (rotation); **gaze angular error max 0.000000 deg** | 3.06 ms |
| `gaze_direct_float16.tflite` | 1.87 MB | not runnable on the stock CPU kernel path | — |

(The reference ORT run on the same npz gives max abs err 1.34e-7, so the TFLite model is within
ONNX Runtime's own float noise.)

Model properties:

* **962 nodes, 36 builtin op types**, all at **operator version v1**, flatbuffer schema `TFL3`:
  `ADD ATAN2 BATCH_MATMUL CAST CONCATENATION COS DIV EQUAL FILL FULLY_CONNECTED GATHER GELU GREATER
  LESS MAXIMUM MEAN MINIMUM MUL NEG RELU RELU_0_TO_1 RESHAPE SELECT SELECT_V2 SHAPE SIN SLICE
  SOFTMAX SPLIT SQRT SQUEEZE STRIDED_SLICE SUB SUM TRANSPOSE` (+ `DELEGATE`).
* **No Flex / SELECT_TF_OPS**, so it runs on the stock TFLite runtime with no extra delegate.
* All-v1 operator versions means any runtime that knows the op at all can run it. The newest ops
  here are `ATAN2` (TF 2.11), `GELU` (TF 2.10), `RELU_0_TO_1` (TF 2.11) — all inside
  `react-native-fast-tflite`'s bundled runtimes (iOS `TensorFlowLiteC 2.17.0`; Android
  `com.google.ai.edge.litert:litert 1.4.0`). **Residual risk is low but non-zero** and should be
  settled by loading the model once on each platform.
* The **float16** model needs an fp16-capable delegate (GPU / CoreML, or XNNPACK with fp16
  inference); the default CPU kernel path rejects it with
  `input->type != kTfLiteFloat32 (FLOAT16 != FLOAT32)`. Do not ship fp16 as the CPU fallback.

Artifacts are in the session scratchpad
(`.../scratchpad/gaze_direct_float32.tflite`, `gaze_direct_float16.tflite`); the command above
reproduces them in ~30 s.

**Tooling notes.** `onnx2tf` (2.6.9, 2026-09-14, 629 releases) is the only live option: `onnx-tf`
has had no release since 2022-03-17, `ai-edge-torch` 0.7.2's own summary reads *"DEPRECATED: renamed
to litert-torch"*, and `litert-torch` is a PyTorch->LiteRT path, not an ONNX one. All 35 of this
model's ONNX op types have lowerings in `onnx2tf/ops/` (211 ops total). Two flags beyond the ones
used above are worth knowing if the model ever changes:

* **`-cotof` (optionally `-cotoa 1e-1`)** runs a per-operator output comparison against ONNX Runtime.
  For a transformer this should be a gate, not an option. The README's BERT-SQuAD example is
  `onnx2tf -i bertsquad-12.onnx -b 1 -fdosm -osd -cotof`.
* **`-ois cloud:1,478,3 context:1,7 validity:1,478`** pins all three inputs explicitly, which is
  safer than `-b 1` alone when the inputs are heterogeneous.

Two documented `onnx2tf` constraints that did *not* bite this graph but would bite a changed one:
`Gemm` lowers to `FULLY_CONNECTED` only for *"Input rank=2, weight rank=2 + constant, `transA=0`
only"*, and `LayerNormalization` is **decomposed** into `MEAN + SUB + MUL + ADD + SQRT + DIV` rather
than mapped to a fused kernel — six ops per norm instead of ORT's one. **The measurement above
answers that concern empirically:** even decomposed, the TFLite graph ran at 3.06 ms against ORT's
4.16 ms on the same machine.

**Conclusion: TFLite is a fully viable second runtime for the gaze net**, it is exact, it was
slightly *faster* than ORT in this benchmark, and its runtime binary is ~25 MB smaller (§8.3).

### 8.3 Binary size — the one place the two runtimes differ by an order of magnitude

Measured with `HEAD` requests against Maven Central / Google Maven on 2026-09-18:

| Artifact | AAR size | Note |
|---|---|---|
| `com.microsoft.onnxruntime:onnxruntime-android:1.30.0` | **50.6 MB** | `jni/arm64-v8a/libonnxruntime.so` alone is **31.5 MB uncompressed**; the 1.24.3 AAR is 39.1 MB |
| `com.google.ai.edge.litert:litert:1.4.0` | **7.9 MB** | all ABIs |
| `com.google.mediapipe:tasks-vision:0.10.35` | 0.2 MB | thin wrapper… |
| `com.google.mediapipe:tasks-core:0.10.35` | **20.4 MB** | …the native graph runtime arrives here, transitively |

So MediaPipe alone adds ~20 MB of AAR; adding ORT roughly triples that, at **~+10-13 MB compressed
per shipped ABI**. ORT's docs note that a custom *minimal* build can cut `libonnxruntime.so` from
16.3 MB to 3.96 MB, but *"It requires the use of ORT format models"* and a source build — not worth
it here. Mitigate instead with a pinned version and Android App Bundle ABI splits.

**The open question that decides ORT-vs-TFLite inside the native module:** `MediaPipeTasksVision`
statically links its own copy of TFLite, and `TensorFlowLiteC` is a second static framework of the
same library. Whether CocoaPods links both into one binary without duplicate-symbol errors is
**unverified** — I have found no report either way. ORT has no such overlap (entirely different
symbol namespace). That is why ORT is the recommended default despite being larger: it is the
configuration with no unknown at link time. If the size matters, test the TFLite pairing in EAS
build 1 — it is a one-line podspec change to find out.

### 8.4 `react-native-fast-tflite`

* **3.0.1 (2026-04-21)** requires `react-native-nitro-modules`. Nitro's stated minimum is
  *"react-native 0.75 or higher"*, `compileSdkVersion >= 34`, `ndkVersion >= 27`, Xcode 16.4+,
  Swift 5.9+. RN 0.79 clears the RN floor on paper, but mrousavy dev-builds against RN 0.85.
* **1.6.1 (2025-04-08)** is the pre-Nitro release, peer deps `react: *, react-native: *`, and is the
  contemporary of RN 0.78/0.79. **It bundles the same `TensorFlowLiteC 2.17.0`** on iOS
  (Android: `litert 1.0.1` rather than 1.4.0) and **already has the full Expo plugin**
  (`withFastTFLite`, `withCoreMLDelegate`, `withAndroidGpuLibraries`). If a JS-side TFLite runtime
  is ever wanted on this RN version, 1.6.1 is the safer pin.
* **`runSync` works outside a worklet.** The Nitro spec declares it as a plain synchronous
  HybridObject method with nothing worklet-specific:
  `runSync(input: ArrayBuffer[]): ArrayBuffer[]` / `run(input: ArrayBuffer[]): Promise<ArrayBuffer[]>`,
  and the v3 migration guide shows `const output = model.runSync([float32Array.buffer])` with no
  worklet context. The VisionCamera example in the README is one usage, not a constraint. Caveat:
  `runSync` on the JS thread blocks it for the whole inference — at 20 fps prefer `run()`.
* **v3 changed the I/O type**: `ArrayBuffer[]` in and out (v2 took/returned TypedArrays). Slice views
  first: `typedArray.buffer.slice(byteOffset, byteOffset + byteLength)`. Multi-input is supported and
  `model.inputs` / `model.outputs` expose `{name, dataType, shape}` — **but binding is positional,
  not by name**, so the three inputs must be ordered to match whatever tensor order onnx2tf emits.
  That is a real correctness trap; read the order off `model.inputs` at runtime rather than assuming.
* **New Architecture is explicitly supported in v3**: the 3.0.0 notes say *"we migrated the entire
  module to a Nitro Module! … Support for new arch (+bridgeless), and old arch"*, with
  *"Support Bridgeless mode using `RCTTurboModuleWithJSIBindings`"* (#167) and a fix for
  *"SIGSEV crashes from stale `jsi::ArrayBuffer` cache"* (#172).
* Delegates: `loadTensorflowModel(require('model.tflite'), ['core-ml' | 'android-gpu' | 'metal' | 'nnapi'])`,
  enabled via the Expo plugin options `enableCoreMLDelegate: true` / `enableAndroidGpuLibraries: true`.
  README warnings: *"Not all model operations are supported on the CoreML delegate"* and
  *"NNAPI is deprecated on Android 15. GPU delegate is preferred."* For an 867k-param model the
  delegate setup and transfer costs will likely dominate — measure before enabling.
* Requires `'tflite'` in `resolver.assetExts` in `metro.config.js`.
* **The RN 0.79 risk is real but circumstantial.** The repo moved to `margelo/react-native-fast-tflite`;
  its example app on `main` runs `react-native 0.85.0-rc.5`, and both its `android/build.gradle` and
  `react-native-nitro-modules`' declare **AGP 9.x** while Expo SDK 53 is on AGP 8.8.x (library
  buildscript classpaths are normally overridden by the root project, so this often does not bite).
  Nobody is testing RN 0.79 + nitro 0.37. If this path is taken, expect to pin an older
  `react-native-nitro-modules` (the 0.26-0.29 line, Jun-Sep 2025, was contemporary with RN 0.79) and
  accept that fast-tflite 3.0.1's nitrogen-generated code may not compile against it — failures would
  be compile-time, not a clean error.

### 8.5 `react-native-executorch` — blocked

* `0.10.2` (2026-09-18, MIT) peer-requires `react-native-worklets >= 0.10.0 < 0.13.0`, and **every**
  version in that range demands RN 0.83+: `react-native-worklets@0.10.0` declares
  `peerDependencies.react-native: "0.83 - 0.86"`, `0.12.2` declares `"0.83 - 0.87"`. RN 0.79.5 is
  four minors short, and there is no `overrides` trick that makes it safe — worklets ships C++
  compiled against RN internals.
* `0.6.0` onwards peer-requires `expo: ">=54.0.0"` and `expo-file-system: "^19.0.0"` (SDK 54).
* The docs say it outright: *"React Native 0.83+"* or *"Expo SDK 55+"* with development builds,
  New Architecture required, iOS 17.0+, Android 13+ (minSdk 26), *"Expo Go is not supported"*, and
  **"Expo SDK 54 cannot be supported"** ([getting started](https://docs.swmansion.com/react-native-executorch/docs/fundamentals/getting-started)).
* `0.9.3` (the `legacy` dist-tag) and `0.8.5` have peer deps of only `{react, react-native}` — but
  they still require the New Architecture and a `.pte`, and pin you to an EOL branch.
* Independently: **there is no ONNX -> ExecuTorch path.** ExecuTorch's own getting-started documents
  only `torch.export.export(...) -> to_edge_transform_and_lower(...) -> to_executorch()` and does not
  mention ONNX at all; the only bridge would be `onnx2torch`, whose last release is 1.5.15 from
  2024-08-07. The right move would be to export `.pte` directly from
  `gaze-direct/checkpoints/gaze_direct_promoted.pt`, which is not available to this investigation.

### 8.6 Other RN ONNX runtimes

There is no Nitro-based or otherwise-better general-purpose ONNX wrapper on npm.
`onnxruntime-react-native-jsi` (mybigday/hans00, 1.23.0, 2025-10-22, 1 GitHub star,
*"Experimental React Native JSI implement for onnxruntime"*) is **the code that was upstreamed into
official 1.24.1** and is now redundant. `@fugood/onnxruntime-react-native` was abandoned in 2023.
`react-native-sherpa-onnx` / `@siteed/sherpa-onnx.rn` / `react-native-openwakeword` wrap
speech-specific pipelines and expose no generic `InferenceSession`.

---

## 9. Thermal state and low-power mode

**Neither `expo-battery`, `expo-device` nor `react-native-device-info` exposes thermal state.**

| Package | Low-power mode | Thermal state |
|---|---|---|
| `expo-battery` (now in `package.json` at `~9.1.4`) | `isLowPowerModeEnabledAsync()`, `addLowPowerModeListener()`, `useLowPowerMode()`, `getPowerStateAsync()` | **none** |
| `react-native-device-info` | `getPowerState()` -> `{ batteryLevel, batteryState, lowPowerMode }` | **none** (zero `thermal` hits in its public surface) |
| `expo-device` | none | none |

Platform APIs, for a small native module:

* iOS: `ProcessInfo.processInfo.thermalState` (`.nominal | .fair | .serious | .critical`, iOS 11+)
  plus `ProcessInfo.thermalStateDidChangeNotification`; `isLowPowerModeEnabled` +
  `NSProcessInfoPowerStateDidChange` (iOS 9+).
* Android: `PowerManager.getCurrentThermalStatus()` (API 29+, returns
  `THERMAL_STATUS_NONE|LIGHT|MODERATE|SEVERE|CRITICAL|EMERGENCY|SHUTDOWN`) and
  `addThermalStatusListener(...)`; `isPowerSaveMode()`.

Two npm packages do wrap these — `react-native-device-pulse@0.1.0` (2026-08-12; its
`DevicePulseModule.kt` uses `powerManager.currentThermalStatus` + `addThermalStatusListener`, its
`DevicePulse.mm` uses `NSProcessInfo.thermalState` + the change notification) and
`react-native-nitro-thermal@0.1.1` (2026-07-24) — but both are 0.1.x, single-maintainer and
essentially unreviewed.

**Recommendation:** since we are already building a native module, add ~80 lines to it
(`Build.VERSION.SDK_INT >= 29` guard on Android, returning "unknown" below that), and take
low-power mode from `expo-battery`, which is already a dependency. A continuously-running
dash-mounted camera + two neural nets *will* hit thermal throttling; this signal should drive an
fps reduction, not be an afterthought.

Known device bug worth noting: on Xiaomi, `lowPowerMode` always reports false because the OEM uses
`POWER_SAVE_MODE_OPEN` rather than `PowerManager`
([react-native-device-info#1514](https://github.com/react-native-device-info/react-native-device-info/issues/1514)).

---

## 10. Recommendation

Stated as asked — **the least unverifiable native code that still reaches 20 fps**:

### Lead: one local Expo Module, seeded from `expo-mediapipe@0.4.1`

```
modules/dms-vision/
  expo-module.config.json          platforms: ["apple","android"]
  ios/DmsVision.podspec            s.dependency 'MediaPipeTasksVision', '0.10.35'
                                   s.dependency 'onnxruntime-objc', '1.30.0'   (pinned)
  ios/DmsVisionModule.swift        Function("start"/"stop"/"getIntrinsics"), Events("onGaze")
  ios/CameraSession.swift          AVCaptureSession, no preview layer, mirroring OFF, rotation 0
  ios/Pipeline.swift               2x FaceLandmarker (frame + flipped) -> mirror-average -> ORT
  android/build.gradle             'com.google.mediapipe:tasks-vision:0.10.35'  (pinned, not 0.10.+)
                                   'com.microsoft.onnxruntime:onnxruntime-android:1.30.0'
  android/.../DmsVisionModule.kt   same surface
  android/.../CameraSession.kt     CameraX ImageAnalysis, KEEP_ONLY_LATEST, no Preview use case
  android/src/main/assets/         face_landmarker.task, gaze_direct.onnx, mirror permutation
  src/index.js                     thin JS wrapper; onGaze -> { x, y, z, ts, quality }
```

**Why this and not VisionCamera:**

1. **Less unverifiable native code, not more.** Option B needs a frame-processor plugin on both
   platforms *anyway* (~700-1,000 LOC) and adds the worklets runtime, the Babel plugin and
   VisionCamera's own build surface on top. Option A is ~830 LOC net new on top of ~2,400 lines
   that can be read, diffed and audited before the first build.
2. **No RN-version treadmill.** VisionCamera v4 is EOL and New-Arch-by-interop; v5 needs RN 0.83+.
   The Expo Modules API is New-Arch-native and is what Expo itself upgrades for you.
3. **Preview-free is native, not a flag.** We own the session; there is no view to mount, hide or
   have RN drop from the hierarchy.
4. **The bridge disappears.** 3 floats per frame instead of 1,434 (§2.2).
5. **Intrinsics are reachable.** §7 needs `AVCaptureConnection` and `CameraCharacteristics` access
   that no JS library exposes correctly on both platforms today (VisionCamera v4's Android
   `fieldOfView` is actively wrong for our purpose; v5's intrinsic matrix is iOS-only and out of
   reach on RN 0.79).
6. **It removes every `onnxruntime-react-native` caveat at once** — the bridgeless-interop question,
   the iOS `-dealloc` teardown segfault, the Expo Android autolinking risk and the iOS bundled-asset
   load bug (§8.1, items 2-5) all exist only because inference is being driven from JS.

**Gaze runtime inside the module: ONNX Runtime first, TFLite as a measured size optimisation.** ORT
runs the `.onnx` as-is with no conversion step and has no symbol overlap with MediaPipe. TFLite is
~25 MB smaller and measured slightly faster with exact parity (§8.2, §8.3), but pairs a second static
copy of TFLite against the one inside `MediaPipeTasksVision` — an unverified link-time question.
Try the TFLite podspec line in build 1; if it links, take the 25 MB.

**Fallback: `react-native-vision-camera@4.7.3` + `react-native-worklets-core@1.6.3` + a custom
frame-processor plugin**, borrowing the Android half from `expo-vision-camera-v4-mediapipe@1.4.0`
(MIT) and the iOS half from `react-native-mediapipe` (MIT). Use `preview={false}`,
`format.fieldOfView` on iOS only, and compute Android intrinsics from `CameraCharacteristics`
through a small native call. Accept that it is an EOL branch and that the Expo 55 upgrade will
force a rewrite.

**Second fallback, only if all native work is blocked:** depend on `react-native-mediapipe@0.6.0`
directly, accept the 478-object legacy-bridge event and a lower fps ceiling, and run the gaze net
with `onnxruntime-react-native@1.24.3` from JS (`executionProviders: ['xnnpack','cpu']`,
`freeDimensionOverrides` pinning batch to 1, pre-allocated `fetches` tensors, double-buffered input,
plus the `patch-package` and asset-copy workarounds in §8.1). This is the fastest path to *something
running* and the worst path to something shippable.

### Build/verification plan given no local toolchain

Everything here is unverifiable until an EAS build runs, so sequence the builds to fail fast:

1. **Build 1 — plumbing only.** Empty local module that links `MediaPipeTasksVision` and
   `tasks-vision`, exposes `getVersion()`, and does nothing else. Proves the podspec, the Gradle
   dep, autolinking and prebuild on EAS. Add `expo-build-properties` here if the NDK/compileSdk
   needs raising.
2. **Build 2 — camera + one FaceLandmarker**, emitting only `{ nLandmarks, inferenceMs, width,
   height, isMirrored, rotationDegrees, fx, fy, cx, cy }` per second. This is the **orientation and
   mirroring validation harness** — §7 says a silent left/right flip is the most likely failure, so
   point the camera at a deliberately asymmetric target and check which side it lands on, on both
   platforms, before trusting any gaze number.
3. **Build 3 — mirror pair + gaze net**, with a bundled fixture: run the 8 cases from
   `gaze_direct.parity.npz` through the on-device session at startup and log the max abs error.
   That turns "does ORT/TFLite on this phone match the research pipeline" from a hope into a boolean.
4. **Build 4 — throttling, thermal hook, fps telemetry.**

---

## 11. Honest uncertainty

* **Everything native is unverifiable from here.** No Xcode, no Android SDK, no device. Every LOC
  estimate and every "this compiles" is an inference from reading source, not from building it.
* **The fps figures are estimates.** The gaze-net numbers are measured, but on x86; the MediaPipe
  figures are extrapolated from the research desktop and from typical mobile attention-mesh
  latencies. Google publishes no CPU/GPU latency table for the Face Landmarker task. Treat 20 fps as
  a target to be measured in build 4, not a prediction.
* **`videoFieldOfView`: full sensor or cropped output?** Apple does not say. Settle it on device
  against the intrinsic matrix.
* **Is the `CMSampleBuffer` intrinsic attachment rotated when `videoRotationAngle != 0`?**
  Undocumented. Keep rotation at 0.
* **Does AVFoundation auto-mirror a *video data output* connection on the front camera?** Community
  consensus says no; Apple does not say. Set `isVideoMirrored = false` explicitly and assert.
* **"Local modules build on EAS"** is inferred from autolinking's `./modules` default plus EAS's
  prebuild step, not from a doc sentence naming EAS.
* **Whether `MediaPipeTasksVision` and `TensorFlowLiteC` can be linked into the same iOS binary**
  (both static frameworks containing TFLite) is unverified, and it is what decides whether the
  25 MB-smaller TFLite runtime is available. One podspec line in EAS build 1 settles it.
* **`onnxruntime-react-native` autolinking on SDK 53 specifically** is inferred from reading
  `expo-modules-autolinking@2.1.14`'s source (which shows no Expo-module exclusion), against field
  reports on SDK 54/56 that say the opposite. No report exists for SDK 53 + ORT 1.24.3 either way.
* **No published per-inference benchmark exists for ORT-RN's 1.24.x JSI path.** The zero-copy claims
  are from reading `TensorUtils.cpp` / `InferenceSessionHostObject.cpp`, and the per-`run()`
  `std::thread` spawn is from reading `AsyncWorker.h` — neither was measured.
* **`react-native-fast-tflite@3.0.1` + `react-native-nitro-modules@0.37.1` on RN 0.79 / AGP 8.8** is
  untested by anyone; the AGP 9.x declarations and the RN 0.85 example app are circumstantial, not
  proof of breakage.
* **Expo SDK 53's default NDK version** was not verified against Nitro's `ndkVersion >= 27`
  requirement. Only matters if a Nitro library is adopted.
* **The web-search budget for this session was exhausted** partway through; later findings come from
  direct fetches of primary sources (AOSP, androidx, Apple DocC, published npm tarballs, CocoaPods
  trunk, Maven Central), which is stronger evidence but narrower coverage. A few secondary claims —
  notably VisionCamera v5's exact minimum RN version — remain unconfirmed and are flagged as such.

---

## Sources

Expo: [SDK 53 changelog](https://expo.dev/changelog/sdk-53) ·
[New Architecture by default](https://expo.dev/blog/out-with-the-old-in-with-the-new-architecture) ·
[New Architecture guide](https://docs.expo.dev/guides/new-architecture/) ·
[SDK 54 changelog](https://expo.dev/changelog/sdk-54) ·
[expo-camera SDK 53](https://docs.expo.dev/versions/v53.0.0/sdk/camera/) ·
[Modules get started](https://docs.expo.dev/modules/get-started/) ·
[Autolinking](https://docs.expo.dev/modules/autolinking/) ·
[Module config](https://docs.expo.dev/modules/module-config/) ·
[Third-party library](https://docs.expo.dev/modules/third-party-library/) ·
[Module API](https://docs.expo.dev/modules/module-api/) ·
[Shared objects](https://docs.expo.dev/modules/shared-objects/) ·
[expo-asset](https://docs.expo.dev/versions/v53.0.0/sdk/asset/) ·
[expo/expo#29566](https://github.com/expo/expo/issues/29566) ·
[expo/expo#32945](https://github.com/expo/expo/pull/32945)

VisionCamera / Nitro: [v5 blog](https://margelo.com/blog/whats-new-in-visioncamera-v5) ·
[VisionCamera vs Expo Camera](https://visioncamera.margelo.com/docs/visioncamera-vs-expo-camera) ·
[Camera Session](https://visioncamera.margelo.com/docs/camera-session) ·
[#3286](https://github.com/mrousavy/react-native-vision-camera/issues/3286) ·
[#3093](https://github.com/mrousavy/react-native-vision-camera/issues/3093) ·
[#3504](https://github.com/mrousavy/react-native-vision-camera/issues/3504) ·
[#3639](https://github.com/mrousavy/react-native-vision-camera/issues/3639) ·
[#3424](https://github.com/mrousavy/react-native-vision-camera/issues/3424) ·
[#2507](https://github.com/mrousavy/react-native-vision-camera/issues/2507) ·
[Nitro view components](https://nitro.margelo.com/docs/guides/view-components) ·
[Nitro minimum requirements](https://nitro.margelo.com/docs/getting-started/minimum-requirements)

MediaPipe: [Face Landmarker task](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker) ·
[Android guide](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/android) ·
CocoaPods trunk `MediaPipeTasksVision` (0.10.35 / 1.0.0) ·
Google Maven `com.google.mediapipe:tasks-vision` + `tasks-core`

ONNX Runtime / TFLite: [ORT mobile packages](https://onnxruntime.ai/docs/tutorials/mobile/) ·
[microsoft/onnxruntime#16669](https://github.com/microsoft/onnxruntime/pull/16669) ·
[#29197](https://github.com/microsoft/onnxruntime/issues/29197) ·
[#29678](https://github.com/microsoft/onnxruntime/issues/29678) ·
[#26796](https://github.com/microsoft/onnxruntime/issues/26796) ·
[#19510](https://github.com/microsoft/onnxruntime/issues/19510) ·
[#29004](https://github.com/microsoft/onnxruntime/issues/29004) ·
[#29005](https://github.com/microsoft/onnxruntime/pull/29005) ·
[#26738](https://github.com/microsoft/onnxruntime/issues/26738) ·
[#16031](https://github.com/microsoft/onnxruntime/issues/16031) ·
[margelo/react-native-fast-tflite](https://github.com/margelo/react-native-fast-tflite) ·
[onnx2tf](https://github.com/PINTO0309/onnx2tf) ·
[ExecuTorch getting started (RNE)](https://docs.swmansion.com/react-native-executorch/docs/fundamentals/getting-started) ·
RN v0.79.5 `BridgelessCatalystInstance.kt` / `RCTBridgeProxy.mm` ·
`expo-modules-autolinking@2.1.14` tarball (`reactNativeConfig/`, `androidResolver.ts`) ·
Maven Central `onnxruntime-android` 1.30.0 AAR (50.6 MB) ·
Google Maven `litert` 1.4.0 AAR (7.9 MB), `tasks-core` 0.10.35 AAR (20.4 MB)

Packages inspected via the npm registry / unpkg tarballs:
`react-native-vision-camera` 4.7.3 & 5.2.3 ·
`react-native-worklets-core` 1.6.3 · `react-native-worklets` 0.10.0/0.12.2 ·
`react-native-nitro-modules` 0.25.x-0.37.1 ·
`onnxruntime-react-native` 1.24.3 · `react-native-fast-tflite` 1.6.1 & 3.0.1 ·
`react-native-executorch` 0.5.0/0.6.0/0.10.2 ·
`react-native-mediapipe` 0.6.0 ([repo](https://github.com/cdiddy77/react-native-mediapipe),
[#154](https://github.com/cdiddy77/react-native-mediapipe/issues/154)) ·
`expo-mediapipe` 0.4.1 · `expo-vision-camera-v4-mediapipe` 1.4.0 ·
`@thinksys/react-native-mediapipe` 0.0.21 ·
`react-native-vision-camera-face-detector` 2.1.0 ·
`react-native-device-pulse` 0.1.0

Platform docs: Apple DocC (`videoFieldOfView`, `isCameraIntrinsicMatrixDelivery*`,
`kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix`, `AVCameraCalibrationData`, `isVideoMirrored`,
`videoRotationAngle`, `ProcessInfo.thermalState`), Apple TN2409 / QA1744,
[Apple forums 82668](https://developer.apple.com/forums/thread/82668) ·
AOSP `CameraCharacteristics` javadoc, [Camera cropping](https://source.android.com/docs/core/camera/camera3_crop_reprocess),
[camera2 preview orientation](https://developer.android.com/media/camera/camera2/camera-preview),
androidx `ImageAnalysis` / `ImageInfo` / `Camera2CameraInfo` source ·
[react-native-device-info#1514](https://github.com/react-native-device-info/react-native-device-info/issues/1514)

Local artifacts from this investigation:
`deployment-stack/models/gaze_direct.{onnx,meta.json,parity.npz}`,
`deployment-stack/dms/{gaze_inputs.py,mesh_roi.py}`, research log §46.
