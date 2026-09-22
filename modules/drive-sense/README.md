# drive-sense — the native contract

Local Expo module that records a drive: 1 Hz GNSS, 25 Hz IMU reduced natively to one
`FeatureRow` per second, motion-activity wakes, phone state, and a few utilities. This README
is **binding** for the Swift (`ios/`, task N2) and Kotlin (`android/`, task N3) implementations.
The TypeScript sources are the machine-checked half of the same contract:

| File | What it pins |
|---|---|
| `src/types.ts` | every API method, event, payload and state type; `DRIVE_SENSE_EVENTS`; `DRIVE_SENSE_METHODS` |
| `src/rowSchema.ts` | what JS accepts from the bridge (`parseRow` and the result validators) |
| `src/index.ts` | the JS wrapper: argument checks, result validation, `requireOptionalNativeModule` |
| `src/fake.ts` | `createFakeDriveSense()` — the in-memory implementation every JS test runs against |
| `src/extract/*.ts` | the feature-extraction and gravity-filter **reference** the native code ports |
| `src/extract/constants.ts` | every tunable number, by the name the ports must use |
| `assets/vectors/*.json` | golden vectors the ports must reproduce (`selfTest`) |
| `src/selfTest.ts` | vector validation and the native-vs-reference diff |

Where this README and the TypeScript disagree, the TypeScript wins and the README is a bug.

---

## 1. Rules for both native modules

- **Event names.** Declare exactly
  `Events("wake", "activity", "row", "screen", "thermal", "notificationAction", "call")` —
  keep this list **byte-identical** to `DRIVE_SENSE_EVENTS` in `src/types.ts` and to the other
  platform's list (N2's and N3's text tests compare them). `call` is emitted on iOS only, but
  both platforms declare it.
- **Methods.** Every name in `DRIVE_SENSE_METHODS` is an `AsyncFunction("<name>")` on both
  platforms, even where it is a no-op. `addListener` is the Expo event emitter's, not a
  function you declare.
- **Integers.** Every epoch-ms value you send (`ts`, `captureStartedAt`, `lastRowTs`,
  `MotionActivity.ts`, `ExitInfo.ts`) is a whole number of milliseconds. JS rejects a fractional
  one (`parseRow` drops the row; the result validators reject the promise).
- **Exact keys.** Payloads and results carry exactly the keys in `src/types.ts` — no extras, none
  missing. JS validates with strict schemas; an extra key makes a `row` drop and a method reject.
- **Numbers are finite.** No NaN or ±Infinity anywhere.
- **Silence while moving (SR9).** A failed sensor, a refused foreground-service start or a lost
  fix never produces a notification, sound or modal. Record it (Android: for `getLastExitInfo`)
  and carry on or stop.
- **Battery (design §3.5, binding).** Armed = OS-delivered wakes only: no GPS, no IMU, no timers.
  The one thing that runs while armed is the OS's own motion-activity feed (iOS live
  `CMMotionActivityManager` updates, Android activity transitions), which the motion coprocessor
  delivers at no app cost. GPS 1 Hz only while capturing. IMU 25 Hz batched natively and reduced per second —
  never per sample to JS. No WorkManager jobs.

---

## 2. API

Types are in `src/types.ts`. "Resolves" means the promise resolves with `null`/`undefined`
(JS accepts either for `Promise<void>`).

