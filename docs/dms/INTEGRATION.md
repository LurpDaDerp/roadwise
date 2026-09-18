# Driver monitoring — integration contract

How the camera + gaze-model + rule-engine branch plugs into the reworked app.  Companion to
`DETECTION_DESIGN.md` (D — what is detected and when), `WARNINGS_DESIGN.md` (W — what the driver
sees and hears), `NATIVE_LAYER.md` (the Expo module) and `RESEARCH.md` (the sourced thresholds).

The UX branch (`docs/UX_REWORK.md` §5) already defines every monitoring surface and ships a **mock**
`useDriverMonitoring`.  This branch replaces the body of that hook and adds one pure translation
layer between the rule engine and the app's contract.  **No screen or component changes**, except a
single new prop on the DriveScreen hook call (§5).

---

## 1. File map

### Added by this branch

| Path | Kind | Role |
|---|---|---|
| `monitoring/engineBridge.js` | pure CommonJS | `MonitoringBridge`: engine events / outputs → `status`, `calibration`, `activeAlert`, `drowsiness`, `metrics`.  All of the translation, none of React. |
| `monitoring/__tests__/engineBridge.test.js` | `node --test` | 29 tests, incl. two full synthetic drives through the real engine |
| `hooks/monitor/speedGate.js` | pure CommonJS | GPS speed → the engine's `setVehicleSpeed` (2 s EMA, 10 s staleness, 10/5 km/h hysteresis — D §8) |
| `hooks/monitor/cadencePolicy.js` | pure CommonJS | 20 / 10 / 5 fps and the thermal pause, as a state machine (D §3) |
| `hooks/monitor/referenceStore.js` | pure CommonJS | the persisted forward reference in AsyncStorage (D §5.2) |
| `hooks/__tests__/*.test.js` | `node --test` | 34 tests for the three modules above |
| `dms/**` | pure CommonJS | the ported rule engine (already on this branch; see `dms/README.md`) |
| `modules/dms-vision/**` | Expo module | camera + MediaPipe + ONNX Runtime (see `NATIVE_LAYER.md`) |

### Replaced (same path as the UX branch, drop-in)

`monitoring/settings.js` is the UX file with ONE change: `MONITORING_AVAILABLE = true` (the UX
branch ships `false` while its hook is a mock; its own comment asks this branch to flip it).
The PERCLOS advisory reaches the app as the engine's own `PERCLOS_ADVISORY` event
(`dms/drowsiness.js`, at most once per 300 s), mapped to `ALERT_TYPE.PERCLOS` at INFO severity —
the bridge does not synthesise it.

| Path | What changes |
|---|---|
| `monitoring/useDriverMonitoring.js` | the mock body → the real hook.  Signature and returned shape unchanged; `demo: true` still runs the mock's scripted sequence, verbatim, with no camera. |
| `monitoring/types.js` | four added `ALERT_TYPE`s, the corrected `PROLONGED_STARE` copy, an optional `sound` per type.  Every existing name and value is unchanged — see §4. |

### Copied verbatim (so imports resolve and the tests run here)

`monitoring/settings.js`, `monitoring/summary.js`, `monitoring/alertAudio.js`, `monitoring/index.js`
— byte-identical to the UX branch as of the copy.  Do not edit them on this branch; take the UX
branch's version at merge time (they are still moving: `MONITORING_AVAILABLE` and the per-alert
`audio` modality both landed after the first copy).

**One line must change at merge**, and it belongs to the UX branch, not here:

```diff
-export const MONITORING_AVAILABLE = false;
+export const MONITORING_AVAILABLE = true;
```

