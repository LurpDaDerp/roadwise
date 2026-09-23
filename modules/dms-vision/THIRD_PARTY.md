# Third-party notices — `modules/dms-vision`

## Prior art read while writing this module

**`expo-mediapipe@0.4.1`** (MIT, © the expo-mediapipe contributors) was read as the reference for
an Expo Module that wraps MediaPipe Tasks: the `FaceLandmarker` LIVE_STREAM task runner on both
platforms, the CameraX `ImageAnalysis` setup with `STRATEGY_KEEP_ONLY_LATEST`, the flat landmark
serialisation, and the general module layout. No file was copied verbatim; every source file here
was written against the vendor headers. The package's own `repository.url`
(`github.com/AyushJadaun/expo-mediapipe`) 404s, so the licence text is reproduced below from the
published tarball's `LICENSE`.

Specific things this module does **differently** from that package, and why:

| `expo-mediapipe@0.4.1` | here |
|---|---|
| `frameTimestamp += 1` frame counter | the real camera clock (`CMSampleBufferGetPresentationTimeStamp`, `ImageInfo.getTimestamp`) |
| no throttle: every frame goes to MediaPipe | `targetFps` / `setIdleMode` cadence gate plus a one-in-flight rule |
| `imageProxy.toBitmap()` **and** `Bitmap.rotated(degrees)` per frame | one `toBitmap()`, no pixel rotation; rotation travels as `ImageProcessingOptions.rotationDegrees` and the landmarks are rotated instead |
| iOS `connection.videoOrientation = .portrait` (deprecated, rotates every buffer) | connection rotation left at 0, `MPImage.orientation` metadata |
| `asset://` model paths that the config plugin never registers in the `.pbxproj` | a podspec `resource_bundles` entry and `android/src/main/assets`, resolved natively |
| `com.google.mediapipe:tasks-vision:0.10.+`, `MediaPipeTasksVision ~> 0.10` | exact pins (see README) |
| camera lives on an `ExpoView`, so a view must be mounted | the camera lives on the module object; no preview, no view |
| no camera intrinsics, no `isMirrored`, no orientation exposed to JS | all three are part of the per-frame record |

**`expo-camera@16.1.11`** (MIT, © 650 Industries) was read as the reference for running an
`AVCaptureSession` / CameraX session inside an Expo module (session queue discipline, permission
plumbing, the CameraX version line Expo SDK 53 ships). No code copied.

**`react-native-vision-camera@4.7.3`** (MIT, © Marc Rousavy) was read only to settle the iOS
sensor-orientation question (`ios/Core/Extensions/AVCaptureDevice+sensorOrientation.swift`). No
code copied.

## Linked dependencies

| Package | Licence | In which builds |
|---|---|---|
| `MediaPipeTasksVision` / `com.google.mediapipe:tasks-vision` 0.10.35 | Apache-2.0 | every build |
| `androidx.camera:camera-core`, `-camera2`, `-lifecycle`, `-view` 1.4.2 | Apache-2.0 | every Android build |
| `ExpoModulesCore` | MIT | every build |
| `onnxruntime-objc` / `com.microsoft.onnxruntime:onnxruntime-android` 1.30.0 | MIT | **only** builds made with `DMS_GAZE_NET=1` (see below) |

## Bundled models

### `face_landmarker.task`: every build

Google's MediaPipe Face Landmarker asset, Apache-2.0, sha256
`64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`.

### `gaze_direct.onnx` + `gaze_direct.meta.json`: provenance and the release gate

**Status: not cleared for distribution. It must not be in any production binary.**

| | |
|---|---|
| What it is | The project's own gaze network (V1 research pipeline), `twostream` architecture, 867,069 parameters. Inputs: a 478-point weak-3D landmark cloud, a 7-value camera/subject context and a validity mask. Output: a gaze direction and a head rotation |
| Checkpoint | `checkpoints/gaze_direct_promoted.pt`, sha256 `b0d3622a51d30a76369b7ab95b281a255f2329db9d1a9747fbabe8b781eacd74` (from the meta file) |
| ONNX graph | sha256 `4aa9661091efbdc28b20927f905c78097b9a7b5b787401f74ce6259f8f7666c8`; meta sha256 `007335e0dc34e4e9b1aeb5c4c34b65f1c1c811365d6768d3d814b70e47d35ca6` |
| Trained by | the project owner (the RoadCash/RoadWise research pipeline) |
| **Training data and its licences** | **UNKNOWN. To be supplied by the model's owner.** The meta file records normalisation statistics only. The public gaze datasets such a network is usually trained on (MPIIGaze/MPIIFaceGaze, GazeCapture, ETH-XGaze, Gaze360) are licensed for research or non-commercial use only |
| Licence of the model | undetermined until the training data's terms are known |

**The release gate** (DMS plan, Global Constraints; decision U-2):
- The model files live only in `ios/GazeNetResources/` and `android/src/gazenet/assets/`.
- Those folders, ONNX Runtime and the Swift/Kotlin that use them are compiled only when the build environment has `DMS_GAZE_NET=1`. Only the `development` EAS profile sets it; the internal device-pass builds use it.
- The podspec and `build.gradle` **refuse** the switch for a production build.
- `__tests__/release-gate.test.ts` and `__tests__/models.test.ts` pin all of this.
- Every build uses the licence-clean **geometric gaze** (head pose + iris offset, computed by the DMS engine) by default.
- Lifting the gate needs three things: counsel's written clearance of the training data's terms, recorded in the DMS ledger; a controller ruling; and the user's decision.

## Golden vectors

`assets/vectors/*.json` are synthetic. Every face is drawn from parameters by `scripts/synth.ts`
with a seeded generator, and no vector contains a person's face or landmarks. `stats-tracker.json`
reuses the inputs of the V1 Python reference's own synthetic fixture (seeded normal noise).
`__tests__/fixtures/v1-reference/` holds two V1 fixtures verbatim: synthetic faces from the
reference's `make_face` generator. They are test oracles only. The V1 `onnx_parity.json` is **not**
included: its source file's provenance is unknown. The ONNX parity vector is regenerated from
synthetic inputs by `scripts/make-onnx-vectors.py` with Python onnxruntime 1.30.0. That is a tool
run in a throwaway environment, never a repo dependency.

## MIT licence text (applies to the prior art named above)

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
