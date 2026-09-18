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

---

## 3. The drive screen's render budget

The drive screen is mounted for the whole drive with the screen forced awake, so a render there
is not free: it is the JS thread the rule engine shares.

**Before.** Five independent sources re-rendered the entire screen: a 1 Hz elapsed-seconds
`setState` in `useDriveSession`, a GPS fix (~1 Hz) writing speed, distance and the speeding flag,
a derived `monitorSpeedKmh` state, the points timer every ~2.5 s, and the monitoring hook's 4 Hz
publish. There was **no `React.memo` and no `StyleSheet.create` anywhere in the app**, so each of
those re-rendered ~12 components and re-allocated their whole style graph — including
`EmergencySheet`, whose `<Modal visible={false}>` subtree (three `BigAction` rows) rebuilt on
every tick, and `AutoFitText` at `fontSize: 120`, which triggers a native text re-measure.

**After.**

| change | effect |
|---|---|
| the elapsed clock owns its own 1 Hz timer inside `DriveTopBar` (`session.elapsed` → `session.startedAt`) | the per-second tick re-renders one `<Text>` instead of the tree |
| `React.memo` on every `components/drive/*`, `MonitoringStatusPill`, `AlertBanner` | a tick that changes one value re-renders only what reads it |
| every prop into them is a stable identity (`useCallback` handlers, memoised banners / overlay alert / root style, `StyleSheet.create` for the static styles) | the memos actually hold |
| `{sosOpen && <EmergencySheet …/>}` | the sheet costs nothing while closed |
| `useMemo` for the speed colour (6 hex parses), the points state map and `toLocaleString` | per-tick arithmetic gone |
| `ThemeContext`'s value memoised; `useEmergency` and `useDriveSession` return memoised objects | a fresh identity in any of these would have defeated every memo below it |
| the `distance` state deleted (it existed only for a value nothing read) | one fewer whole-screen render per GPS fix |

Elsewhere: the history, leaderboard, family and badge rows are memoised with stable handlers
(`DriveRow` also memoises its drive score, colour mix, regex and two locale date formatters,
which ran for every mounted row on every parent render); `InsightsPanel` memoises the chart data
and config — the props that decide whether the SVG chart re-renders — and reads the window width
through `useWindowDimensions`; `useCountUp` publishes only when the displayed integer changes
(it was a ~60 Hz `setState` on the whole host screen for the duration of every count-up).

## 4. Location, timers and network

| change | why |
|---|---|
| the Family tab's 2 s GPS watch is gated on **focus and group membership**, and relaxed to 5 s / 10 m | bottom tabs never unmount, so after one visit this ran for the rest of the session — including the whole of every drive, alongside the drive screen's own watch. Its consumers are a map dot animated over 1 s and a reverse geocode throttled to 10 s / 10 m. While the tab is away the group still sees the member through the background task (20 s / 25 m) |
| `showsUserLocation` on the map follows focus | a second, independent OS location consumer inside the map SDK. Toggling the prop does not remount the map |
| the group document subscription is gated on focus | every member's background write delivered a snapshot that rebuilt the member list and could start a reverse geocode: N × 3 network wake-ups a minute for a screen nobody was looking at. The last snapshot is kept, so returning is instant and costs one read |
| the drive's GPS watch is stopped while the app is backgrounded | the fixes were already discarded on arrival; on Android the high-accuracy request stayed registered for up to the two-minute auto-end window |
| `distanceInterval` 10 → 0 on the drive watch | its consumers are a 1 Hz speedometer, the 2.5 s points tick and the acceleration estimate, which needs evenly spaced samples — the 10 m filter starved it at crawling speed and silently zeroed hard-brake detection. The speed-limit lookup owns its own 15 s / 250 m throttle, so this costs no extra network |
| weather: a ~1 km cell cache, 15 min, persisted, with in-flight collapsing | two endpoints were hit on the first fix of EVERY drive with no cache at all; stop and restart a drive three times and it was six requests plus up to three OpenAI summaries |
| the push token is compared against the last one written for this account | a launch and every drive-prep cost an Expo HTTP round trip plus a Firestore write and a read, for a value that changes about once a year. The legacy public-field cleanup is now once per app run |
| `getDriveCounts`, `fetchLeaderboard` and the Rewards badge history get the 5-minute TTL the Insights panel already had | three count queries per Drives AND Rewards focus, 50 user documents plus a count per Leaderboard focus, 200 drive documents per Rewards focus — all invalidated when a drive is finalized |
| the speed-limit client TTL 60 days → 7 | it now matches the server's, so a changed limit cannot be served from the phone for weeks after the server forgot it |

