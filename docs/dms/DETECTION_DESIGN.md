# Driver monitoring on the phone — detection design

Status: design of record for the `driver-monitoring` branch (2026-09-18).  Companion documents:
`WARNINGS_DESIGN.md` (what the driver sees and hears), `RESEARCH.md` (the sourced thresholds; cited
below as R §n), `INTEGRATION.md` (the code contract), and the reference deployment stack the rule
engine is ported from (`deployment-stack/docs/DESIGN.md`, `THRESHOLDS.md` — cited as T).

The reference stack (Python, measured on 75 Look Both Ways sessions: 0.13 voiced false alerts per
hour of attentive driving, calibration confirmed in a median 105 s) is ported to plain JavaScript
one module at a time with parity fixtures (`dms/tests/PARITY.md`).  This document says how the
phone drives that engine and where, and why, the phone configuration differs from the reference.
Every threshold here is either the reference value (T) or a phone-specific change justified by R.

## 1. Scope and principles

* The phone sits on a dash or vent mount with the FRONT camera facing the driver at an arbitrary
  angle and height.  Nothing about the mount is configured: the gaze network outputs a
  camera-frame gaze vector, and the label-free forward-gaze calibration finds the direction of
  "eyes on the road ahead" in that same camera frame; every zone is a deviation from that
  reference (T, reference DESIGN §1 and §3).
* Monitoring runs only on the live drive screen (foreground, screen on), which is how the app
  already tracks a drive.  No camera preview is rendered by default.
* The pipeline per frame: camera frame → MediaPipe FaceLandmarker (single pass, native) →
  478 normalized landmarks → `dms/gaze_inputs.js` (weak3d cloud, camera context, validity,
  subject statistic) → gaze network (single pass, no mirror TTA) → `dms/monitor.js`
  (calibration, attention rules, drowsiness rules, alert arbiter) → `WARNINGS_DESIGN.md`.
* Every rule is time-based (seconds from the camera timestamp), never frame-count based, so the
  same engine is correct at 30 fps, at the 10 fps thermal fallback and across dropped frames.
* Pure logic is device-free: `dms/` has no React Native import and is tested with `node --test`.

## 2. Per-frame input record

The native landmark source delivers one `LandmarkFrame` per processed camera frame:

| field | type | meaning |
|---|---|---|
| `t` | number, seconds | monotonic camera timestamp of the frame (never `Date.now()` of the JS callback: the rule clocks must not absorb bridge jitter) |
| `width`, `height` | int px | size of the UPRIGHT image the landmarks are normalized against |
| `landmarks` | `Float32Array(478*3)` or `null` | MediaPipe normalized `(x/W, y/H, z/W)` in the upright image; `null` when no face |
| `facePresent` | bool | a face was detected and the mesh is finite |
| `score` | number | face-presence confidence |
| `isMirrored` | bool | true when the delivered image is a mirror of the scene (front-camera previews are; frames handed to the landmarker must either be un-mirrored or carry this flag) |
| `focalScale` | number | `fx / width` of the upright image (§4) |
| `orientation` | string | device/frame orientation at capture, for the log and the mount-change detector |

Conventions (unchanged from the reference, T §1): camera `+x` image right, `+y` down, `+z` away
from the camera; the stored gaze `s = diag(1, 1, −1) p`; yaw `atan2(x, z)` (+ image right), pitch
`atan2(−y, hypot)` (+ up).  The landmarks must be in the upright frame: the native layer passes
the device orientation to MediaPipe (`imageOrientation`) and reports the upright width/height,
so a phone mounted in portrait and one in landscape produce the same geometry for the same face.

`image_right_is_driver_left = !isMirrored` (an un-mirrored capture of a person facing the camera
has their left side on image right).  A mirrored capture flips the driver-relative left/right and
therefore every asymmetric zone (mirrors, passenger, centre stack) — getting this bit wrong is
the single easiest way to break the zones, so the native layer is required to report it and the
integration self-test checks it against the camera facing.

## 3. Camera, frame rate and battery strategy

Target: ≥ 20 monitored frames per second on a mid-range phone, without a preview.