Its own comment says so ("the camera-based monitoring branch flips this to true when it replaces the
hook").  Until it is flipped the settings toggles read "Coming soon", no camera permission is asked
for, the pill and calibration gate stay hidden and no monitoring data reaches a drive record — i.e.
this branch is inert, which is the right default while the native layer is unverified on a device.

---

## 2. Data flow, one frame

```
front camera (native, no preview)
  → MediaPipe FaceLandmarker, single pass, landmarks rotated into the UPRIGHT frame   [native]
  → onFrame { t, width, height, facePresent, score, isMirrored, focalScale,
              intrinsicsSource, orientation, landmarks: Float32Array(1434) }          [bridge]
  → monitor.prepareInputs(frame)        weak3d cloud + camera context + validity       [JS]
  → DmsVision.predictGaze(cloud, context, validity)   867 k params, batch 1           [native]
  → monitor.finishFrame(frame, inputs, prediction)                                     [JS]
        calibration → attention rules → drowsiness rules → alert arbiter
  → bridge.update(output)               episodes, metrics, calibration, drowsiness     [JS]
  → (4 Hz)  setState → DriveScreen → DriveTopBar / AlertSlot / CriticalOverlay
  → alertAudio.useAlertAudio(activeAlert)  the one audio policy                        [JS]
```

Rules to keep when this code is touched:

* **`frame.t` is the native camera timestamp in seconds.**  Never substitute `Date.now()`: every
  rule clock is time-based so the engine is correct at 30, 20, 10 and 5 fps and across dropped
  frames, and bridge jitter must not enter those clocks.
* **Never queue frames.**  If a landmark frame arrives while a prediction is in flight it is
  dropped; the monitor only ever sees the timestamps of the frames it actually processed.
* **Landmarks are passed through untouched** (`Float32Array(1434)`, MediaPipe normalized
  `(x/W, y/H, z/W)` in the upright image).
* **React state is published at most 4×/s**, and only when `bridge.version` changed.  Everything
  on the frame path lives in refs.
* The hook **does not play audio**.  The screen already renders `activeAlert` through
  `monitoring/alertAudio.js`; duplicating it there would double every cue.

---

## 3. The hook API

```js
const monitoring = useDriverMonitoring({
  enabled,       // settings.monitoringEnabled && the per-drive toggle
  driveActive,   // true between Start and End
  settings,      // monitoringSettingsFrom(settings)
  onAlert,       // (alert) => void, once per new alert
  demo,          // true = the scripted mock, no camera
  speedKmh,      // NEW: number (km/h) | null when the speed is unknown
});
// → { status, calibration, activeAlert, drowsiness, metrics,
//     recalibrate, acknowledgeAlert, previewComponent, settings }
```

`speedKmh` is the only new input.  `null` means "unknown", which is the reference behaviour: every
rule stays fully active.  A known speed below 10 km/h silences every distraction alert (D §8, W §2)
and slows the calibration's admission to a quarter weight, so a parked conversation cannot bootstrap
the forward reference.  Passing nothing keeps the engine in "unknown" for the whole drive — correct,
but it gives up the stationary false-alarm suppression.

Behaviour notes:

* **`previewComponent` is always `null`.**  The native module renders no preview (D §3: the camera
  runs without one, which is most of the battery saving).  `settings.showPreview` is accepted and
  ignored; `CameraPlacementGuide` falls back to its illustration.
* **`recalibrate()`** forgets the forward reference, drops the stored prior for this mount and shows
  `CALIBRATION_STATE.LOST` until the engine re-validates.
* **`acknowledgeAlert(id)`** ends that episode, suppresses its re-raise and calls the engine's
  `acknowledge()` (30 s per type, at most 3 per 120 s; the closed-eye family and NO_FACE can never be
  acknowledged — W §4).  The UX `CriticalOverlay` has no buttons, so this is only used by a banner.
* **`metrics.engine`** is an extra key (updated once a second) holding the D §10 diagnostics:
  monitored / face / calibrated seconds, fps, thermal pauses, calibration times, per-class glance
  counts, max PERCLOS, the intrinsics source, the parity result.  `buildMonitoringRecord` drops it
  unless the one-line extension of §7 is applied.  The six contract keys are untouched.
* **Missing native module** (Expo Go, a build without the module): `status` is `CAMERA_ERROR`,
  nothing throws, the drive screen behaves exactly as before.
* **`enabled: false`**: `status` is `OFF`, no camera, no permission prompt.

### What the hook owns

| Concern | Where | Design |
|---|---|---|
| camera permission | `requestPermissionsAsync()` on the module, else the `start()` rejection | W §6 |
| camera lifecycle | `start` / `stop`, AppState (`inactive`/`background` → camera off, rules keep their clocks) | D §3 |
| cadence | `setTargetFps(20/10/5)`, `setIdleMode` on no face > 5 s, pause at thermal `critical` with a 60 s retry | D §3 |
| GPS speed | `speedGate` → `monitor.setVehicleSpeed()` every 250 ms | D §8 |
| persisted reference | `@monitorReference:front:{orientation}`, seeded with `calibration.seedStale`, saved when CONFIRMED, dropped after 30 days or a model change | D §5.2 |
| parity self-test | `selfTest(dms/tests/fixtures/onnx_parity.json)` once per app run → `metrics.engine.parityOk` | `NATIVE_LAYER.md` |
| orientation check | the outer-eye line (landmarks 33 / 263) must be within ±35° of horizontal over the first 3 s of face frames | D §2 |

### What the bridge decides (`monitoring/engineBridge.js`)

* **Event → alert type**: the table in the file header; everything not in it (attention buffer, the
  silent closure pre-alarm, blinks, slow blinks, recovery, and every calibration / system event) is
  state and metrics only, never an alert.
* **Severity**: engine `CRITICAL` → `critical`; engine `WARNING` that the arbiter **voiced** →
  `warning`; everything else → `info`.  A WARNING/CRITICAL episode is created **only** from the
  arbiter's voiced event, so the reference's per-type cooldowns, its one-audible-at-a-time hold, the
  speed gate and acknowledgement suppression all apply before the app makes a sound.
* **Episodes**: keyed `${alertType}@${event.t_start}`.  The arbiter's 2-s escalations and 1.5-s
  critical repeats extend the same alert; `SLEEP` and `EYES_CLOSED` are one continuing
  `EYES_CLOSED`.  An episode is counted **once, at its highest severity** — an INFO that escalates to
  WARNING moves its count instead of adding one.
* **Termination**: glance types end after 1 s of continuous forward gaze or 3 s without a repeat;
  closure types 1 s after `openness ≥ 0.5` or 3 s without a repeat; drowsiness-family 8 s after their
  last event; `NO_FACE` when the face returns; `EYES_NOT_VISIBLE` when the eyes are readable;
  `NO_MIRROR_CHECK` after 6 s.  An INFO banner is held for at least 4 s so it can be read.
* **INFO never pre-empts** a live WARNING/CRITICAL — it does not even start an episode, so it is not
  counted either.
* **`eyesOffRoadSeconds`**: the part of each glance beyond its class allowance (cabin from 0 s,
  lateral beyond 2 s, driving task beyond 1 s) plus head-down frames.
* **`drowsiness.level`**: `ALERT` → 0, or 1 when the 60-s PERCLOS ≥ 0.08 (the DDWS advisory level) or
  the score ≥ 25; `DROWSY` → 2; `SEVERE` → 3.
* **`calibration`**: engine `NONE` → CALIBRATING, `PROVISIONAL` → PROVISIONAL, `CONFIRMED` →
  CONFIRMED, `STALE` → LOST, and LOST for 5 s after CAMERA_MOVED / DRIVER_CHANGE / RECALIBRATED;
  `progress` = admitted seconds / 60; `quality` = `clamp(concentration / 0.8)` × 0.7 while
  provisional.
* **`status`**: the session first (PERMISSION_DENIED / CAMERA_ERROR / STARTING), then NO_FACE after
  5 s without a face, then CALIBRATING while the reference is NONE, else ACTIVE.
* Also exposed, informational: `engineDetail()`, `pointsBlocked(t)` (a voiced attention alert within
  10 s, or level 3) and `streakBreaking()` (≥ 3 distraction episodes, or one PROLONGED_STARE /
  EYES_CLOSED).  The UX branch derives its own verdict in `monitoring/summary.js`; these exist so the
  two can be compared.

---

## 4. `monitoring/types.js` — the exact extension

Four alert types the engine can raise and the UX branch did not have, the corrected
`PROLONGED_STARE` copy, and an optional `sound` per type.  **Nothing existing was renamed or
re-valued.**

```diff
 export const ALERT_TYPE = Object.freeze({
   ...
   DROWSY: 'DROWSY',
+  SEVERE_DROWSY: 'SEVERE_DROWSY',
   PROLONGED_STARE: 'PROLONGED_STARE',
   NO_FACE: 'NO_FACE',
+  EYES_NOT_VISIBLE: 'EYES_NOT_VISIBLE',
+  FIXED_GAZE: 'FIXED_GAZE',
+  NO_MIRROR_CHECK: 'NO_MIRROR_CHECK',
 });
```

```diff
-  PROLONGED_STARE: { title: 'Prolonged stare', message: 'Check your mirrors', speech: 'Stay engaged. Check your mirrors.', icon: 'scan-outline' },
+  SEVERE_DROWSY: { title: 'Severe drowsiness', message: 'Pull over and rest', speech: 'You are very drowsy. Pull over when safe.', icon: 'bed-outline', sound: 'siren' },
+  PROLONGED_STARE: { title: 'Eyes off the road', message: 'Look back at the road now', speech: 'Look at the road now', icon: 'eye-off-outline', sound: 'double_high' },
+  EYES_NOT_VISIBLE: { title: 'Eyes not visible', message: 'Head-only monitoring', speech: null, icon: 'glasses-outline', sound: null },
+  FIXED_GAZE: { title: 'Fixed stare', message: 'Stay engaged — check your mirrors', speech: null, icon: 'scan-outline', sound: 'double_high' },
+  NO_MIRROR_CHECK: { title: 'No mirror check', message: 'Scan your mirrors', speech: null, icon: 'car-outline', sound: 'double_high' },
```

plus `sound: 'siren' | 'double_high' | 'double_low' | 'single_low'` appended to every pre-existing
entry (siren for EYES_CLOSED / MICROSLEEP, double_high for the distraction family, double_low for the
drowsiness family, single_low for NO_FACE) and to the `alertCopy()` fallback.

**Why `PROLONGED_STARE` was re-worded.**  In the reference engine it is not a cognitive stare: it is
a glance away from the road that persists 3 s past its limit without the driver returning (Euro NCAP
"unresponsive", W §4).  The old copy ("Check your mirrors") would tell a driver who is already
looking away to look somewhere else.  The cognitive-stare event does exist — it is
`GAZE_CONCENTRATION`, now mapped to the new `FIXED_GAZE` (INFO only).

`sound` is metadata for a future extension of `alertAudio.js`; nothing reads it today (the app plays
one tone and distinguishes alerts by the spoken phrase).  The four WAVs are already in
`assets/sounds/dms/`.

---

## 5. The one DriveScreen edit

`screens/DriveScreen.js` needs `speedKmh` on the `useDriverMonitoring` call.  The obvious one-liner
does **not** work as written, for two reasons:

1. `session` is declared **after** `monitoring` (the session takes `pausePoints: criticalActive`, so
   the dependency is circular — monitoring cannot read `session` during the same render).
2. `session.gpsStatus` is `'searching' | 'ok' | 'denied' | 'error'` — there is no `'granted'`
   (`hooks/useDriveSession.js:87`).

Recommended edit — two insertions, no change to the existing lines:

```diff
   // ---- monitoring (mock until the monitoring branch lands) ----------------
   const monitoringSettings = useMemo(() => monitoringSettingsFrom(settings), [settings]);
+  // The rule engine's speed gate (docs/dms/DETECTION_DESIGN.md §8): km/h, or null when the
+  // GPS speed is unknown.  Set from an effect below because `session` is defined after this
+  // call (it depends on `criticalActive`).
+  const [monitorSpeedKmh, setMonitorSpeedKmh] = useState(null);
   const monitoring = useDriverMonitoring({
     enabled: monitoringEnabled,
     driveActive: !ended,
     settings: monitoringSettings,
     demo: !!route.params?.demoMonitoring,
+    speedKmh: monitorSpeedKmh,
   });
```

and, anywhere after `const session = useDriveSession({ … });`:

```jsx
  // Feed the monitoring speed gate (docs/dms/DETECTION_DESIGN.md §8).
  useEffect(() => {
    const kmh =
      session.gpsStatus === 'ok'
        ? Number(session.speed) * (settings.speedUnit === 'kph' ? 1 : 1.60934)
        : null;
    setMonitorSpeedKmh((prev) => (prev === kmh ? prev : kmh));
  }, [session.speed, session.gpsStatus, settings.speedUnit]);
```

(`useState` / `useEffect` are already imported by the screen.)  A zero-extra-render alternative is a
`useRef` written in that same effect and passed as `speedKmh: speedKmhRef.current`; the hook reads
the value from a ref at 4 Hz, so being one render late is irrelevant.

Nothing else on the screen changes: `[MP-1]`…`[MP-5]` all keep working, because the real hook returns
the same shape as the mock.

### Surfaces that need no change

* **DrivePrep** — `CameraPlacementGuide preview={monitoring.previewComponent}` keeps working;
  `previewComponent` stays `null` and the guide shows its illustration.
* **`hooks/usePermissions.js`** — no change required: `expo-image-picker`'s camera permission is the
  same OS permission, so a grant there is a grant for the monitor.  Optional tightening: when
  `DmsVision.isAvailable()`, call `DmsVision.requestPermissionsAsync()` instead, so the prompt comes
  from the module that will open the camera.  The hook requests it itself at drive start either way.
* **Settings › Driver monitoring** — the existing toggles and the `monitoringSettingsFrom` shape are
  what the hook consumes; `sensitivity` `low | medium | high` maps to the engine profiles
  `relaxed | standard | strict` inside `dms/app_config.js`.

---

## 6. Settings and storage keys

The UX branch's keys are unchanged (`@monitoring.enabled`, `.voiceAlerts`, `.toneAlerts`,
`.hapticAlerts`, `.sensitivity`, `.driverSide`, `.showPreview`).  This branch adds exactly one
AsyncStorage key of its own:

| Key | Written | Read | Contents |
|---|---|---|---|
| `@monitorReference:front:{orientation}` | at drive end when the reference is CONFIRMED | at drive start | `{v, savedAt, facing, orientation, modelSha, focalScale, reference[3], headMode[2]}` — dropped after 30 days, on a model-bundle change, or on a mount/orientation mismatch |

Effect: a repeat drive on the same mount is calibrated in ~20 s instead of ~105 s.  A moved phone
costs nothing — the reference's own re-validation replaces it (D §5.2).

---

## 7. Optional one-line `monitoring/summary.js` extension

To carry the D §10 diagnostics into the drive record, add one line to `buildMonitoringRecord`:

```diff
     drowsinessHistory: (m.drowsinessHistory || []).slice(-120),
     calibrationQuality: typeof m.calibrationQuality === 'number' ? m.calibrationQuality : null,
     calibrationState: calibrationState || null,
+    engine: m.engine || null,
   };
```

`metrics.engine` is already plain, finite, Firestore-safe JSON (asserted by the test suite).  Without
this line the record keeps exactly the UX shape and the diagnostics are simply not stored.

---

## 8. `app.json` and `package.json`

```diff
       "NSCameraUsageDescription":
-        "This app needs access to your camera for features like scanning QR codes.",
+        "RoadCash uses the front camera during a drive to warn you when your eyes leave the
+         road or close. Video never leaves the phone and is never stored.",
       ...
     "android": {
       "permissions": [
         ... existing ...
+        "android.permission.CAMERA"
       ],
```