**Timers audited and left alone:** the monitoring hook's 4 Hz tick, 10 s thermal poll and 60 s
battery poll are all gated on `running`, so mounting the hook on DrivePrep starts nothing; the
points chain reschedules itself but the work is a comparison; `expo-keep-awake` is held only by
the drive screen, which unmounts on navigation.

## 5. Startup and bundle

Measured with `npx expo export` (ios) before and after:

| ios | before | after | |
|---|---|---|---|
| Hermes bundle | 7,829,221 B | 7,676,734 B | −1.9 % |
| assets | 4,405,471 B | 2,263,500 B | **−48.6 %** |
| export total | 12,238,037 B | 9,942,747 B | **−18.8 %** |

| android | before | after | |
|---|---|---|---|
| Hermes bundle | 7,853,198 B | 7,698,998 B | −2.0 % |
| assets | — | 2,262,006 B | |
| export total | 12,260,464 B | 9,963,461 B | **−18.7 %** |

The EAS upload is 14.5 MB, down from ~32 MB before the orphan assets, the model reference
copies and the removed dependencies.

* **Icon fonts, 19 → 2.** `import { Ionicons } from '@expo/vector-icons'` pulls the package
  barrel, which references every font family as an asset, so all 19 TTFs (3.9 MB) shipped when
  only Ionicons and MaterialCommunityIcons are used. All 36 files now import the family directly.
* **22 dependencies removed** (66 → 44) after a parser-based check that nothing imports them.
  `scripts/check-imports.js --unused` is now green and keeps it that way.
* **Dead code**: four files with no importers and 23 unused exports; helpers used only inside
  their own module are no longer exported rather than deleted.
* **Orphan assets**: 13 images, `assets/streaks/*` and a 7.7 MB design-source zip and folder,
  each verified at zero `require()`s and zero string references (~11 MB out of the repo).
* **`assets/models/`** is excluded from the EAS upload (7.4 MB): the native module ships its own
  copies of the model bundle and nothing in the JS bundle requires these.

## 6. Correctness fixes found on the way

These are not optimisations, but they were on the paths being optimised and are listed with the
rest of the work in the commit history.

* **The GPS path of every drive was dead from the second fix on.** `hooks/useDriveSession.js`
  declared `const distanceMeters = distance`, shadowing the imported `distanceMeters` across the
  whole hook, so the second fix threw inside the un-awaited `handleLocation` — speed stayed 0, no
  points, no speed-limit lookups, the drive never "started", no record was written, and the
  monitoring speed gate saw 0 for ever. `scripts/check-imports.js` finds this class of bug and
  `hooks/__tests__/importShadowing.test.js` keeps it in the standing suite.
* **Ending a drive offline hung for ever**: `batch.commit()` resolves only on a server
  acknowledgement. It has an 8 s deadline now, a timeout is queued like any other failure, and
  the retry path is one `runTransaction` (a `getDoc` would answer from a local cache that already
  has the pending write applied, and would drop the queued drive).
* **`expo-location` was a bare plugin string**, so the Android manifest had no
  ACCESS_BACKGROUND_LOCATION / FOREGROUND_SERVICE / FOREGROUND_SERVICE_LOCATION.
* **A failed group read reported a cleared SOS as successful**, and told a user mid-emergency
  they were "not in a group".
* **The four alert WAVs were never bundled** (nothing `require()`d them), so the per-type sounds
  could not have played even once the code asked for them.
* **A stray key in `memberLocations.{uid}` locked that member out permanently** (the rules check
  `hasOnly` on the resulting map; a dotted update can never remove a key).
* **Groups had no size cap** — a 1 MB document and unbounded emergency push fan-out were both
  reachable.

## 7. Considered and deliberately NOT changed

* **MediaPipe GPU delegate / CoreML / NNAPI** — §2.3. Landmark numerics or ≤ 1e-4 gaze parity
  would change, and nothing here can validate that without a device.