* **Camera format.**  The lowest front-camera format with the long side ≥ 640 px (typically
  640×480) at 30 fps.  MediaPipe's detector runs at 128 px and the mesh at 192/256 px, so more
  pixels buy nothing; fewer pixels cut ISP and memory bandwidth.  Frame delivery goes straight
  to the native landmarker; JS receives landmarks only (478×3 float32 ≈ 5.7 KB per frame,
  ≈ 115 KB/s at 20 fps).
* **Cadence.**  The landmarker processes every frame it can finish and drops the rest (LIVE_STREAM
  semantics); the gaze network runs on every landmark frame (867 k parameters, single pass,
  ~5–15 ms on a phone CPU); the monitor runs on the JS thread in < 2 ms.  The JS side never
  queues frames: if a landmark event arrives while the previous prediction is in flight it is
  dropped, and the monitor sees the real timestamps of the frames it did process.
* **No-face throttle.**  After 5 s without a face (`alerts.driver_absent_s`, T) the native layer
  processes one frame in six (≈ 5 fps) until a face is found again; `DRIVER_NOT_VISIBLE` timing is
  in seconds and unaffected.
* **Stationary throttle.**  Below 10 km/h (`alerts.speed_gate_kmh`, T) for more than 30 s the
  cadence drops to 10 fps: every distraction alert is speed-gated there anyway, and the
  closed-eye rules (the ones still voiced when stationary) need only ≥ 3 closed frames per 1.5 s
  (`closure_min_frames_low_rate`, T).  Full cadence resumes on the first fix ≥ 10 km/h.
* **Thermal and power.**  Thermal state `serious` (iOS) / `SEVERE` (Android) → 10 fps; `critical` /
  `SHUTDOWN` → camera paused, pill "Monitoring paused — phone too hot", retried every 60 s once
  the state is back to `fair`.  Low Power Mode → 10 fps.  Battery < 15 % and not charging →
  10 fps and a one-time pill.
* **App state.**  `inactive` / `background` → camera stopped (the OS stops front-camera delivery
  anyway); the monitor is NOT reset: on return the reference gap logic applies (attention holds
  its dwell clocks across the gap and restarts glances after ≥ 2 s; drowsiness drops any running
  closure / yawn / nod episode; calibration keeps its histograms and marks the reference STALE
  after 60 s without a face — T §3.4, §5, §6).  A gap longer than 10 minutes ends the drive
  (existing app behaviour).
* **Screen.**  The drive screen already keeps the screen awake; the camera indicator dot (iOS)
  / privacy indicator (Android) is visible by OS design and is explained in the permission
  string.

## 4. Camera intrinsics (focal scale)

The network's camera context needs `focal_scale = fx / width` of the frame the landmarks are
normalized against (T §2: 0.75 for a generic webcam, 1.16 for the LBW cameras).  On the phone:

* iOS: `AVCaptureDevice.activeFormat.videoFieldOfView` is the horizontal field of view of the
  sensor's long side, `hfov`.  With `L` the long side and `S` the short side of the delivered
  frame in pixels, `fx = L / (2 tan(hfov / 2))` and `focal_scale = fx / W_upright`, where
  `W_upright = L` in landscape and `S` in portrait.  Example: hfov 73°, 640×480 delivered, phone in
  portrait → `fx = 640 / (2 tan 36.5°) = 432 px`, `focal_scale = 432 / 480 = 0.90`.
* Android: Camera2 `LENS_INFO_AVAILABLE_FOCAL_LENGTHS[0]` (mm) and `SENSOR_INFO_PHYSICAL_SIZE`
  (mm) with the active-array crop give `fx_px = f_mm / sensor_w_mm × L`; `LENS_INTRINSIC_CALIBRATION`
  when populated is used directly.
* Fallback when the platform exposes nothing: hfov 70° (typical phone front cameras span
  65–80°; R §7), i.e. `fx / L = 0.714`.
* The principal point is the frame centre (the network was trained with principal-point
  jitter; T §2).  Digital zoom must be off (zoom factor 1.0) or the intrinsics are wrong.
* The source of the value (`intrinsics`, `fov`, `default`) is logged in the drive summary.

## 5. Forward-gaze calibration