The Expo-module plugin for `modules/dms-vision` is added separately (see `NATIVE_LAYER.md`); it is
not in the diff above.  `package.json` needs **no new dependency** for this branch: `expo-battery`,
`expo-speech`, `expo-audio`, `expo-haptics` and AsyncStorage are already installed, and the native
layer is a local module.  (Note for the merge: this worktree's `app.json` currently lists the four
audio/location Android permissions twice — a pre-existing duplication, left untouched.)

---

## 9. Tests

```sh
cd /mnt/c/Users/lurpd/Documents/dev/RoadCash-dms
node --test "dms/tests/*.test.js"                                           # engine: 140 tests, 140 pass (~35 s)
node --test "monitoring/__tests__/*.test.js" "hooks/__tests__/*.test.js"    # integration: 63 tests, 63 pass (~2 s)
node modules/dms-vision/scripts/check-bundle.js                             # the three model copies are identical
```

Verified on this machine with Node 24.19 (WSL); the same commands run under Windows Node 22 from
`C:\Users\lurpd\Documents\dev\RoadCash-dms`.  `node --test dms/tests` (a bare directory argument)
fails immediately under Node 24 ("test failed" on `dms/tests:1:1`) — always use the file-glob form
above (or `cd dms && node --test`).  There is no jest,
babel or TypeScript anywhere in these folders — every tested module is plain CommonJS with no React
Native import.)