| Method | Behaviour |
|---|---|
| `arm()` | Start OS-delivered wakes. iOS: significant-change monitoring + one 150 m exit region re-centred on every wake's own location; live `CMMotionActivityManager` updates → `activity`. Android: `requestActivityTransitionUpdates` (IN_VEHICLE, WALKING enter/exit; `PendingIntent` `FLAG_MUTABLE` on API 31+); persisted armed flag for `BootReceiver`. **No GPS.** Idempotent. **Requires** `location: 'always'` and `motion: 'granted'` on both platforms, else rejects `E_PERMISSION` and stays unarmed (without Always, iOS region and significant-change wakes do not relaunch the app and Android cannot start a location service from the background; without motion, iOS cannot confirm a wake as automotive and Android's transitions API throws `SecurityException`). `motion: 'unavailable'` or (Android) no Google Play services → `E_UNAVAILABLE`. iOS re-centres the region only on a location the wake itself carries, or on the manager's cached location when it is newer than the current centre (a region exit carries none); otherwise the next significant-change wake re-centres it — never by starting GPS. |
| `disarm()` | Stop the wakes and clear the persisted armed flag. Does **not** stop a capture in progress. Idempotent. |
| `startCapture(mode)` | Start full-rate capture (1 Hz GNSS + 25 Hz IMU, rows every second) in `mode` ∈ `mounted`/`pocket`/`auto`, set the persisted capture-open flag, `captureStartedAt` = now. **Also the JS claim of a natively started capture** (§6). While already capturing it only updates `mode` and claims — `captureStartedAt` and the rate are unchanged. A new capture takes its `ClockAnchor` (§7 "Time base"). **Requires** `location` `whenInUse` or `always`, else rejects `E_PERMISSION` and does not capture. Motion permission is not needed (the IMU needs none). Android: the OS refusing the location foreground service for lack of background location (started from the background with only `whenInUse`) → `E_PERMISSION`; refusing it for any other reason (background-start restrictions) → `E_FGS_REFUSED`. iOS: a new capture emits `call { active: true }` once if a phone call is already in progress (later changes as they happen). |
| `stopCapture()` | Stop GNSS, IMU and rows; clear the capture-open flag; Android stops the foreground service. Idempotent. |
| `setCaptureRate(rate)` | `full` as above. `low`: coarse location (iOS `kCLLocationAccuracyHundredMeters`, `distanceFilter = 50`; Android `PRIORITY_BALANCED_POWER_ACCURACY` at 10 s), IMU stopped, and a row is emitted **only when a fix arrives** (IMU-absent encoding, §4). The process stays alive. iOS reads the phone state (`locked`/`screenOn`/`appForeground`, and `screen` changes) on each fix at `low` rather than polling at 1 Hz, so the low rate wakes nothing per second. Ignored (resolves) while not capturing. |
| `getState()` | `DriveSenseState` (below). |
| `queryMotionHistory(fromTs, toTs)` | Activities with `fromTs ≤ ts ≤ toTs`, oldest first. iOS: `queryActivityStarting`. Android: the transitions buffered natively over the last 24 h (`TransitionStore`). |
| `getScreenState()` | `{ locked, on }` now (same derivation as the `screen` event). |
| `getThermalState()` | `nominal`/`fair`/`serious`/`critical` (iOS `ProcessInfo.thermalState`; Android `PowerManager` thermal status: NONE/LIGHT → nominal, MODERATE → fair, SEVERE → serious, CRITICAL and above → critical). |
| `requestMotionPermission()` | iOS: triggers the motion prompt with a one-minute activity query; Android API 29+: requests `ACTIVITY_RECOGNITION` (below 29 it is install-time: `granted`). Resolves `granted`/`denied`/`unavailable` (hardware without motion activity). **Never rejects.** Already granted → `granted` without a prompt. When the OS will not ask again (iOS `denied`/`restricted`; Android refused with `shouldShowRequestPermissionRationale` false after a request, i.e. "don't ask again") → `denied` **without prompting**; the app must send the user to Settings. |
| `excludeFromBackup(uri)` | iOS: sets `isExcludedFromBackup` on the file or directory at `uri` (`file://` URI or a path). Android: resolves (backup exclusion is manifest-level). Rejects `E_NOT_FOUND` if nothing exists at `uri`, and `E_IO` if it exists but the attribute could not be set (iOS). JS callers treat a rejection as non-fatal. |
| `setNotificationState({ stationary, startedAt })` | Android S3: `stationary: true` adds the **End drive** action (→ `notificationAction`); `false` removes it. `startedAt` drives "Recording drive · N min" (updated once a minute). iOS: no-op, resolves. |
| `getLastExitInfo()` | Android: the most recent of `ActivityManager.getHistoricalProcessExitReasons(pkg, 0, 1)` and the persisted watchdog record, as `ExitInfo` (mapping: `REASON_USER_REQUESTED`/`USER_STOPPED` → `user_stopped`, `LOW_MEMORY` → `low_memory`, `CRASH`/`CRASH_NATIVE` → `crash`, `ANR` → `anr`, watchdog stop → `watchdog`, a refused FGS start → `other`, anything else → `other`, unknown → `unknown`); `whileCapturing` from the persisted capture-open flag at that time. iOS: `null`. |
| `isIgnoringBatteryOptimizations()` | Android: `PowerManager.isIgnoringBatteryOptimizations(packageName)` — whether background drive detection survives Doze (M4 permission health). **iOS: always `true`** — iOS has no equivalent per-app restriction, so there is nothing for the user to fix. |
| `selfTest(vectorsJson)` | Runs the native extractor and (Android) gravity filter over golden vectors; resolves a JSON string (§8). Rejects `E_INVALID_INPUT` only if the vectors JSON cannot be parsed at all. |

### Errors

Rejections are Expo `CodedError`s with one of the codes in `DRIVE_SENSE_ERROR_CODES`
(`src/types.ts`); the wrapper passes them through unchanged, and `isDriveSenseError(e, code)`
tests for one. Anything else a native method throws is a bug.

| Code | Methods | Meaning |
|---|---|---|
| `E_PERMISSION` | `arm`, `startCapture` | the authorisation the method needs is missing (see each row above) |
| `E_UNAVAILABLE` | `arm` | no motion-activity hardware, or (Android) no Google Play services |
| `E_FGS_REFUSED` | `startCapture` (Android) | the OS refused the foreground service for a reason other than permission |
| `E_NOT_FOUND` | `excludeFromBackup` (iOS) | nothing at the URI |
| `E_IO` | `excludeFromBackup` (iOS) | the file exists but `isExcludedFromBackup` could not be set |
| `E_INVALID_INPUT` | `selfTest` | the vectors JSON is unparseable |

Every other method never rejects: `disarm`, `stopCapture`, `setCaptureRate`, `getState`,
`queryMotionHistory` (an empty list when motion is not granted), `getScreenState`,
`getThermalState`, `requestMotionPermission`, `setNotificationState`, `getLastExitInfo` (`null`
below Android 11), `isIgnoringBatteryOptimizations`.

`armed` in `getState()` is the **effective** arming: false after a rejected `arm()`, and false
again once a permission it needs is revoked (native re-checks the authorisation on every
`getState()`; iOS also on `locationManagerDidChangeAuthorization`). The persisted armed flag is
cleared then too, so `BootReceiver` does not re-arm without permission.

### `DriveSenseState`

| Field | Meaning |
|---|---|
| `armed`, `capturing` | as set by the methods above (and by a native restart, §6) |
| `rate`, `mode` | the current capture's; `null` while not capturing |
| `platform` | `ios` / `android` |
| `location` | the OS location authorisation. iOS: `authorizedAlways` → `always`, `authorizedWhenInUse` → `whenInUse`, `notDetermined`/`denied`/`restricted` → `none`; reduced (approximate) accuracy reports its authorisation unchanged. Android: `ACCESS_BACKGROUND_LOCATION` granted (or API < 29 with fine or coarse granted) → `always`; fine or coarse foreground only → `whenInUse`; neither → `none` |
| `motion` | iOS: `CMMotionActivityManager.isActivityAvailable()` false → `unavailable`, else `authorizationStatus()` `authorized` → `granted`, `denied`/`restricted` → `denied`, `notDetermined` → `undetermined`. Android: no Google Play services → `unavailable`; API < 29 → `granted` (install-time); else `ACTIVITY_RECOGNITION` granted → `granted`, requested and refused → `denied`, never requested → `undetermined` (persist a "requested once" flag to tell these apart) |
| `lockSignal` | how far `locked` can be trusted: Android `reliable`; iOS `lagged` with a passcode, `unreliable` without (§5) |
| `captureWasOpen` | the persisted capture-open flag was set when this process started — a capture was open when the previous process ended (rev1: I2) |
| `captureStartedAt` | integer epoch ms of the current capture's start; `null` while not capturing |
| `lastRowTs` | `ts` of the last row emitted in this process; `null` before any |