The reference `ForwardReference` (T §3) is ported verbatim: two exponentially forgetting 2-D
histograms of the camera-frame gaze angles (τ 300 s reference, τ 45 s shift detector), admission
gated on eyes open, face in frame (≥ 0.95), head still (≤ 40 °/s), eyes neutral in the head
(flat band ± 0.03 / 0.02 eye widths around the driver's running iris medians, Gaussian fall-off
σ 0.03 / 0.02), head near its resting pose (σ 10°, floor 0.15); the mode is the densest
road-sized region (σ 4° search, 5° centroid); PROVISIONAL at ≥ 15 admitted seconds with
concentration ≥ 0.50, CONFIRMED at ≥ 60 s with ≥ 0.55 and short/long agreement ≤ 3°; a
persistent 6° shift for 60 s with the three stare guards replaces the reference; a 60-s face gap
marks it STALE with fast re-validation; face-geometry jumps (IOD ± 25 %, centre 0.15 widths for
10 s) raise `CAMERA_MOVED`; post-gap lid/iris statistics jumps raise `DRIVER_CHANGE`.  All values
T "Calibration".

Phone-specific additions (each a config field that defaults to the reference behaviour so the
parity fixtures stay valid):

1. **Speed-weighted admission** (`calibration.stationary_weight`, app value 0.25, reference 1.0).
   When the vehicle speed is known and below `alerts.speed_gate_kmh`, the admission weight is
   multiplied by 0.25.  Why: a driver parked and talking to a passenger holds the head still with
   neutral eyes for minutes, which the reference (built for a car whose speed it never knew)
   would admit as "the road"; the reference's long-mode jump would then need a further 60 s of
   driving to correct it.  Volvo's road-centre initialisation only runs above 70 km/h and Euro
   NCAP allows a minute of driving at ≥ 10 km/h before measuring (R §6, T "Calibration"), so
   learning slowly while stationary and at full weight while moving keeps the stopped-at-a-light
   frames (same direction as driving) useful without letting a parked conversation bootstrap the
   reference.  The gaze histograms therefore carry "admitted driving seconds".
2. **Persisted prior** (`ForwardReference.seedStale(referenceVec, headModeAngles)`).  At drive end,
   if the reference is CONFIRMED, its vector, the resting head pose and the camera facing /
   orientation are stored in AsyncStorage (`@monitorReference:{cameraId}:{orientation}`).  At the
   next drive start with the same camera and orientation, the calibrator starts in the STALE
   state with that reference, which the reference's own re-validation path then confirms from
   15–20 s of agreeing frames or replaces if the mount moved (T §3.4 fast path).  Effect: the
   "learning" time on a repeat drive falls from ~105 s to ~20 s; a moved phone costs nothing
   because disagreement replaces the prior.  The prior is dropped after 30 days or when the app
   version changes the model.