`monitoring/__tests__/engineBridge.test.js` drives the **real** engine with the JS `SyntheticDriver`
(`dms/tests/synthetic.js`, the harness the behaviour gate uses) for 150 s of warm-up plus a lap look,
a texting pattern, a microsleep, a sleep and a driver-absent gap, then replays the recorded outputs
through the bridge.  The expected episodes are derived from the engine's own voiced events, so the
assertions are about the translation and not about the engine.  It checks: one alert per episode with
the right type and severity, the counts, `eyesOffRoadSeconds` ≈ the cabin dwell (11.3 s measured
against 9.8 s of scripted dwell plus its ramps), the drowsiness transitions, the calibration sequence
CALIBRATING → PROVISIONAL → CONFIRMED, that INFO never pre-empts a live WARNING, and that a quiet
drive of mirror and cluster checks stays completely silent.

---

## 10. Not verified on a device

What IS verified without a phone: both native projects generate (`expo prebuild` for ios and android
with the module autolinked), the iOS bundle exports (`npx expo export --platform ios`: one 7.5 MB
Hermes bundle), and the EAS development builds — iOS `5d646a0f-6f68-463d-a59c-9f1e14ec4d65`
FINISHED (the module, its resource bundle and both native runtimes compiled and linked; artifact
on the EAS build page), Android `3077954a-81bb-46bc-b972-31d0a166ecfd` after the one Kotlin fix
(`NATIVE_LAYER.md` §7a).  Nothing in this branch has RUN on a phone.  The following need a device:

1. **The whole native path** — camera start, MediaPipe, ONNX, the frame event rate.  See
   `NATIVE_LAYER.md` §V1–V8 for the on-device harness; run it before trusting any number below.
2. **`isMirrored` and the driver-relative left/right.**  A wrong mirror flag swaps LEFT_MIRROR with
   RIGHT_MIRROR and the passenger with the driver window.  Check a deliberate look at the rear-view
   mirror and confirm the zone in `metrics.engine` / the debug log.
3. **`focalScale` / `intrinsicsSource`** per device, and therefore the absolute gaze angles.
4. **The eye-line orientation check** — it only warns; the ±35° threshold has never seen a real
   dash-mounted phone.
5. **The cadence and thermal policy** — `setTargetFps` / `setIdleMode` taking effect, the thermal
   `serious` / `critical` transitions and the 60 s retry.  The policy is unit-tested; the platform
   values it reacts to are not.
6. **Battery and thermals over a real drive** — the 20 fps target, the no-preview assumption.
7. **The persisted reference** — `seedStale` is only called when `ForwardReference.seedStale` exists;
   the ~20 s re-calibration claim is the reference stack's measurement, not a phone measurement.
8. **Permission flow** on a fresh install (module prompt vs `usePermissions`' `expo-image-picker`
   prompt) and after a denial in Settings.
9. **Audio timing** — the screen owns it; the interaction between a monitoring CRITICAL repeat and
   the speed-limit speech has not been heard.
10. **The alert rate on a real driver.**  The reference measures 0.13 voiced false alerts per hour on
    75 Look Both Ways sessions; the phone's frame rate, camera and mount are all different.