* **`pausesUpdatesAutomatically` on the background location task.** It is `false`, which keeps
  the session alive while parked. Turning it on is the obvious battery win, but iOS does **not**
  reliably resume on its own: `locationManagerDidPauseLocationUpdates` hands the responsibility
  back to the app, and family location sharing would silently stop instead. It needs a device and
  a restart path; it is the single biggest remaining battery item and belongs in the next round.
* **Lowering the background task's accuracy to `Balanced`.** The write gate is 25 m and
  `Balanced` is ~100 m on iOS, so the family map pin would visibly wander. Not worth it.
* **Re-encoding the remaining bundled JPEGs.** They are already efficiently compressed at their
  pixel dimensions (re-encoding produced LARGER files), and the reward tiles are full-width
  `cover` images whose source is only just large enough at 3x — downscaling would soften them.
  Only `drivebutton.jpeg` re-encoded smaller (−28 %) at identical dimensions.
* **`Dimensions.get('window')` at module scope** in four other screens. The app is
  portrait-locked, so only an Android split-screen resize is affected; the one that mattered (the
  Insights chart) is fixed.
* **Converting the history and leaderboard lists to `FlatList`.** The rows are memoised with
  stable handlers now, which is most of the win; the conversion also changes scroll and layout
  behaviour, which cannot be checked without a device.
* **`react-native-paper`.** Only `PaperProvider` and one `Snackbar` use it, but replacing the
  Snackbar is a visible UI change, not an optimisation.
* **App Check on the callables.** Enabling `enforceAppCheck` rejects every call until the console
  and the native projects are configured. The steps are written up in `docs/BACKEND_AUDIT.md`
  instead.

## 7a. Verification

| check | result |
|---|---|
| `node --test "dms/tests/*.test.js"` | 141 / 141 |
| `node --test "monitoring/__tests__/*.test.js" "hooks/__tests__/*.test.js"` | 77 / 77 (75 before, + the import-shadowing guard and the grid-cell agreement test) |
| `node modules/dms-vision/scripts/check-bundle.js` | all model copies identical |
| `node scripts/check-imports.js --unused` | OK (no shadowed imports, no unresolved imports, no undeclared or unused packages) |
| `npm ci --dry-run` | clean |
| `npx expo export` ios + android | both succeed; sizes above |
| `npx expo-doctor` | 15 / 18 — the three failures are pre-existing and untouched by this branch: a transitive `@expo/metro-config` patch version, React Native Directory metadata for `react-native-chart-kit` / `react-native-confetti-cannon` / `firebase` / `lodash.debounce`, and Expo SDK patch drift (`expo@53.0.23` vs `~53.0.27` etc.). Upgrading the SDK is out of scope for an optimisation branch |
| `cd functions && npm run lint` | clean |
| `cd functions && npm run test:rules` | 69 / 69 (68 before, + the 25-member cap) |
| `npx expo prebuild --platform android --no-install` | the manifest contains ACCESS_BACKGROUND_LOCATION, FOREGROUND_SERVICE and FOREGROUND_SERVICE_LOCATION (the `expo-location` plugin fix); `android/` deleted afterwards |
| EAS development build, iOS | `05748bab-ab44-4d2d-9e96-26d9c5ff84d9` — **finished**, so the Swift capture-cadence and ONNX session-option changes compile and link |
| EAS development build, Android | `60c7aa4c-7dbc-40a0-a636-9ffb0e192361` |

## 8. What the owner has to do

1. **Run the two EAS development builds** (recorded below) on real phones and watch a drive:
   §2.1 changes the capture rate and §2.2 the ONNX thread policy, and neither can be measured
   here. Check `metrics.engine.fpsMean` — it should now sit at the target (20) rather than the
   15 the old throttle actually delivered.
2. **Decide on the background-location pause** (§7). It is the largest remaining battery item.
3. **App Check** — `docs/BACKEND_AUDIT.md`, "App Check follow-up".
4. **Re-tune the glance thresholds if the fps change moves them.** No threshold was touched, but
   the engine now sees 20 frames a second where it saw 15; every rule is time-based, so this
   should be neutral by construction — worth confirming on the first real drive.
