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
- **Battery (design §3.5, binding).** Armed = OS-delivered wakes only, no GPS, no timers, no
  sensors. GPS 1 Hz only while capturing. IMU 25 Hz batched natively and reduced per second —
  never per sample to JS. No WorkManager jobs.

---

## 2. API

Types are in `src/types.ts`. "Resolves" means the promise resolves with `null`/`undefined`
(JS accepts either for `Promise<void>`).

| Method | Behaviour |
|---|---|
| `arm()` | Start OS-delivered wakes. iOS: significant-change monitoring + one 150 m exit region re-centred on every wake's own location; live `CMMotionActivityManager` updates → `activity`. Android: `requestActivityTransitionUpdates` (IN_VEHICLE, WALKING enter/exit; `PendingIntent` `FLAG_MUTABLE` on API 31+); persisted armed flag for `BootReceiver`. **No GPS.** Idempotent. |
| `disarm()` | Stop the wakes and clear the persisted armed flag. Does **not** stop a capture in progress. Idempotent. |
| `startCapture(mode)` | Start full-rate capture (1 Hz GNSS + 25 Hz IMU, rows every second) in `mode` ∈ `mounted`/`pocket`/`auto`, set the persisted capture-open flag, `captureStartedAt` = now. **Also the JS claim of a natively started capture** (§6). While already capturing it only updates `mode` and claims — `captureStartedAt` and the rate are unchanged. |
| `stopCapture()` | Stop GNSS, IMU and rows; clear the capture-open flag; Android stops the foreground service. Idempotent. |
| `setCaptureRate(rate)` | `full` as above. `low`: coarse location (iOS `kCLLocationAccuracyHundredMeters`, `distanceFilter = 50`; Android `PRIORITY_BALANCED_POWER_ACCURACY` at 10 s), IMU stopped, and a row is emitted **only when a fix arrives** (IMU-absent encoding, §4). The process stays alive. Ignored (resolves) while not capturing. |
| `getState()` | `DriveSenseState` (below). |
| `queryMotionHistory(fromTs, toTs)` | Activities with `fromTs ≤ ts ≤ toTs`, oldest first. iOS: `queryActivityStarting`. Android: the transitions buffered natively over the last 24 h (`TransitionStore`). |
| `getScreenState()` | `{ locked, on }` now (same derivation as the `screen` event). |
| `getThermalState()` | `nominal`/`fair`/`serious`/`critical` (iOS `ProcessInfo.thermalState`; Android `PowerManager` thermal status: NONE/LIGHT → nominal, MODERATE → fair, SEVERE → serious, CRITICAL and above → critical). |
| `requestMotionPermission()` | iOS: triggers the motion prompt with a one-minute activity query; Android API 29+: requests `ACTIVITY_RECOGNITION` (below 29 it is install-time: `granted`). Resolves `granted`/`denied`/`unavailable` (hardware without motion activity). |
| `excludeFromBackup(uri)` | iOS: sets `isExcludedFromBackup` on the file or directory at `uri` (`file://` URI or a path). Android: resolves (backup exclusion is manifest-level). Rejects if the file does not exist (iOS). JS callers treat a rejection as non-fatal. |
| `setNotificationState({ stationary, startedAt })` | Android S3: `stationary: true` adds the **End drive** action (→ `notificationAction`); `false` removes it. `startedAt` drives "Recording drive · N min" (updated once a minute). iOS: no-op, resolves. |
| `getLastExitInfo()` | Android: the most recent of `ActivityManager.getHistoricalProcessExitReasons(pkg, 0, 1)` and the persisted watchdog record, as `ExitInfo` (mapping: `REASON_USER_REQUESTED`/`USER_STOPPED` → `user_stopped`, `LOW_MEMORY` → `low_memory`, `CRASH`/`CRASH_NATIVE` → `crash`, `ANR` → `anr`, watchdog stop → `watchdog`, a refused FGS start → `other`, anything else → `other`, unknown → `unknown`); `whileCapturing` from the persisted capture-open flag at that time. iOS: `null`. |
| `isIgnoringBatteryOptimizations()` | Android: `PowerManager.isIgnoringBatteryOptimizations(packageName)` — whether background drive detection survives Doze (M4 permission health). **iOS: always `true`** — iOS has no equivalent per-app restriction, so there is nothing for the user to fix. |
| `selfTest(vectorsJson)` | Runs the native extractor and (Android) gravity filter over golden vectors; resolves a JSON string (§8). |

### `DriveSenseState`