---

## 3. Events

| Event | Payload | When |
|---|---|---|
| `wake` | `{ reason, ts }`, reason ∈ `significantChange` / `activityTransition` / `boot` / `geofence` | an OS wake while armed (iOS location-key launch or region exit; Android activity transition, boot, package replaced) |
| `activity` | `MotionActivity` `{ type, confidence, ts }` | a motion-activity change while armed or capturing |
| `row` | a `FeatureRow` (§4) | once per second while capturing at `full`; once per fix at `low` |
| `screen` | `{ locked, on, ts }` | lock/screen change while capturing (Android `SCREEN_ON`/`SCREEN_OFF`/`USER_PRESENT`; iOS on a change of the 1 Hz poll) |
| `thermal` | `{ level, ts }` | a thermal-state change while capturing |
| `notificationAction` | `{ action: 'endDrive', ts }` | Android: the notification's End drive action |
| `call` | `{ active, ts }` | iOS only: `CXCallObserver` — a call started or ended |

**Motion-activity mapping** (the `activity` event and `queryMotionHistory` alike). The drive host
acts on `automotive` (any confidence) and on `walking`/`running` only at confidence `medium` or
above, so these mappings decide whether walking can end a trip.

- **iOS** (`CMMotionActivity`): confidence maps 1:1 (`.low` → `low`, `.medium` → `medium`,
  `.high` → `high`). Several flags can be set at once; `type` is the first set flag in this order:
  `walking` → `running` → `cycling` → `automotive` → `stationary` → `unknown` (the `unknown` flag,
  or no flag at all). So `automotive && stationary` (a red light) is `automotive`. An update equal
  in type and confidence to the previous one is not re-emitted.
- **Android** (Activity Recognition Transitions API, which carries no confidence): the module
  subscribes to IN_VEHICLE and WALKING, ENTER and EXIT.

  | Transition | Emitted |
  |---|---|
  | ENTER IN_VEHICLE | `{ type: 'automotive', confidence: 'high' }` |
  | ENTER WALKING | `{ type: 'walking', confidence: 'high' }` |
  | EXIT IN_VEHICLE | nothing |
  | EXIT WALKING | nothing |

  `ts` is the transition's `getElapsedRealTimeNanos()` converted with §7 "Time base" (an anchor
  read when the transition is received). `TransitionStore` keeps the same mapped entries (ENTER
  only) for 24 h for `queryMotionHistory`. `createFakeDriveSense` has no mapping to do: tests emit
  `MotionActivity` values directly.

**Buffering.** Every event emitted while **no JS listener for that event** is attached is
buffered natively and delivered, in order, when the first listener for it attaches (Expo
`OnStartObserving`), after `addListener` returns. The buffer holds at most **300** events across
all events; when full, drop the **oldest `row`** first, else the oldest event. (This is how a
`wake` that launched the process reaches JS after the bundle loads. `createFakeDriveSense`
implements the same rule, and `EVENT_BUFFER_MAX` in `src/fake.ts` is the number.)

---

## 4. The row contract (R2)

`row` payloads must pass `parseRow` (`src/rowSchema.ts`): exactly M1's `FeatureRow` keys
(`src/core/engine/types.ts`), finite numbers, booleans for the three phone flags, and `ts` a
non-negative integer epoch ms. The encodings:

| Situation | Encoding |
|---|---|
| `ts` | the end of the window the row closes, integer epoch ms, strictly increasing within a capture |
| unknown `speed` / `speedAcc` / `course` | `-1` |
| no fix in the second | `lat`/`lng`/`alt` of the last fix of any quality (`0`/`0`/`0` before any), `hAcc = 9999`, `speed = speedAcc = course = -1`, `gnssValid = false` |
| fix with unknown accuracy (platform reports negative) | `hAcc = 9999`, `gnssValid = false` |
| platform unknowns | **Android:** `hasSpeed()` false → `speed = -1`; `hasSpeedAccuracy()` false → `speedAcc = -1`; `hasBearing()` false → `course = -1`; `hasAccuracy()` false → `hAcc = 9999`; `hasAltitude()` false → `alt` of the last fix (0 before any). Never read `getSpeed()` and the rest without the `has…()` check: they return 0.0, not −1. **iOS:** `speed`, `speedAccuracy`, `course` < 0 → −1; `horizontalAccuracy` < 0 → 9999 |
| `gnssValid` | the window has a fix (chosen by fix timestamp, §7 "Windows") ∧ `0 ≤ hAcc ≤ GNSS_MAX_HACC_M` (50 m) ∧ age at `ts` ≤ `GNSS_MAX_AGE_S` (1.5 s) |
| fewer than `MIN_IMU_SAMPLES` (10) IMU samples in the second, or IMU stopped (`low` rate) | **IMU absent**: `aLonMax`, `aLonMin`, `aLatMax`, `aLatMin`, `yawRateMax`, `jerkMax`, `gravityStability`, `orientationDelta`, `handlingScore` all `0` (M1's `finalize.ts` reads "IMU present" from the six extremes) |
| IMU present, frame not aligned | `aLonMax`, `aLonMin`, `aLatMax`, `aLatMin`, `jerkMax` are `0`; `yawRateMax`, `gravityStability`, `orientationDelta`, `handlingScore` are computed |
| `locked` / `screenOn` / `appForeground` | the phone state at the end of the second (§5) |

Units: g for accelerations, g/s for jerk, rad/s for yaw rate, rad for `orientationDelta`,
m and m/s for GNSS, degrees clockwise from true north for `course`.

---

## 5. Phone state

- **Android**: `locked = KeyguardManager.isKeyguardLocked`, `screenOn = PowerManager.isInteractive`,
  `appForeground` from the process importance; `lockSignal: 'reliable'`.
- **iOS**: `UIApplication.isProtectedDataAvailable` polled at 1 Hz while capturing:
  `locked = !available`, `screenOn = available`, `appForeground = applicationState == .active`.
  - With a passcode, protected data becomes unavailable about **10 s after** the side-button
    press (the file-protection grace period), so `locked` lags the real lock by ~10 s:
    `lockSignal: 'lagged'`. The drive host confirms a lock for 12 s before treating the gap as
    non-use (rev1: I11).
  - **Without a passcode**, protected data never becomes unavailable, so `locked` stays `false`
    and a locked phone is indistinguishable from an unlocked one in the background:
    `lockSignal: 'unreliable'` (`LAContext().canEvaluatePolicy(.deviceOwnerAuthentication)`
    false). The host then does not count background time as phone use.

---

## 6. Watchdog (rev1: C2) — capture nobody records must stop

Only JS can decide a drive is over, so native must not keep sensing when JS is not there:

1. **Claim within 60 s.** A capture **native started by itself** — Android: the activity-transition
   receiver or a `START_STICKY` null-intent restart; iOS: the relaunch restart when `captureOpen`
   was set — must be claimed by a JS `startCapture` within **60 s**. Otherwise stop capture,
   clear the capturing and capture-open flags, stop the foreground service (Android), and record
   exit reason `watchdog`.
2. **A row listener must exist.** While capturing, if **no JS listener for `row`** has been
   attached for **5 minutes** continuously (Expo `OnStartObserving`/`OnStopObserving` for `row`),
   do the same. The liveness signal is "a JS row listener is attached" — no JS timer or heartbeat
   is involved, and it catches exactly the failure that matters: nobody consuming rows. So the
   notification can never say "Recording your drive" over a capture nobody records.

`startCapture` from JS always claims. The JS side's own guard is H2's headless task, which calls
`stopCapture` when its boot fails; the watchdog is the second line.

**Android: the headless task never outlives the drive (review N2N3 I4).** The headless service
holds a partial wake lock until its task finishes, so native owns its end too: a watchdog stop also
stops the headless service **at once** (its `onDestroy` releases the wake lock); a normal
`stopCapture` stops it after a **2-minute** grace for finalize and upload; and the task itself is
bounded (`HeadlessJsTaskConfig` timeout 6 h — never 0; if a drive outlasts it only the headless
service ends, while the capture keeps its own foreground service and wake lock). JS side (H2):
the `DriveSenseTask` promise must settle once the capture has stopped and the drive is finalized.

---

## 7. Feature extraction (R1) — frames and algorithm

The reference is `src/extract/extract.ts` (+ `alignment.ts`, `handling.ts`, `gravityFilter.ts`,
`vec.ts`). Port it **line for line**: same order of operations, same edge cases, doubles
throughout, constants under the names in `src/extract/constants.ts`. The golden vectors
(§8) check the port to `SELF_TEST_TOLERANCE` = 1e-6 per field.

### Frames

- **Device frame**, identical on iOS and Android: x right, y toward the top of the screen, z out
  of the screen; right-handed; angular rate counter-clockwise positive.
- **No magnetometer, no compass, no GNSS course.** In cars with magnetic phone mounts the compass
  is unreliable, and a wrong frame mixes braking with cornering. The vehicle frame is learned in
  the device frame:
  - **vertical** = gravity;
  - **forward `f`** = the horizontal device-frame direction the user acceleration takes while GNSS
    says the speed is changing (sign from Δv);
  - **lateral `l` = normalize(f × ĝ)**, which is **left-positive** (see below).
- Inputs are normalised to:
  - `g` — gravity in g, **pointing toward the earth**, device frame (face-up on a table ≈ [0, 0, −1]);
  - `ua` — user acceleration in g, device frame, in the **same sign convention as g**: the
    accelerometer reading is `a = g + ua` (CoreMotion's convention; `ua` points opposite to the
    kinematic acceleration);
  - `w` — angular rate, rad/s.
- **iOS**: `CMMotionManager.startDeviceMotionUpdates(using: .xArbitraryZVertical)` at 25 Hz on a
  background queue; `gravity` → `g`, `userAcceleration` → `ua`, `rotationRate` → `w`. Nothing else.
- **Android**: hardware `TYPE_ACCELEROMETER` + `TYPE_GYROSCOPE` only (no rotation vector, no
  magnetic field), 40 000 µs, `maxReportLatencyUs` 1 000 000 (FIFO-batched). Convert the
  accelerometer with `a = −values / G_MPS2` (`androidAccelToReference`), then run the gravity
  filter below to get `g` and `ua`.
- **Why `f × ĝ` is left whatever the sign of `ua`**: `f` is learned from `ua`, so if `ua` is
  negated `f` is negated too and `aLon = h·f` is unchanged. With `ĝ` pointing down, `f × ĝ` is the
  vehicle's left when `f` is its front, and its right when `f` is its back — and in the second
  case `h` is negated as well, so `aLat = h·l` is again left-positive. (`ĝ × f` would be
  right-positive with a downward `ĝ`; the brief's formula assumed an upward gravity vector.)

### Gravity filter (Android only; `gravityFilter.ts`)

State `{ g, t, mags }`, initially `{ null, null, [] }`, carried across batches (`mags` = |a| of
the last ≤ 4 samples, oldest first). Per raw sample, in order:

```
dt = (t − t_prev) / 1000                       (0 when t_prev is null)
if g is null or dt ≤ 0 or dt > GRAVITY_RESET_GAP_S (1 s):   g = a, mags = [|a|]      (seed)
else:
    mags ← the last GRAVITY_GATE_SAMPLES (5) of mags + [|a|];  m = mean(mags) (summed oldest first)
    g_pred = g + (g × w)·dt                    (dg/dt = −w × g: gravity is fixed in the world)
    if | m − 1 | ≤ GRAVITY_GATE_G (0.02 g):                (no dynamic acceleration)
        α = GRAVITY_TAU_S / (GRAVITY_TAU_S + dt)           (GRAVITY_TAU_S = 5 s)
        g = α·g_pred + (1 − α)·a
    else:                                                  (braking, cornering, a bump)
        g = g_pred                                         (the gyro alone carries gravity)
ua = a − g
emit { t, ua, g, w }
```

`g` is not renormalised. Batch boundaries do not change the output.

Why these values (N1 fix round, coordinator ruling): with a 0.5 s time constant a 0.45 g brake
was absorbed into "gravity" within a second (0.06 g left after 1 s, gravity tilted 0.37 rad), so
Android under-read braking, `gravityStability` collapsed and a held brake reset the frame. The
filter is now gyro-dominant (5 s), and the accelerometer does not correct gravity at all while its
magnitude says the car is accelerating. A phone genuinely repositioned in its mount is still
followed: the gyro carries the rotation at once, and anything the gyro missed is pulled in by the
accelerometer within a few time constants; a gap longer than `GRAVITY_RESET_GAP_S` re-seeds.
The gate reads the **mean |a| over the last 5 samples** (200 ms), not each sample (N1 fix
round 4): with per-sample gating, accelerometer noise (σ ≈ 0.01 g) opened the gate on about 15 %
of the samples of a held 0.25 g acceleration (|a| − 1 ≈ 0.031, just above the gate), so 7.5 s of
it tilted gravity ≈ 0.035–0.047 rad and the brake after it read −0.52 g for a true −0.45 g —
enough to push a gentle 0.25 g brake past `HARSH_BRAKE_G`. Averaging five samples cuts the noise
on the gated quantity by √5: about 3× less leak. Over noise seeds 21–28 the same scenario keeps
the tilt at 0.007–0.024 rad (a per-sample gate: 0.038–0.059) and reads the brake within 0.025 g
of −0.45; `gravityFilter.test.ts` asserts < 0.03 rad and ±0.03 g on every one of those seeds. A
sustained acceleration gives every sample, and so the mean, the same |a|, so the trip point below
is unchanged. The window restarts at every seed (`mags = [|a|]`): the `gravity-filter` vector
re-seeds in the middle of a batch straight into a 0.25 g acceleration, so a port that keeps the
stale magnitudes fails it (the generator refuses the vector unless that port differs by > 1e-4).

**Seeding caveat — its real consequence (N1-r4 M2).** A capture that seeds mid-acceleration (the
ordinary automatic start as a car pulls away) starts with gravity tilted by about the acceleration
(0.25 g → 0.25 rad), and the gate holds that tilt until the car cruises. The cost is **coverage,
not false events**: the tilt makes a false "brake" at cruise, but the frame aligns only on updates
where GNSS Δv ≥ `ALIGN_MIN_G` and needs `ALIGN_MIN_UPDATES` agreeing ones, so that false reading
never trains the frame. Those rows stay unaligned — their frame-dependent fields are 0, so events
there go unmeasured — for tens of seconds, and after a strong start (≥ 0.35 g) the frame may not
align for more than 40 s. A test seeds inside a 0.3 g acceleration and asserts no row reaches
−`HARSH_BRAKE_G` in the next 30 s. If the device pass shows the coverage loss is large, a cheap
mitigation is a short time constant for the first few seconds of in-band samples after a seed.

The gate: a sustained horizontal acceleration h changes |a| by √(1 + h²) − 1 ≈ h²/2, so the gate trips at
h = √((1 + GRAVITY_GATE_G)² − 1) ≈ 0.2 g — below `HARSH_ACCEL_G` (0.28) and `HARSH_BRAKE_G`
(0.30), which a test enforces. (At 0.05 it tripped only above 0.32 g, and a harsh 0.30 g
acceleration faded below the threshold as it was absorbed.)
Accepted cost (device-pass item): on a rough road |a| leaves the ±0.02 g band more often, so the
accelerometer correction runs less and the gyro carries gravity for longer; drift is corrected at
cruise, when |a| ≈ 1 g.

### Time base (`src/extract/timebase.ts`)

Samples and fixes are timed on the monotonic **boot clock** and converted to epoch ms through
**one anchor per capture**, so a wall-clock change mid-drive cannot reorder them:

- A new capture (`startCapture` when not capturing, or a native restart) takes a
  `ClockAnchor { epochMs, clockMs }`, reading both clocks back to back: Android
  `System.currentTimeMillis()` and `SystemClock.elapsedRealtimeNanos() / 1e6`; iOS
  `Date().timeIntervalSince1970 × 1000` and `ProcessInfo.processInfo.systemUptime × 1000`.
- The boot-clock time of each item: Android `SensorEvent.timestamp / 1e6` (nanoseconds, on the
  `elapsedRealtimeNanos` base) and `Location.getElapsedRealtimeNanos() / 1e6` (not `getTime()`);
  iOS `CMLogItem.timestamp × 1000` (device motion, on the `systemUptime` base). iOS
  `CLLocation.timestamp` is already a `Date`: use `timeIntervalSince1970 × 1000` directly.
- `t = anchor.epochMs + (clockMs − anchor.clockMs)` (`toEpochMs`).
- **Sanity fallback:** if that `t` is more than `TIMEBASE_MAX_SKEW_MS` (2000 ms) from the item's
  arrival time, use the arrival time instead and count it for diagnostics (some older Android
  devices time sensor events on another base). Batched Android samples arrive up to 1 s late,
  inside the margin.
- **Android: "arrival" is measured on the capture's anchored boot clock**, not the wall clock:
  `arrival = anchor.epochMs + (SystemClock.elapsedRealtimeNanos() / 1e6 − anchor.clockMs)` at
  delivery (review N2N3 I2). Row `ts` is on the same base, so a wall-clock step mid-drive (a manual
  change, an NTP or NITZ correction) moves neither the samples, the fixes nor the windows; the
  fallback then fires only for its real target, a sensor stamping on another clock. (Against
  `currentTimeMillis()`, a step over 2 s pushed every later sample and fix off its window: the rest
  of the drive had no IMU and no fix.) iOS keeps its wall-clock design (below).

### Windows: which samples and which fix belong to a row

- Rows close on a 1 s timer, `ts` = the timer instant rounded to an integer. A row's window is
  **`(previous row's ts, ts]`** (`windowStart`). Only a capture's first row, and the first row after
  a gap between row timestamps longer than `MAX_ROW_GAP_MS` (2000 ms: a stalled timer, a suspended
  process), use `(ts − FIRST_WINDOW_MS, ts]` = `(ts − 1000, ts]`. A late timer makes one longer
  window and the next one shorter; no sample is dropped or counted twice.
- The window's IMU samples are those with converted `t` in the window, sorted oldest first
  (`takeWindow`). Samples with `t > ts` wait for the next window; samples at or before the window
  start (a window already closed) are dropped and counted.
- The window's fix is the one with the **latest fix timestamp** in the window (`pickFix`), whatever
  order the fixes arrived in. No fix is used by two rows.
- **When a row closes (both platforms; review N2N3 I1).** Once the data for its window can be
  complete: the first IMU sample stamped after `ts` has arrived (or the IMU is not running)
  **and** either a fix stamped after `ts` has arrived or `FIX_SETTLE_MS` (300 ms) has passed since
  `ts` — capped at `ROW_MAX_WAIT_MS` (1.5 s) after `ts`. The platform delivers a fix a few hundred
  ms after its own timestamp and `pickFix` never uses a late fix, so closing on the IMU alone
  (Android batches it up to 1 s late, so a burst often lands before the fix) would drop good fixes
  and report `gnssValid: false`. The row keeps its `ts`; rows reach JS about 300 ms after `ts`.
- At `low` rate a row is emitted per fix, with `ts` = the fix's converted time rounded, and skipped
  if it is not greater than the previous row's `ts`.

#### iOS: when a row closes, and what its `ts` is (N2 ruling)

- **Row `ts` is the wall clock at the 1 s tick** (`Date()`, rounded), not an anchor-converted
  uptime. `CLLocation.timestamp` is a wall-clock `Date` used directly, and the sanity fallback puts
  any IMU sample whose converted stamp drifts more than 2 s from arrival onto the wall clock too;
  so after a wall-clock change the fixes, the samples and the windows all stay on one base (an
  uptime-based `ts` would have put every fix in the wrong window). A clock set back holds rows until
  the wall clock passes the previous `ts`, keeping `ts` strictly increasing.
- **A row closes** by the rule above, common to both platforms (iOS found it first: Core Location
  delivers a fix a few hundred ms after its timestamp). Up to 1.5 s if device motion delivers
  nothing. Constants in `ios/RowPipeline.swift` and `android/…/CaptureService.kt`.

### Per second: `extractSecond(imu, fix, phone, tsMs, state)`

State (`ExtractState`, carried across seconds, initially `initialExtractState()`):
`lastFix` (lat/lng/alt of the last fix of any quality), `prevValidFix` (`{t, speed}` of the
previous second's fix if it was valid with a known speed), `lastImuT`, `hTail` (last ≤ 4
horizontal user-acceleration vectors), `prevLon` (last smoothed longitudinal value, for jerk),
and the alignment: `f`, `agree`, `aligned`, `gravityRing` (≤ 10 unit vectors), `gravityDevS`.

**1. GNSS** (§4's table), then the Δv for alignment: if this second's fix is valid and its speed
is known (≥ 0) — if `prevValidFix` exists and `fix.t > prev.t`,
`dvG = (speed − prev.speed) / ((fix.t − prev.t)/1000) / G_MPS2` (signed, in g);
`prevValidFix ← {fix.t, speed}`. Otherwise `prevValidFix ← null` and `dvG` is none.

**2. IMU absent** (`n < MIN_IMU_SAMPLES`): IMU fields 0 (§4); `hTail ← []`, `prevLon ← null`,
`lastImuT ←` the last sample's `t` if any, else unchanged; **alignment unchanged**. Done.

**3. Per sample** `i = 0 … n−1`:
- `ĝᵢ = normalize(gᵢ)`; `gMean = normalize(Σ ĝᵢ)`
- `dtᵢ = clamp((tᵢ − tᵢ₋₁)/1000, 0, IMU_MAX_DT_S)` with `t₋₁ = lastImuT` (`dt₀ = 0` if none); `IMU_MAX_DT_S` = 0.1 s
- `hᵢ = uaᵢ − (uaᵢ·ĝᵢ)ĝᵢ` (horizontal user acceleration)
- `offᵢ = |wᵢ − (wᵢ·ĝᵢ)ĝᵢ|` (angular rate off the gravity axis)

**4. Frame-free features** (always, when IMU is present):
- `yawRateMax = maxᵢ |wᵢ·ĝᵢ|`
- `gravityStability = 1 − clamp(maxᵢ angle(ĝᵢ, gMean) / GRAVITY_STABILITY_RAD, 0, 1)` (0.2 rad)
- `orientationDelta = Σᵢ offᵢ·dtᵢ`
- `handlingScore = clamp((√(Σ offᵢ² / n) − HANDLING_W_FLOOR) / HANDLING_W_SPAN, 0, 1) × (gravityStability < HANDLING_STABLE_GS ? 1 : HANDLING_STABLE_FACTOR)` (0.15 rad/s, 0.6 rad/s, 0.95, 0.5)

**5. Reset check** — the phone moved relative to the car:
- `dev = angle(gMean, normalize(Σ gravityRing))` if the ring is non-empty, else 0
- `gravityDevS = dev > RESET_GRAVITY_RAD (0.2) ? gravityDevS + 1 : 0`
- **reset** if `orientationDelta > RESET_ORIENT_RAD (0.35)` or `gravityDevS ≥ RESET_GRAVITY_S (2)`:
  `f ← null, agree ← 0, aligned ← false, gravityRing ← [], gravityDevS ← 0`
- push `gMean` onto the ring, keep the last `GRAVITY_MEAN_S` (10)

**6. Re-project** `f` onto this second's horizontal plane: `f ← normalize(f − (f·gMean)gMean)`;
if that is the zero vector, drop the frame (`f ← null, agree ← 0, aligned ← false`).

**7. Alignment update** (skipped in a second that reset): when `dvG` exists and
`|dvG| ≥ ALIGN_MIN_G` (0.1 g):
- `m = mean(hᵢ)`, `m ← m − (m·gMean)gMean`; skip if `|m| < ALIGN_MIN_H_G` (0.05 g)
- `u = normalize(m) · sign(dvG)`
- if `f` is null: `f ← u, agree ← 0`
- else: `agree ← angle(u, f) ≤ ALIGN_TOL_RAD (0.35) ? agree + 1 : 0`;
  `f ← normalize(reject((1 − ALIGN_ALPHA)·f + ALIGN_ALPHA·u, gMean))` (`ALIGN_ALPHA` 0.1; zero → drop the frame as in 6);
  `aligned ← aligned ∨ agree ≥ ALIGN_MIN_UPDATES` (5)
- So steady acceleration aligns the frame in the 7th second: one update seeds `f`, five more agree.
  Once aligned, only a reset un-aligns.

**8. Frame-dependent extremes** — only when `aligned`: `l = normalize(f × gMean)`; the window
starts as `hTail`; for each sample push `hᵢ`, keep the last `SMOOTH_SAMPLES` (5), `smᵢ` = mean of
the window (summed oldest first); `lonᵢ = smᵢ·f`, `latᵢ = smᵢ·l`;
`aLonMax/Min = max/min lonᵢ`, `aLatMax/Min = max/min latᵢ`;
`jerkMax = max |lonᵢ − lon_prev| / dtᵢ` over samples with `dtᵢ > 0` and a previous value
(`lon_prev` starts as `prevLon.v`, so jerk spans the second boundary); `prevLon ← {tₙ₋₁, lonₙ₋₁}`.
When not aligned: the five fields are 0, `prevLon ← null`, and the window still advances.

**9. Carry** `hTail ←` the last ≤ 4 of the window, `lastImuT ← tₙ₋₁`, the phone flags onto the row.

### Constants (`src/extract/constants.ts`)

| Name | Value | Use |
|---|---|---|
| `G_MPS2` | 9.80665 | m/s² per g |
| `IMU_RATE_HZ` | 25 | requested IMU rate |
| `MIN_IMU_SAMPLES` | 10 | fewer → IMU absent |
| `SMOOTH_SAMPLES` | 5 | moving-average length |
| `IMU_MAX_DT_S` | 0.1 | clamp on sample intervals |
| `GNSS_MAX_HACC_M` | 50 | validity |
| `GNSS_MAX_AGE_S` | 1.5 | validity |
| `NO_FIX_HACC_M` | 9999 | hAcc with no/unknown fix |
| `UNKNOWN` | −1 | unknown speed/speedAcc/course |
| `ALIGN_MIN_G` | 0.1 | min \|Δv/Δt\| for an update |
| `ALIGN_ALPHA` | 0.1 | update weight |
| `ALIGN_MIN_UPDATES` | 5 | agreeing updates to align |
| `ALIGN_TOL_RAD` | 0.35 | agreement angle |
| `ALIGN_MIN_H_G` | 0.05 | min mean horizontal accel for an update |
| `RESET_ORIENT_RAD` | 0.35 | orientation reset |
| `RESET_GRAVITY_RAD` | 0.2 | gravity-deviation reset angle |
| `RESET_GRAVITY_S` | 2 | …for this many seconds |
| `GRAVITY_MEAN_S` | 10 | gravity ring length |
| `GRAVITY_STABILITY_RAD` | 0.2 | gravityStability scale |
| `HANDLING_W_FLOOR` | 0.15 | handling floor, rad/s |
| `HANDLING_W_SPAN` | 0.6 | handling span, rad/s |
| `HANDLING_STABLE_GS` | 0.95 | steady-gravity threshold |
| `HANDLING_STABLE_FACTOR` | 0.5 | handling multiplier when steady |
| `GRAVITY_TAU_S` | 5 | gravity filter time constant |
| `GRAVITY_GATE_G` | 0.02 | accelerometer correction only while \|mean ‖a‖ − 1\| ≤ this |
| `GRAVITY_GATE_SAMPLES` | 5 | samples averaged for the gate (200 ms) |
| `GRAVITY_RESET_GAP_S` | 1 | gravity filter re-seed gap |
| `EPS` | 1e-9 | `normalize` zero threshold |
| `SELF_TEST_TOLERANCE` | 1e-6 | self-test per-field tolerance |

### Vector helpers (`vec.ts`) — port these definitions exactly

`normalize(v)` returns exactly `[0, 0, 0]` when `|v| < EPS`. `angle(a, b) = atan2(|a × b|, a·b)`
(0 when either is zero). `reject(v, n) = v − (v·n)n`. `clamp(x, lo, hi) = min(hi, max(lo, x))`.

---

## 8. Golden vectors and the self-test

`assets/vectors/*.json` — one compact JSON object per file:

```jsonc
// kind "extract": feed inputs.seconds in order to extractSecond from initialExtractState()
{ "name": "hard-brake", "description": "…", "kind": "extract",
  "inputs": { "seconds": [ { "tsMs": 1700000001000,
      "imu": [ { "t": 1700000000040, "ua": [x,y,z], "g": [x,y,z], "w": [x,y,z] }, … ],
      "fix": { "t", "lat", "lng", "hAcc", "speed", "speedAcc", "course", "alt" } | null,
      "phone": { "locked", "screenOn", "appForeground" } }, … ] },
  "expected": { "rows": [ FeatureRow, … ] } }
// kind "gravityFilter": feed each batch to gravityFilter, carrying the state, from { g: null, t: null }
{ "name": "gravity-filter", "description": "…", "kind": "gravityFilter",
  "inputs": { "batches": [ [ { "t", "a": [x,y,z], "w": [x,y,z] }, … ], … ] },
  "expected": { "batches": [ [ { "t", "ua", "g", "w" }, … ], … ] } }
// kind "androidRaw": the Android production path end to end. For each second in order: convert
// every raw sample with a = −values / G_MPS2 (androidAccelToReference), run gravityFilter over
// the converted samples (its state carried across seconds), then extractSecond(imu, fix, phone,
// tsMs) (its state carried too); both states start fresh.
{ "name": "android-raw", "description": "…", "kind": "androidRaw",
  "inputs": { "seconds": [ { "tsMs",
      "raw": [ { "t", "values": [x,y,z] /* TYPE_ACCELEROMETER, m/s², Android sign */, "w": [x,y,z] }, … ],
      "fix": { … } | null, "phone": { … } }, … ] },
  "expected": { "rows": [ FeatureRow, … ] } }
```

| Vector | What it pins |
|---|---|
| `cruise` | alignment in second 7, then cruise: aligned extremes ≤ 0.05 g, handling 0 |
| `hard-brake` | 0.45 g brake → `aLonMin ≈ −0.45` |
| `corner-left` | 0.40 g left corner → `aLatMax ≈ +0.40`, `aLon ≈ 0` |
| `turn-lagged-course` | a right turn with the course lagging 1 s — the frame never reads the course |
| `phone-pickup` | pickup → `handlingScore ≥ 0.6`, orientation reset, extremes 0 |
| `mount-shift` | slow sag in the mount → gravity-deviation reset in second 10 |
| `no-imu` | IMU-absent encoding and every GNSS encoding of §4 |
| `unaligned-start` | frame-free fields populated, frame-dependent fields 0 |
| `gravity-filter` | the Android filter on raw accel + gyro, with a re-seeding gap between batches and a re-seed in the middle of the last batch straight into a 0.25 g acceleration (pins the gate-window reset: a port that keeps stale magnitudes fails) |
| `android-raw` | Android units and sign in, rows out: the conversion, the filter and the extractor together (a port that skips `/ G_MPS2` or the sign fails it) |

Regenerate after changing the reference or a constant (never by hand):

```
node --experimental-strip-types --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON modules/drive-sense/scripts/make-vectors.ts
```

The generator refuses a vector in which any computed value compared with a threshold lies
within `MARGIN_MIN` (1e-7) of it (`src/extract/probe.ts`): there a different `atan2`/`sqrt`
rounding in Swift or Kotlin could take the other branch. The `probe(...)` calls in the reference
are that test instrumentation — **ports do not port them**. The closest approach in the committed
vectors is 4.3e-5 (the gravity gate).

`__tests__/vectors.test.ts` fails if a committed file differs from a fresh generation or if any
`expected` differs from the reference over its `inputs`. Vectors are loaded only by the
diagnostics screen (U5) — never by a production code path.

### Self-test protocol

1. JS (U5) reads the vector files and calls `DriveSense.selfTest(JSON.stringify(vectors))` —
   a JSON **array** of vector objects as above (`parseVectors` validates them first).
2. **`selfTest` must call the same classes and conversion functions the capture path uses**:
   the production `FeatureExtractor`, `GravityFilter` and (Android) accelerometer conversion
   (`a = −values / G_MPS2`), never a copy kept for testing. A port that forgot the conversion or
   its sign must fail the `android-raw` vector: kind `androidRaw`, whose inputs are raw
   `TYPE_ACCELEROMETER` values in m/s² with Android's sign plus the gyroscope, per second with a
   fix. Android converts, filters and extracts, and returns `rows`; iOS answers `skipped`.
3. Native parses the array, and for each vector runs its own port over `inputs` exactly as
   `runVector` in `src/extract/vectors.ts` does (fresh state per vector). `expected` is ignored.
   Android runs every vector. iOS has no gravity filter and no raw-accelerometer path
   (CoreMotion supplies gravity and user acceleration), so it answers each `gravityFilter` and
   `androidRaw` vector with the `skipped` form and runs every `extract` vector.
4. Native resolves a JSON string:
   ```jsonc
   { "version": 1, "platform": "ios" | "android",
     "results": [ { "name", "kind": "extract", "rows": [FeatureRow, …] }
                | { "name", "kind": "gravityFilter", "batches": [[ImuSample, …], …] }
                | { "name", "kind", "error": "message" }
                | { "name", "kind": "gravityFilter" | "androidRaw", "skipped": "reason" } ] }   // one per input vector, in order
   ```
   A vector that throws natively yields the `error` form; the promise rejects only if the input
   is not parseable at all.
5. JS diffs with `diffSelfTest(vectors, outputJson)` (`src/selfTest.ts`): every number within
   `SELF_TEST_TOLERANCE`, every boolean and array length exact, no missing or extra keys; the
   first 20 mismatches per vector are listed by path (`rows[8].aLonMin`). A `skipped` result is
   accepted only for a `gravityFilter` or `androidRaw` vector on `platform: "ios"`; anywhere else
   it fails.

---

## 9. JS usage

```ts
import DriveSense, { parseRow, createFakeDriveSense } from '@drive-sense';

const sub = DriveSense.addListener('row', (raw) => {
  const row = parseRow(raw); // null → drop it
  if (row) engine.dispatch({ type: 'row', row });
});
```

The wrapper checks arguments before they cross the bridge and validates every result after; a
native bug surfaces as a rejected promise naming the method (`DriveSense.getState: invalid
result …`). Where the native module is absent (Jest, Expo Go, web), importing is safe, every
method rejects with "DriveSense native module is not available", and `addListener` returns an
inert subscription — tests inject `createFakeDriveSense({ platform, now, asyncDelivery })`
instead. The fake follows this contract where host tests depend on it:

- rows flow only while capturing: `step`/`drain` emit nothing before `startCapture` or after
  `stopCapture` (`{ force: true }` overrides, for tests of that edge), and `pendingRows()` shows
  what was left;
- `arm()` rejects `E_PERMISSION` unless `location: 'always'` and `motion: 'granted'` (set them with
  `setState`), `E_UNAVAILABLE` with `motion: 'unavailable'`; `startCapture` rejects `E_PERMISSION`
  with `location: 'none'`; `getState().armed` is the effective arming;
- `calls` logs commands and `queries` logs read-only calls, so tests can assert command order;
- delivery is synchronous by default; `asyncDelivery: true` delivers every event on a microtask
  as native always does — use it in integration tests so a host that relies on synchronous
  delivery fails in Jest rather than on a device;
- buffering before the first listener and the 300-event cap are native's.

The other controls (`emit`, `loadTrace`, `setMotionHistory`, `listenerCount`, `setLastExitInfo`,
`setIgnoringBatteryOptimizations`, `notificationState`) are documented on `FakeControls` in
`src/types.ts`; `driveSenseError(code, message)` builds a coded rejection for a hand-rolled stub.
