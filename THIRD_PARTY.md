# Third-party notices — RoadWise

## `modules/dms-vision`

### Prior art read while writing this module

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

| Package | Licence |
|---|---|
| `MediaPipeTasksVision` / `com.google.mediapipe:tasks-vision` 0.10.35 | Apache-2.0 |
| `onnxruntime-objc` / `com.microsoft.onnxruntime:onnxruntime-android` 1.30.0 | MIT |
| `androidx.camera:*` 1.4.2 | Apache-2.0 |
| `com.google.android.gms:play-services-location` 21.3.0 (linked by `modules/drive-sense`) | Android Software Development Kit License (Google Play Services terms) |
| `ExpoModulesCore` | MIT |

The bundled model files (`face_landmarker.task`) are Google's MediaPipe Face Landmarker assets
(Apache-2.0). `gaze_direct.onnx` and `gaze_direct.meta.json` are the project's own trained gaze
network.

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

## Map data

Speed-limit data comes from two open sources, loaded by `supabase/data` (see its README):

- **OpenStreetMap.** Map data © OpenStreetMap contributors, available under the Open Database
  License 1.0 (https://opendatacommons.org/licenses/odbl/1-0/; https://www.openstreetmap.org/copyright).
  Extracts from Geofabrik (https://download.geofabrik.de/). The app shows the attribution
  "© OpenStreetMap contributors"; the `osm.ways` table and the tiles served from it are a derivative
  database subject to the ODbL's attribution and share-alike terms.
- **HPMS.** Highway Performance Monitoring System (HPMS) 2024, Federal Highway Administration (FHWA),
  distributed by the Bureau of Transportation Statistics (BTS) in the National Transportation Atlas
  Database (https://geodata.bts.gov/datasets/5e6a977c2d7c4ec1bdc82e684d3384f2). A work of the U.S.
  Government (17 U.S.C. § 105), not protected by copyright and available for unrestricted public use;
  acknowledgement requested: "Federal Highway Administration (FHWA) and Bureau of Transportation
  Statistics (BTS)".