| Field | Meaning |
|---|---|
| `armed`, `capturing` | as set by the methods above (and by a native restart, §6) |
| `rate`, `mode` | the current capture's; `null` while not capturing |
| `platform` | `ios` / `android` |
| `location` | `none` / `whenInUse` / `always` (the OS authorisation) |
| `motion` | `granted` / `denied` / `undetermined` / `unavailable` |
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
| `ts` | the end of the second the row closes, integer epoch ms |
| unknown `speed` / `speedAcc` / `course` | `-1` |
| no fix in the second | `lat`/`lng`/`alt` of the last fix of any quality (`0`/`0`/`0` before any), `hAcc = 9999`, `speed = speedAcc = course = -1`, `gnssValid = false` |
| fix with unknown accuracy (platform reports negative) | `hAcc = 9999`, `gnssValid = false` |
| `gnssValid` | a fix arrived in the second ∧ `0 ≤ hAcc ≤ GNSS_MAX_HACC_M` (50 m) ∧ age at `ts` ≤ `GNSS_MAX_AGE_S` (1.5 s) |
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

State `{ g, t }`, initially `{ null, null }`, carried across batches. Per raw sample, in order:

```
dt = (t − t_prev) / 1000                       (0 when t_prev is null)
if g is null or dt ≤ 0 or dt > GRAVITY_RESET_GAP_S (1 s):   g = a            (seed)
else:
    g_pred = g + (g × w)·dt                    (dg/dt = −w × g: gravity is fixed in the world)
    α      = GRAVITY_TAU_S / (GRAVITY_TAU_S + dt)            (GRAVITY_TAU_S = 0.5 s)
    g      = α·g_pred + (1 − α)·a
ua = a − g
emit { t, ua, g, w }
```

`g` is not renormalised. Batch boundaries do not change the output.

### Grouping samples into seconds

Every second closes at `tsMs` (the timer instant, rounded to an integer for the row). Its IMU
samples are those with sensor timestamp `t` in `(tsMs − 1000, tsMs]`, oldest first — group by the
**sensor timestamp** converted to epoch ms, not by arrival time (Android batches up to 1 s late:
the row for a second may be emitted up to ~1 s after it closes, with the same `ts`). Its fix is
the **last fix that arrived during the second**, or none. Never reuse a fix in a later second.

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
| `GRAVITY_TAU_S` | 0.5 | gravity filter time constant |
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
| `gravity-filter` | the Android filter on raw accel + gyro, with a re-seeding gap |

Regenerate after changing the reference or a constant (never by hand):

```
node --experimental-strip-types --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON modules/drive-sense/scripts/make-vectors.ts
```

`__tests__/vectors.test.ts` fails if a committed file differs from a fresh generation or if any
`expected` differs from the reference over its `inputs`. Vectors are loaded only by the
diagnostics screen (U5) — never by a production code path.

### Self-test protocol

1. JS (U5) reads the vector files and calls `DriveSense.selfTest(JSON.stringify(vectors))` —
   a JSON **array** of vector objects as above (`parseVectors` validates them first).
2. Native parses the array, and for each vector runs its own port over `inputs` exactly as
   `runVector` in `src/extract/vectors.ts` does (fresh state per vector). `expected` is ignored.
   Android runs every vector. iOS has no gravity filter (CoreMotion supplies gravity), so it
   answers each `gravityFilter` vector with the `skipped` form and runs every `extract` vector.
3. Native resolves a JSON string:
   ```jsonc
   { "version": 1, "platform": "ios" | "android",
     "results": [ { "name", "kind": "extract", "rows": [FeatureRow, …] }
                | { "name", "kind": "gravityFilter", "batches": [[ImuSample, …], …] }
                | { "name", "kind", "error": "message" }
                | { "name", "kind": "gravityFilter", "skipped": "reason" } ] }   // one per input vector, in order
   ```
   A vector that throws natively yields the `error` form; the promise rejects only if the input
   is not parseable at all.
4. JS diffs with `diffSelfTest(vectors, outputJson)` (`src/selfTest.ts`): every number within
   `SELF_TEST_TOLERANCE`, every boolean and array length exact, no missing or extra keys; the
   first 20 mismatches per vector are listed by path (`rows[8].aLonMin`). A `skipped` result is
   accepted only for a `gravityFilter` vector on `platform: "ios"`; anywhere else it fails.

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
inert subscription — tests inject `createFakeDriveSense({ platform, now })` instead. The fake's
extra controls (`emit`, `loadTrace`/`step`/`drain`, `calls`, `setState`, `setMotionHistory`,
`listenerCount`, `setLastExitInfo`, `setIgnoringBatteryOptimizations`, `notificationState`) are
documented on `FakeControls` in `src/types.ts`.