3. **No explicit onboarding task.**  The driver is never asked to look at targets while driving.
   The decision follows Volvo's road-centre method and the measured reference (R §6: mode of the
   gaze density, stable after ~2 min): an explicit "look here" step would either be done while
   stationary (where the mount's view of the road is the same direction anyway, so it adds
   nothing over admitting stationary frames at low weight) or while moving (unsafe).  What the
   driver gets instead is a passive status pill with a progress ring (admitted seconds / 60) and
   one optional spoken line at drive start ("Driver monitoring on. Keep your eyes on the road
   while it learns your view.", setting `@monitorStartupVoice`).  If after 120 s of driving at
   ≥ 10 km/h the reference is still NONE, the pill explains the likeliest cause from the quality
   flags: no face → "Can't see your face — adjust the mount"; face but eyes unreadable → "Eyes
   not visible — head-only monitoring"; face and eyes fine but not admitted → "Learning… hold
   your head still while driving".

State → what the driver sees (details in WARNINGS_DESIGN §5):

| state | rules active | pill |
|---|---|---|
| camera off / no permission | none | "Monitoring off" (grey) |
| NONE, no face | face-presence, head rules once the head mode has 15 s | "No face" |
| NONE, face | drowsiness (closure family always voiced; microsleep only from PROVISIONAL, T §11), head rules | "Learning your view" + ring |
| PROVISIONAL / STALE | + long-glance rule with ROAD_WIDE as the road and far zones widened 5° (T) | "Almost ready" (amber ring) |
| CONFIRMED | everything (A1–A6, VATS, buffer, PRC) | "Watching" (teal) |

## 6. Zones and the mount

Zones are the reference's, in driver terms relative to the calibrated forward direction (T §5):
ROAD ellipse 15° × 10°; ROAD_WIDE 22° × 14° (the windshield, "forward" for every rule);
REARVIEW_MIRROR (−45..−15, +5..+25); LEFT_MIRROR (+35..+75, −15..+5); RIGHT_MIRROR (−80..−40,
−15..+5); CLUSTER (±20, −32..−12); CENTER_STACK (−55..−15, −40..−12); LAP (±30, below −32);
PASSENGER (−95..−40, −12..+15); DRIVER_WINDOW (beyond +75, ±20); UP (above +25); OTHER.
Hard limits: |left| > 60°, up < −30°, up > 30° (ADDW Area 1 / Area 3; T, R §5).  Head-pitch
override zones LOOK_DOWN (head pitch ≤ −12° from rest, exit −9°, 1-s median) and LOOK_UP
(≥ +20°, exit +15°) because the landmark gaze reads relative pitch at gain ≈ 0.1 on real drivers
(T, reference DESIGN §12) — vertical glances are read from the head.

* **Left- / right-hand drive.**  `attention.driver_side` = `"left"` by default (the app's market);
  the setting `@monitorDriverSide` = `right` mirrors every zone's left range (T §1).  The
  rear-view mirror, centre stack and passenger zones sit on the driver's right in LHD and on the
  left in RHD, so this setting matters for every asymmetric zone; the forward ellipse and the
  hard limits are symmetric and unaffected.
* **Mount angle.**  Relative angles are exact rotations of the gaze into the reference frame, so
  a camera 30° off the driver's axis measures deviations from the reference correctly to first
  order (T §1).  Second-order effect: a deviation about the driver's vertical axis projects onto
  the camera frame with a cos-factor that shifts far-zone borders by up to ~10–15 % at 30–40°
  off-axis mounts [E]; the borders are wide (the mirror boxes span 40°) and the alerts are
  duration-based, so this is documented, not compensated.
* **Mirrored capture.**  §2.  A wrong mirror flag swaps LEFT_MIRROR with RIGHT_MIRROR and the
  passenger with the driver window; the integration self-test asserts `isMirrored` against the
  camera facing and the frame source's documented behaviour (`INTEGRATION.md`).

## 7. Rules and state machines

Ported verbatim (module ↔ reference file): `attention.js` ↔ `attention.py` (A1 far-off glances /
phone pattern, A2 long glance and prolonged stare per glance class, A3 VATS, A4 AttenD buffer,
A5 gaze concentration / mirror check, A6 head rules, the LOOK_DOWN / LOOK_UP override, the
display outputs), `drowsiness.js` ↔ `drowsiness.py` (closure state machine with the deep-closure
and look-down guards, blink statistics, PERCLOS 60 s and 180 s, yawns, nods, score and level
hysteresis), `calibration.js`, `monitor.js` (face presence, eyes unreadable, driver change,
camera moved, the arbiter with cooldowns, acknowledgement limits and the speed gate).

Thresholds (all T unless marked; R gives the sources behind T):

| rule | value | source |
|---|---|---|
| forward view | ROAD_WIDE 22° × 14° ellipse | T (63 → 0.13 false alerts/h on attentive drivers); road-centre AOIs 6–10° radius plus the 6.4° model error (R §2, §7) |
| cabin glance limit (`long_glance_s`) | 3.0 s | Euro NCAP long distraction 3–4 s; ADDW 3.5 s at ≥ 50 km/h; NHTSA risk onset 2 s (R §1, §2) |
| instrument glance (`long_glance_mirror_s`) | 4.0 s | driving-task target, AttenD 1-s allowance (R §3) |
| lateral glance, speed unknown or < 30 km/h / moving | 12 s / 4 s | LBW side gaze ≥ 12 s only 0.26/h; NHTSA 12-s task budget; ADDW 6 s at 20–50 km/h (R §6) |
| lateral alert needs head turn | mean head deviation ≥ 10° | T (every true LBW side look ≥ 24°; reference-error "glances" 3–8°) |
| prolonged stare | limit + 3 s | Euro NCAP unresponsive (no return within 3 s of the warning) (R §1) |
| glance gap tolerance | 0.3 s | ADDW no reset on in-out-in (R §7) |
| VATS | 10 s off road in 30 s; mirror dwells < 1 s ignored; lateral counted only when moving ≥ 30 km/h | Euro NCAP short distraction (R §1) |
| AttenD buffer | 2 s, 1-s mirror/instrument delay, 0.1-s refill latency; displayed, not voiced | R §2 |
| phone pattern | 3 LAP / LOOK_DOWN dwells ≥ 0.6 s within 30 s | Euro NCAP phone use = VATS toward the phone (R §4) |
| LOOK_DOWN / LOOK_UP | −12° (exit −9°) / +20° (exit +15°), 1-s median | T (no LBW driver holds −10.5° for 1 s) |
| hard limits | |left| > 60°, up < −30°, up > 30° | ADDW Area 1 ± 55° + margin, Area 3 30° down (R §5) |
| head rules (eyes unreadable) | 35° turn / 20° down, logged at 2 s, voiced from 4 s | T |
| closure hysteresis | openness < 0.3 enter, > 0.5 exit; P80 = openness < 0.2 | T, R (drowsiness) §1 |
| blink / long blink | 60–500 ms / > 400 ms | R (drowsiness) §4 |
| prolonged closure / microsleep / sleep / eyes closed | 0.5 s (silent), 1.0 s (silent pre-alarm), 1.5 s, 3 s, 6 s | Euro NCAP 1–2 s / ≥ 3 s / 6 s; Guardian 1.5 s (R §3) |
| deep closure requirement | ≥ 50 % of the closure's frames ≥ 80 % closed | BERN microsleep criteria (R §3) |
| PERCLOS DROWSY / SEVERE | 60-s ≥ 0.15 AND 180-s ≥ 0.10 / 60-s ≥ 0.30; valid after 30 s / 90 s | VTTI 15 % over 60 s; NSTSCE > 10 % over 150 s (R §2) |
| yawn | MAR > 0.6 for 1.5–12 s; 3 in 10 min = FREQUENT_YAWNING, voiced only with other evidence | R §5 |
| head nod | 15° drop within 1 s, back within 3 s, ≥ 0.3 s closed eyes | R §6 |
| level recovery | one step down after 60 s below the exit thresholds | no official recovery duration exists (R §7) |
| driver absent | event 5 s, voiced 10 s, repeat 30 s | Euro NCAP non-functional notification within 10 s (R §1) |
| speed gate | < 10 km/h: only DRIVER_NOT_VISIBLE and the closure family are voiced | Euro NCAP warns from 20 km/h, learns below (R §6) |
| acknowledgement | 30 s per acknowledged type; ≤ 3 per 120 s; closed-eye family and DRIVER_NOT_VISIBLE never | Euro NCAP suppression after acknowledgement (R §7) |

**Sensitivity setting** (`@monitorSensitivity`, `standard` | `relaxed`; default `standard` = the
reference).  `relaxed` applies the regulatory upper bounds instead of the Euro NCAP values:
`long_glance_s` 3.5 (ADDW at ≥ 50 km/h), `lateral_glance_moving_s` 6.0 (ADDW 20–50 km/h),
`vats_offroad_s` 12.0.  Euro NCAP forbids user-adjustable sensitivity for a rated vehicle system;
this is a consumer app, and the relaxed profile still sits inside the regulation (R §1).  No
profile can turn the closed-eye rules off.

## 8. Vehicle speed from the app's GPS

The drive screen already receives `expo-location` fixes at 1 Hz with `coords.speed` (m/s).  The
session controller feeds the monitor `setVehicleSpeed(kmh)` with:

* `kmh = max(0, speed) × 3.6`, exponentially smoothed with a 2-s time constant (GPS speed at
  1 Hz jitters by ±1–2 km/h);
* `null` (unknown → rules fully active, reference behaviour) when the last fix is older than 10 s
  or has no speed;
* moving/stationary hysteresis inside the controller: "moving" from ≥ 10 km/h, "stationary"
  only after < 5 km/h for 3 s, so a crawl at 8–12 km/h in traffic does not flap the gate.  The
  monitor receives the held value (10 while "moving" is held).

Consequences (all reference behaviour once the speed is known): distraction alerts are silent
when stationary; lateral glances are judged at 4 s from 30 km/h; the calibration admits at 0.25
weight when stationary (§5).

## 9. False-alarm minimization

| concern | mechanism |
|---|---|
| stationary vehicle (parking, red light, drive-through) | speed gate (§8): no distraction alert below 10 km/h; only closed-eye and driver-absent alerts remain |
| mirror scanning, shoulder checks | mirrors are "lateral" (12 s / 4 s moving) with the head-turn requirement; VATS ignores mirror dwells < 1 s; AttenD delays mirrors 1 s |
| intersections, turns, lane changes | lateral limit 12 s when the speed is < 30 km/h (turns happen slowly); side looks above 30 km/h get 4 s; the head-coupling guard rejects reference-offset "glances" |
| model error (≈ 6.4° mean, per-driver offset ≈ 3°) | the forward view is the 22° × 14° windshield ellipse; the reference absorbs the driver offset; every alert is duration-based; a 0.15-s causal median guards single-frame outliers |
| brief returns, blinks, saccades | 0.3-s glance gap tolerance; closures need hysteresis; far glances confirm after 0.4 s |
| sunglasses / eyes not readable | EAR unreadable → gaze unusable → `EYES_UNREADABLE` (info) and head-only rules, voiced only from 4 s |
| passenger in frame | the landmarker runs with `numFaces = 1` and MediaPipe keeps the highest-confidence face; the geometry detector (`CAMERA_MOVED`: IOD or eye-centre jump for 10 s) and the post-gap driver check catch a face switch; documented residual: a passenger leaning into the driver's half of the frame can steal the track for seconds |
| camera / phone moved, rotated | `CAMERA_MOVED` → reference STALE + re-validation; an orientation change event from the native layer resets the landmarker's tracking and marks the reference STALE immediately |
| app backgrounded | camera stopped, rules hold across the gap (§3), no alert on return until the gap logic clears |
| low light, IR-less night | MediaPipe still finds faces at typical dash-lit levels; when it does not, `DRIVER_NOT_VISIBLE` after 10 s (once, then every 30 s) and a pill; no distraction alert can fire without a face |
| looking down with lowered lids | the look-down guard: no closure may start while the head is in LOOK_DOWN; closures younger than 0.5 s are dropped when the head goes down; deep-closure requirement for microsleep/sleep |
| talking, singing | yawns need MAR > 0.6 on every frame for ≥ 1.5 s; FREQUENT_YAWNING is voiced only when the level is already above ALERT |
| one bad minute of PERCLOS | DROWSY needs the 60-s AND the 180-s window |
| repeated alerts | per-type cooldown 4 s (30 s for drowsiness), one audible alert at a time with a 3-s hold, escalation every 2 s only while the condition persists, acknowledgement suppression 30 s |

## 10. Events into the app's data

`utils/monitorEvents.js` aggregates the per-frame outputs and events of one drive into the
summary stored on the drive document (`users/{uid}/drivemetrics/{id}.monitor`) and returns the
three scalars the existing screens use (`distracted`, plus `attentionOffRoadSeconds` and
`drowsinessMaxLevel` at the top level of the document for querying):

```
monitor: {
  version: 1,
  enabled: bool, permission: 'granted'|'denied'|'undetermined',
  intrinsicsSource: 'intrinsics'|'fov'|'default', focalScale,
  monitoredSeconds, facePresentSeconds, eyesReadableSeconds, calibratedSeconds,
  fpsMean, thermalPauses,
  calibration: { timeToProvisionalS, timeToConfirmedS, finalConfidence, recalibrations,
                 staleEvents, cameraMoved, driverChange, seededFromPrior: bool },
  attention: { offRoadSeconds,            // Σ severity-weighted exposure (display metric of the reference)
               forwardShareMean,          // mean road_share_60s over the calibrated time
               glances: { total, byClass: { driving_task, lateral, cabin } },
               longGlances, prolongedStares, phonePatterns, vatsEvents, headDown, headTurned,
               maxGlanceS },
  drowsiness: { maxLevel: 'ALERT'|'DROWSY'|'SEVERE', drowsySeconds, severeSeconds,
                microsleeps, sleeps, eyesClosedEvents, prolongedClosures, yawns, nods,
                maxPerclos60, maxPerclos180, meanBlinkRate,
                levelHistory: [{ t, level }] },   // ≤ 50 entries, first and last transitions kept
  alerts: { voiced: n, acknowledged: n,
            byType: { LONG_GLANCE: n, ... },
            bySeverity: { INFO: n, WARNING: n, CRITICAL: n } },
  system: { driverNotVisible: n, eyesUnreadableEpisodes: n, permissionDenied: bool, errors: n },
}
```

Events are also written to a per-drive JSONL ring in memory (≤ 500 entries, the newest kept) and
attached as `monitor.events` truncated to the last 100 for the drive detail view.

## 11. Points and streak

The current app awards 1 point per ~2.5 s of moving under the limit and counts a "distraction"
when the app leaves the foreground; the streak resets when the app was away > 5 s.  Monitoring
adds, without changing the existing rules:

* **Distraction count.**  Each voiced WARNING or CRITICAL attention alert (`LONG_GLANCE`,
  `PROLONGED_STARE`, `PHONE_PATTERN`, `VATS_DISTRACTION`, audible `HEAD_DOWN` / `HEAD_TURNED`)
  counts once per episode (the arbiter's 2-s escalations of the same glance do not count again:
  an episode is keyed by `t_start`).  Drowsiness alerts do not count as distractions; they are
  reported separately.
* **Points hold.**  No point is awarded while an attention alert is active (a voiced attention
  alert within the last 10 s) or while the drowsiness level is SEVERE.  Euro NCAP terminates a
  transient state 2 s after it ends and needs 1 s of continuous forward gaze (R §7); 10 s is the
  app's "prove you are back" window and matches the reference's ack suppression scale.
* **Streak.**  The streak resets when the drive had ≥ 3 distraction episodes, or any
  `PROLONGED_STARE`, `SLEEP` or `EYES_CLOSED` (a CRITICAL event).  A single 3-s glance costs
  points and a distraction count but not the streak — the streak is the app's strongest
  incentive and the reference measures ~0.13 false alerts per hour, so a one-alert reset would
  punish an attentive driver about once every eight hours.
* **Drive summary.**  The summary (§10) is written with the existing `saveDriveMetrics` call; the
  existing `distracted` field keeps its meaning (count) and now includes the monitored episodes.

## 12. Settings (AsyncStorage, `screens/DriveScreenSettings.js` scheme)

| key | default | meaning |
|---|---|---|
| `@monitorEnabled` | `true` | run the camera monitor during drives |
| `@monitorVoice` | `true` | spoken alerts (expo-speech) |
| `@monitorTone` | `true` | tones (expo-audio) |
| `@monitorHaptics` | `true` | haptics (expo-haptics) |
| `@monitorSensitivity` | `standard` | `standard` (reference) or `relaxed` (§7) |
| `@monitorDriverSide` | `left` | `left` (LHD) or `right` (RHD) |
| `@monitorStartupVoice` | `true` | the one spoken line at drive start |
| `@monitorShowPreview` | `false` | a small camera preview for aiming the mount (costs battery; off by default) |
| `@monitorReference:*` | — | the persisted forward reference (§5) |

## 13. Out of scope / not observable

Hands, objects, phone-in-hand (no object detection); eye-only glances to a phone held high with
the head still (the landmark pitch gain is ~0.1 on real drivers — T); gaze toward hazards; lane and
steering signals; cognitive load beyond the gaze-concentration advisory; a second face's
identity.  These are stated in the app's onboarding copy and in `WARNINGS_DESIGN.md` §7.
