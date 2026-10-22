# drive-sense — the native contract

Local Expo module that records drives: 1 Hz GNSS, 25 Hz IMU reduced natively to one `FeatureRow`
per second, motion activity (for the drive's walking end), the background surface (Android
notification / iOS Live Activity hand-off), the iOS drive detector (§11) and a few utilities. This README is **binding** for the Swift (`ios/`)
and Kotlin (`android/`) implementations. The TypeScript sources are the machine-checked half of
the same contract:

| File | What it pins |
|---|---|
| `src/types.ts` | every API method, event, payload and state type; `DRIVE_SENSE_EVENTS`; `DRIVE_SENSE_METHODS`; `DRIVE_SENSE_SYNC_METHODS` |
| `src/rowSchema.ts` | what JS accepts from the bridge (`parseRow` and the result validators) |
| `src/index.ts` | the JS wrapper: argument checks, result validation, `requireOptionalNativeModule` |
| `src/fake.ts` | `createFakeDriveSense()` — the in-memory implementation every JS test runs against |
| `src/extract/*.ts` | the feature-extraction and gravity-filter **reference** the native code ports |
| `src/extract/constants.ts` | every tunable number, by the name the ports must use |
| `src/reminder/policy.ts` | the Android forgot-to-start reminder's decision policy and its constants (§10); `src/reminder/vectors.ts` is its decision table |
| `src/detect/types.ts`, `src/detect.ts` | the iOS drive detector's bridge (`DriveDetect`, §11): `DRIVE_DETECT_EVENTS`, `DRIVE_DETECT_METHODS`, the state and event types, the wrapper |
| `src/detect/policy.ts` | the detector's rules and every number (§11), mirrored by `ios/DetectPolicy.swift` and `ios/DetectEndPolicy.swift`; `src/detect/vectors.ts` is its decision table, `src/detect/selfTest.ts` the phone's diff |
| `src/detect/journal.ts` | the row journal's line format (§11) |
| `src/fakeDetect.ts` | `createFakeDriveDetect()` — the in-memory detector the host's tests run against |
| `assets/vectors/*.json` | golden vectors the ports must reproduce (`selfTest`) |
| `src/selfTest.ts` | vector validation and the native-vs-reference diff |

Where this README and the TypeScript disagree, the TypeScript wins and the README is a bug.

**iOS: drives start on their own (§11).** A native drive detector, armed by JS for a signed-in
owner with Location Always, Precise Location and Motion & Fitness, wakes on a significant move, on
leaving the spot the car last parked in, on leaving a place the phone stayed at, or when RoadWise
comes to the front; it watches with GPS while it sees a vehicle (up to 30 minutes), confirms a drive
once the speed has been held long enough (30 s at 15 mph, 15 s at 20, 10 s at 25, 5 s at 30, the
second reading from about 34 mph; stops in traffic keep what was earned), traces the drive's start
back to where the car pulled away, writes every row to a journal on disk and emits it as a
`row` with its `seq`. Start drive opens a drive at once, from the tap, journaled the same way. JS adopts the drive wherever it runs and
decides its end; native stops sensing on its own only as a safety stop. Phone use is not read: rows
carry a fixed phone sample, and the lock, screen and reminder methods answer fixed values.

**Android (frozen).** A drive starts only from a tap on Start drive: a capture runs only between a
JS `startCapture` and `stopCapture`, plus the `START_STICKY` restart of a capture the user had
already started, under the watchdog (§6), on location "While Using" through the location foreground
service. The one thing that runs with no drive open is the optional **forgot-to-start reminder**
(§10), off by default; JS no longer turns it on (a reminder left on from before is switched off once).

---

## 1. Rules for both native modules

- **Event names.** Declare exactly
  `Events("activity", "row", "speed", "screen", "thermal", "notificationAction", "call", "reminderTap", "dashpalLinkTick")` —
  keep this list **byte-identical** to `DRIVE_SENSE_EVENTS` in `src/types.ts` and to the other
  platform's list (the native text tests compare them). `call` is emitted on iOS only,
  `reminderTap` and `dashpalLinkTick` on Android only, but both platforms declare every one.
- **Methods.** Every name in `DRIVE_SENSE_METHODS` is an `AsyncFunction("<name>")` on both
  platforms, even where it is a no-op. `addListener` is the Expo event emitter's, not a
  function you declare.
- **Sync functions.** Every name in `DRIVE_SENSE_SYNC_METHODS` (`audioOutputState`, `holdAwake`,
  `dashpalLinkRunning`) is a `Function("<name>")`, never an `AsyncFunction`, on both platforms: the
  link answers a DashPal ALERT in the same JS turn it reads them, before the phone plays it. They
  never throw natively; where the native module does not exist (Jest, Expo Go) the wrapper answers
  the unknown value (no call, volume and headphones `null`; `false`; `false`).
- **Integers.** Every epoch-ms value you send (`ts`, `captureStartedAt`, `lastRowTs`,
  `MotionActivity.ts`, `ExitInfo.ts`) is a whole number of milliseconds. JS
  rejects a fractional one (`parseRow` drops the row; the result validators reject the promise).
- **Exact keys.** Payloads and results carry exactly the keys in `src/types.ts` — no extras, none
  missing. JS validates with strict schemas; an extra key makes a method reject (`row` is the one
  exception: an unknown row key is stripped and counted, §4).
- **Numbers are finite.** No NaN or ±Infinity anywhere.
- **Silence while moving (SR9).** A failed sensor, a refused foreground-service start or a lost
  fix never produces a notification, sound or modal. Record it (Android: for `getLastExitInfo`)
  and carry on or stop.
- **Nothing senses while idle.** No GPS, no IMU, no timers and no motion feed to JS between drives.
  GPS 1 Hz only while a drive records, a candidate is watched or (iOS) "Not driving?" rests the
  detector. IMU 25 Hz batched natively and reduced per second — never per sample to JS. No WorkManager
  jobs. iOS: with no drive open only the detector's wakes run (significant-location changes, one
  region, visits: no GPS). Android: nothing ever starts a capture but `startCapture`; with no drive
  open only the forgot-to-start reminder (§10) may run, if it was left on.

---

## 2. API

Types are in `src/types.ts`. "Resolves" means the promise resolves with `null`/`undefined`
(JS accepts either for `Promise<void>`).

| Method | Behaviour |
|---|---|
| `startCapture(mode)` | Start full-rate capture (1 Hz GNSS + 25 Hz IMU, rows every second; iOS `kCLLocationAccuracyBestForNavigation` with `.automotiveNavigation` and no distance filter, so Core Location fuses the motion sensors into each fix; Android the fused provider at `PRIORITY_HIGH_ACCURACY`, 1 s) in `mode` ∈ `mounted`/`pocket`/`auto`, set the persisted capture-open flag, `captureStartedAt` = now. **Also the JS claim of the Android sticky restart** (§6). While already capturing it only updates `mode` and claims — `captureStartedAt` and the rate are unchanged. A new capture takes its `ClockAnchor` (§7 "Time base"). **Requires** `location` `whenInUse` or `always`, else rejects `E_PERMISSION` and does not capture. Motion permission is not needed (the IMU needs none). Android: a `SecurityException` from the location foreground service → `E_PERMISSION`; any other refusal → `E_FGS_REFUSED`. iOS: a new capture emits `call { active: true }` once if a phone call is already in progress (later changes as they happen). Both platforms subscribe the motion-activity feed for the capture's life when `motion` is `granted`, **best effort** (Android: a `SecurityException` or missing Play services is logged and swallowed, never rejects `startCapture`, never stops the capture), for the drive's walking end. Android: only ever called from a user's tap in the foreground. **iOS:** the app's Start drive is `DriveDetect.startWaiting` (§11); while a detector drive records `startCapture` only re-modes it, while a candidate or a rest runs it starts nothing, and with nothing open it starts a **plain capture** (tests and dev tools: rows without `seq`, no journal). |
| `stopCapture(end?)` | Stop GNSS, IMU and rows; clear the capture-open flag; Android stops the foreground service (its notification goes with it) and the capture's activity-transition subscription. Idempotent. `end` (`CaptureEnd`): the drive's driving end (`drivingEndedAt`, epoch ms, or null for a drive that was not kept) and whether the car was still at driving speed as it ended (`drivingAtEnd`); sent natively as `(kind, endedAt, drivingAtEnd)` with kind `now` (no `end`), `dropped` or `at`. Android: for the reminder's session (§10); the watchdog's stop passes none (now). **iOS:** a recording detector drive's end: its journal gets `end { cause: "js", endedAt: drivingEndedAt ?? now }` (JS's cut), sensing stops, the parked region is set at the last trusted fix and detection is armed again; no `driveEnded` follows (§11). |
| `setCaptureRate(rate)` | `full` as above. `low`: coarse location (iOS `kCLLocationAccuracyHundredMeters` with **no distance filter**: iOS 16.4+ suspends an app whose location updates use one while significant-change monitoring runs; Android `PRIORITY_BALANCED_POWER_ACCURACY` at 10 s), IMU stopped, and a row is emitted **only when a fix arrives** (IMU-absent encoding, §4). The process stays alive. Ignored (resolves) while not capturing. |
| `getState()` | `DriveSenseState` (below). |
| `getScreenState()` | Android: `{ locked, on }` now (same derivation as the `screen` event). iOS: always `{ locked: false, on: true }` (nothing is read). |
| `getThermalState()` | `nominal`/`fair`/`serious`/`critical` (iOS `ProcessInfo.thermalState`; Android `PowerManager` thermal status: NONE/LIGHT → nominal, MODERATE → fair, SEVERE → serious, CRITICAL and above → critical). |
| `requestMotionPermission()` | iOS: triggers the motion prompt with a one-minute activity query; Android API 29+: requests `ACTIVITY_RECOGNITION` (below 29 it is install-time: `granted`). Resolves `granted`/`denied`/`unavailable` (hardware without motion activity). **Never rejects.** Already granted → `granted` without a prompt. When the OS will not ask again (iOS `denied`/`restricted`; Android refused with `shouldShowRequestPermissionRationale` false after a request, i.e. "don't ask again") → `denied` **without prompting**; the app must send the user to Settings. |
| `excludeFromBackup(uri)` | iOS: sets `isExcludedFromBackup` on the file or directory at `uri` (`file://` URI or a path). Android: resolves (backup exclusion is manifest-level). Rejects `E_NOT_FOUND` if nothing exists at `uri`, and `E_IO` if it exists but the attribute could not be set (iOS). JS callers treat a rejection as non-fatal. |
| `setDriveDisplay(state)` | The background surface (spec "Driving screen · Background"; plan §6). `state` = `{ speed, limit, unit, points, pointsDelta, stopped, ended?, sky…?, speedTint?, speeding?, notDrivingAvailable?, weatherKind?, weatherText? }` (`DriveDisplayState`; the last five are the iOS Live Activity's and Android ignores them). **Android:** updates the capture's foreground notification — title **"Driving"**, text **"34 mph · limit 35"** (`—` for a null speed or limit, the unit from `state`), a sub-line **"1,240 pts (+18)"** only when `points` is non-null (the delta only when non-null and non-zero), the **End drive** action (→ `notificationAction`) only while `stopped` and not `ended`; tapping opens the app. Ignored while not capturing; the display resets with each capture. **iOS:** forwarded to the Live Activity (`modules/live-drive`) through the process-local `roadwise.driveDisplay` notification (every key, the tint, the hint and the weather line included); a no-op when none is running. Callers throttle to ≤ 1 update per 3 s, send on change, and re-send an unchanged state every 60 s (keeps the Live Activity's 2-min stale date from lapsing at a long stop). Never rejects. |
| `getLastExitInfo()` | Android: the most recent of `ActivityManager.getHistoricalProcessExitReasons(pkg, 0, 1)` and the persisted watchdog record, as `ExitInfo` (mapping: `REASON_USER_REQUESTED`/`USER_STOPPED` → `user_stopped`, `LOW_MEMORY` → `low_memory`, `CRASH`/`CRASH_NATIVE` → `crash`, `ANR` → `anr`, watchdog stop → `watchdog`, a refused FGS start → `other`, anything else → `other`, unknown → `unknown`); `whileCapturing` from the persisted capture-open flag at that time. iOS: `null`. |
| `isIgnoringBatteryOptimizations()` | Android: `PowerManager.isIgnoringBatteryOptimizations(packageName)` — whether the app is exempt from battery optimisation (permission health). **iOS: always `true`** — iOS has no equivalent per-app restriction, so there is nothing for the user to fix. |
| `selfTest(vectorsJson)` | Runs the native extractor and (Android) gravity filter over golden vectors, (iOS) the drive detector's policy over `detect` rows and (Android) the reminder's over `reminder` rows; resolves a JSON string (§8). Rejects `E_INVALID_INPUT` only if the vectors JSON cannot be parsed at all. |
| `setTripReminder(enabled)` | Android: the forgot-to-start reminder's switch (§10); resolves its `TripReminderStatus`. On: saved on even when something is missing (the status says what), the session kept, the channel created. Off: everything it kept is forgotten, its feed stopped, its boot receiver disabled, any notification taken down. Never starts a capture. **iOS** (no reminder): resolves `{ enabled: false, state: 'off', missing: [] }`. |
| `getTripReminderStatus()` | Android: the reminder's `TripReminderStatus` (§10), brought up to now first. iOS: `{ enabled: false, state: 'off', missing: [] }`. |
| `requestReminderLocation()` | iOS: the current location answer (`always`/`whenInUse`/`denied`) without prompting; the one "Always" request is `DriveDetect.requestAlways` (§11). Android: `notNeeded`. |
| `claimReminderTap(token)` | Android: a tap on the reminder's note (§10): `true` once, for the live note's token, while the reminder is on, its session lasts, no drive is open and within 2 min of the tap's hand-over. `true` spends the token and takes the note down. The token must match `REMINDER_TOKEN` (`[A-Za-z0-9-]{1,64}`) before it crosses. Never starts a capture. iOS: always `false`. |
| `takeReminderTap()` | Android: the tap the phone handed RoadWise, once — `{ token, at }` (`at` = the hand-over time) — or `null`; it reads the launch intent itself when nothing is held. iOS: always `null`. |
| `markLockProof(delayMs)` | Resolves with no effect on both platforms (phone use is not tracked). The wrapper accepts a finite `delayMs` of 0–60 000 only. |
| `listInstalledApps(packages)` | The navigation button. **Android:** for each package, in the order given, `{ package, label }` when `getLaunchIntentForPackage` finds a launcher activity and the app is enabled; `label` is the app's own (`getApplicationLabel`). Only packages the module manifest's `<queries>` names are visible (API 30+ package visibility: exactly the catalogue's Android packages, `src/features/navigation/catalog.ts`; never `QUERY_ALL_PACKAGES`); any failure skips that package. **iOS:** always `[]` (navigation apps are found by URL scheme in JS). The wrapper accepts 1–32 package names, each one of the navigation apps (`NAV_APP_PACKAGES`, `src/navPackages.ts`, equal to the catalogue and the manifest's `<queries>`); native skips any other (`NavPackages.ALLOWED`). |
| `launchApp(package)` | **Android:** opens the app with its launch intent plus `FLAG_ACTIVITY_NEW_TASK \| FLAG_ACTIVITY_RESET_TASK_IF_NEEDED`, as a launcher tap does, so a route in progress is resumed, not reset; resolves `true`, or `false` for a package outside `NavPackages.ALLOWED`, with no launch intent or when the start fails. The wrapper refuses any package that is not one of the navigation apps (`NAV_APP_PACKAGES`) before the bridge. **iOS:** always `false`. |
| `setDashpalLink(state)` | DashPal alerts on the phone. **Android:** the DashPal link service, a `connectedDevice` foreground service (`DashpalLinkService`, notification id 7310 on the silent `dashpal_link` channel "DashPal link", `IMPORTANCE_LOW`: no sound, vibration or badge, a small status-bar icon; title **"DashPal"**, text **"Connected. DashPal alerts play on this phone."** for `connected`, **"Not connected. DashPal plays its alerts itself."** for `waiting`; a tap opens RoadWise), which keeps the process from being cached and frozen while a DashPal is paired, so the dashcam's frames reach JS in the background. `off`: a running service stops (its notification goes) → `stopped`; none running → `stopped`. A **running** service takes `waiting` or `connected` through its own instance (the notification text, the reconnect tick) → `running`: never a second start, so it works from the background. A **stopped** one starts only when a RoadWise activity is visible or the process is in front, and on Android 14+ `BLUETOOTH_CONNECT` is granted; otherwise, or when Android refuses the start, → `refused` (nothing started); else `running` once it is in the foreground (`refused` after 10 s without that). `START_NOT_STICKY`: a process Android ends comes back only when RoadWise is opened. While `waiting` it emits `dashpalLinkTick` every 30 s. It never touches a capture or a wake lock. **iOS:** `unsupported` (an ALERT wakes the app through `bluetooth-central`). Never rejects. |
| `audioOutputState()` | **Sync.** What a DashPal alert would play into now, read fresh: `{ callActive, volume, headphones }` (`AudioOutputState`). iOS: `CXCallObserver` calls not ended, `AVAudioSession.outputVolume` (0-1), a `.headphones` or `.usbAudio` output in the current route (an iPhone's LE output is a hearing aid). Android: the call state the rows' `call` key reads (`PhoneStateReceiver.callState`), the music stream's volume over its maximum (0 when muted), and a wired headset or headphones, a USB headset or (API 31+) an LE-audio headset among the outputs. Bluetooth A2DP (a car, earbuds), hearing aids and CarPlay are not headphones. `null` for a value that cannot be read. |
| `holdAwake(ms)` | **Sync.** **Android:** a partial wake lock (`RoadWise:DashPalAlert`, not reference counted) held for `ms` clamped to 1-10 s, each call re-arming its timeout; it always lapses by itself. `true` when held, `false` on any failure. **iOS:** `false` (an app woken by a Bluetooth notification runs while it handles it). The wrapper accepts an integer 1-10 000. |
| `dashpalLinkRunning()` | **Sync.** Android: the DashPal link service is running now (JS reads it after a runtime rebuild or a refused call instead of assuming). iOS: `false`. |

### Errors

Rejections are Expo `CodedError`s with one of the codes in `DRIVE_SENSE_ERROR_CODES`
(`src/types.ts`); the wrapper passes them through unchanged, and `isDriveSenseError(e, code)`
tests for one. Anything else a native method throws is a bug.

| Code | Methods | Meaning |
|---|---|---|
| `E_PERMISSION` | `startCapture` | no location permission at all, or (Android) the OS refused the location foreground service for lack of it |
| `E_FGS_REFUSED` | `startCapture` (Android) | the OS refused the foreground service for a reason other than permission |
| `E_NOT_FOUND` | `excludeFromBackup` (iOS) | nothing at the URI |
| `E_IO` | `excludeFromBackup` (iOS) | the file exists but `isExcludedFromBackup` could not be set |
| `E_INVALID_INPUT` | `selfTest` | the vectors JSON is unparseable |

The detector's bridge (`DriveDetect`, §11) has its own list, `DRIVE_DETECT_ERROR_CODES`: `E_BUSY`
(`discardDrive` on the drive that still records); `isDriveDetectError` tests for it.

Every other method never rejects: `stopCapture`, `setCaptureRate`, `getState`,
`getScreenState`, `getThermalState`, `requestMotionPermission`, `setDriveDisplay`,
`getLastExitInfo` (`null` below Android 11), `isIgnoringBatteryOptimizations`, `setTripReminder`,
`getTripReminderStatus`, `requestReminderLocation`, `claimReminderTap`, `takeReminderTap`,
`markLockProof`, `listInstalledApps`, `launchApp`, `setDashpalLink`; the sync functions never throw.

### `DriveSenseState`

| Field | Meaning |
|---|---|
| `capturing` | as set by `startCapture`/`stopCapture` (and by the Android sticky restart, §6). iOS: also true while a detector drive records (`recording` or `ending`), never during a candidate or a rest |
| `rate`, `mode` | the current capture's; `null` while not capturing. iOS: a detector drive reports `auto` (it started on its own) or `mounted` (from Start drive) |
| `platform` | `ios` / `android` |
| `location` | the OS location authorisation. iOS: `authorizedAlways` → `always` (asked once by `DriveDetect.requestAlways`; drives that start on their own need it, Start drive does not), `authorizedWhenInUse` → `whenInUse`, `notDetermined`/`denied`/`restricted` → `none`; reduced (approximate) accuracy reports its authorisation unchanged. Android: fine or coarse granted → `whenInUse`; neither → `none`. Android never reports `always`: the manifest declares no `ACCESS_BACKGROUND_LOCATION`. |
| `motion` | iOS: `CMMotionActivityManager.isActivityAvailable()` false → `unavailable`, else `authorizationStatus()` `authorized` → `granted`, `denied`/`restricted` → `denied`, `notDetermined` → `undetermined`. Android: no Google Play services → `unavailable`; API < 29 → `granted` (install-time); else `ACTIVITY_RECOGNITION` granted → `granted`, requested and refused → `denied`, never requested → `undetermined` (persist a "requested once" flag to tell these apart) |
| `lockSignal` | Android `reliable`; iOS always `unreliable` (it reads no lock state, §5) |
| `lockProof` | always `false` |
| `lockDelayMs` | always `null` |
| `captureWasOpen` | the persisted capture-open flag was set when this process started — a capture was open when the previous process ended (rev1: I2). iOS resumes or ends that drive from its journal (§11); the flag only reports that the process died mid-drive |
| `captureStartedAt` | integer epoch ms of the current capture's start (iOS: a detector drive's traced start); `null` while not capturing |
| `lastRowTs` | `ts` of the last row emitted in this process; `null` before any |

---

## 3. Events

| Event | Payload | When |
|---|---|---|
| `activity` | `MotionActivity` `{ type, confidence, ts, exit? }` | a motion-activity change **while capturing** (Android), **while the detector senses** (iOS: a candidate, a drive, a rest) |
| `row` | a `DriveSenseRow` (§4) | once per second while capturing at `full`; once per fix at `low`. iOS: a detector drive's rows carry their journal `seq`; a candidate's rows are never emitted (the drive's first rows, from its traced start, come at the confirmation) |
| `speed` | `SpeedSample` `{ ts, speed, speedAcc, hAcc, ageMs }` | each fix at `full` rate, the moment it lands (before its row): the fix's own time (integer epoch ms), its Doppler speed (m/s), speed accuracy (m/s) and horizontal accuracy (m), each `-1` when unknown, and `ageMs`, how old the fix already is (integer ms, ≥ 0; iOS the wall clock less `CLLocation.timestamp`, Android the capture's anchored boot clock less the fix's `elapsedRealtimeNanos`). It drives the driving screen's speed only (`src/core/engine/displaySpeed.ts`); the rows still carry every fix for scoring. Sent only while a JS listener is attached, **never buffered** (a stale speed is worthless). Validate with `parseSpeed` |
| `screen` | `{ locked, on, ts }` | Android only: lock/screen change while capturing (`SCREEN_ON`/`SCREEN_OFF`/`USER_PRESENT`). Declared on iOS, never emitted |
| `thermal` | `{ level, ts }` | a thermal-state change while capturing |
| `notificationAction` | `{ action: 'endDrive', ts }` | Android: the notification's End drive action (offered only while `setDriveDisplay` says `stopped`) |
| `call` | `{ active, ts }` | iOS only: `CXCallObserver` — a call started or ended |
| `reminderTap` | `{}` | Android only: a tap on the forgot-to-start reminder's note was handed over (§10); read it with `takeReminderTap` |
| `dashpalLinkTick` | `{}` | Android only: every 30 s while the DashPal link service runs `waiting`; JS pumps its timers with it (a reconnect back-off fires with JS timers paused). Sent only while a JS listener is attached, **never buffered** (with `speed`, the exceptions to Buffering below) |

**Motion-activity mapping** (the `activity` event). The host validates each payload with
`parseActivity` (a bad one is dropped) and hands it to the engine, whose only use for it is the
walking end (`src/core/engine/motion.ts`): a `walking`/`running` report at confidence `medium` or
above is on foot, `low` leaves the state as it was, and an `exit` or any other type clears it. So
these mappings decide whether walking can end a drive.

- **iOS** (`CMMotionActivity`): confidence maps 1:1 (`.low` → `low`, `.medium` → `medium`,
  `.high` → `high`). Several flags can be set at once; `type` is the first set flag in this order:
  `walking` → `running` → `cycling` → `automotive` → `stationary` → `unknown` (the `unknown` flag,
  or no flag at all). So `automotive && stationary` (a red light) is `automotive`. An update equal
  in type and confidence to the previous one is not re-emitted.
- **Android** (Activity Recognition Transitions API, which carries no confidence): during every
  capture the module subscribes to IN_VEHICLE, WALKING and RUNNING, ENTER and EXIT. ON_FOOT is never
  subscribed: the Transitions API supports IN_VEHICLE, ON_BICYCLE, RUNNING, STILL and WALKING only
  (WALKING and RUNNING are ON_FOOT's sub-activities), and a request naming an unsupported type
  fails whole.

  | Transition | Emitted |
  |---|---|
  | ENTER IN_VEHICLE | `{ type: 'automotive', confidence: 'high' }` |
  | ENTER WALKING | `{ type: 'walking', confidence: 'high' }` |
  | ENTER RUNNING | `{ type: 'running', confidence: 'high' }` |
  | EXIT IN_VEHICLE | nothing to JS |
  | EXIT WALKING | `{ type: 'walking', confidence: 'high', exit: true }` |
  | EXIT RUNNING | `{ type: 'running', confidence: 'high', exit: true }` |

  `exit: true` marks the END of a walk: the engine never treats it as a walk, and it clears a
  walk the ENTER began. iOS never sets `exit`.

  **The walking end** (engine, row clock). A report counts only if its walk began after the car
  was last at driving speed (two consecutive rows with a known, trusted GPS speed of 10 mph or
  more): two such rows, the second at or after the walk began, void it for good, however late the
  report arrives. W1: once the car has reached driving speed, such a report that stays the latest
  report for 5 s ends the drive unless the last known speed is over 3 mph and 60 s old or less (a
  walker's own pace, 5 mph or less from a phone that reads as carried, excepted), cut at the last
  movement at or before the walk began. W2: before driving speed, an on-foot report that stays the
  latest for 5 s ends a drive at least 10 min old (it is then dropped, never driven). Without motion permission no reports come and neither applies.

  `ts` is the transition's `getElapsedRealTimeNanos()` converted with §7 "Time base" (an anchor
  read when the transition is received). Nothing is stored. `createFakeDriveSense` has no mapping
  to do: tests emit `MotionActivity` values directly.

  **One rule for the listener** (`ActivityTransitions.sync`): one PendingIntent whose request
  matches the tier — `capture` (the set above) while capturing; the reminder's `idle` (IN_VEHICLE
  ENTER) or `session` (IN_VEHICLE ENTER and EXIT, STILL ENTER, WALKING ENTER, RUNNING ENTER) while the
  reminder is on with no drive open (§10); nothing otherwise — always with motion granted and Play
  services present. Every entry point calls it (module launch, a capture's begin and end,
  `onDestroy`, a motion grant, the reminder's switch, each reminder batch, the boot receiver). The
  requested tier is kept on file with the boot-clock time of the request: an identical re-request
  in the same boot is skipped, and the module launch and the boot receiver re-request anyway
  (`force`), so a registration the system dropped comes back. A transition that arrives when no
  tier wants the feed removes the registration and acts on nothing (C12 round 1). With no capture
  running a batch goes to the reminder natively and nothing reaches JS; while capturing, after its
  `activity` events, the same batch reaches the reminder as vehicle state only.

**Buffering.** Every event emitted while **no JS listener for that event** is attached is
buffered natively and delivered, in order, when the first listener for it attaches (Expo
`OnStartObserving`), after `addListener` returns. The buffer holds at most **300** events across
all events; when full, drop the **oldest `row`** first, else the oldest event.
(`createFakeDriveSense` implements the same rule, and `EVENT_BUFFER_MAX` in `src/fake.ts` is the number.)
iOS keeps a second buffer, with the same rule, for the `DriveDetect` module's events (§11). A row
dropped from the buffer is still in its drive's journal, where the host's `seq` check finds it.

---

## 4. The row contract (R2)

`row` payloads must pass `parseRow` (`src/rowSchema.ts`): exactly M1's `FeatureRow` keys
(`src/core/engine/types.ts`), finite numbers, booleans for the three phone flags, and `ts` a
non-negative integer epoch ms — **plus the bridge-only `mock`, `call` and (iOS) `seq`** (below). Native emits exactly those keys (pinned by
the native text tests and the golden vectors). On the JS side an **unknown key fails soft** (C0
round 1): it is stripped and counted (`unknownRowKeys()`), and the row is kept, so a future native
field can never cost an older bundle a drive's rows; a known key with a wrong type still rejects
the row. The encodings:

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
| `locked` / `screenOn` / `appForeground` | Android: the phone state at the end of the second (§5). iOS: always `false` / `true` / `true` (nothing is read) |
| **`mock`** (v3, plan §6; spec "Integrity · GPS spoofing") | a boolean beside the `FeatureRow` keys: the window's fix came from a mock location provider — Android `Location.isMock()` (API 31+) / `isFromMockProvider()` (before); iOS 15+ `sourceInformation?.isSimulatedBySoftware` (false below 15). `false` when the window has no fix. It is **not** a `FeatureRow` field: native adds it at the emit site, never in the row struct's own map, so the self-test rows (§8) keep exactly the contract's keys; `parseRow` splits it off, validates it as a boolean (a wrong type rejects the row), and returns it on `DriveSenseRow.mock`. Optional on the wire: rows from older builds parse without it, and a consumer reads absent as "not known to be mocked". |
| **`call`** (screen switches; spec "Event detection") | `"ring"` while a call rings or dials, `"live"` while one is connected, **absent** with no call, read at the emit site. **Android:** `PhoneStateReceiver.callState` from `AudioManager.getMode()`: `MODE_RINGTONE` → `ring`, `MODE_IN_CALL` → `live`, `MODE_IN_COMMUNICATION` → `live` only while `activeRecordingConfigurations` is non-empty (a VoIP call with the microphone open), no permission; the one Kotlin reading of the call state. **iOS:** `CallObserver.state()` from the capture's `CXCallObserver`: a call `hasConnected && !hasEnded` → `live`, else any `!hasEnded` → `ring`. Not a `FeatureRow` extraction field (the self-test rows and golden vectors never carry it); `parseRow` splits it off, accepts only `"ring"` / `"live"` (any other value rejects the row) and returns it on `row.call`. A call's own screen is not a screen switch (§5). |
| **`seq`** (iOS, §11) | the row's place in its drive's journal: an integer, 1 for the drive's first row (its traced start) and up by one. Not a `FeatureRow` field; `parseRow` splits it off, accepts only a positive safe integer (anything else rejects the row) and returns it on `row.seq`. The host checks each live row is the last plus one and fetches a gap from the journal (`DriveDetect.readRows`). Android rows, plain-capture rows and stored traces have none. |
| `exempt` | **never sent by native.** The drive host stamps `nav` / `restart` on a parsed row (the navigation button's and a restart's exemption, §5); a native `exempt` is stripped and counted as an unknown key. |

Units: g for accelerations, g/s for jerk, rad/s for yaw rate, rad for `orientationDelta`,
m and m/s for GNSS, degrees clockwise from true north for `course`.

---

## 5. Phone state

Phone use is not tracked. **iOS reads no phone state:** every row carries `locked: false`,
`screenOn: true`, `appForeground: true`, `getScreenState` answers `{ locked: false, on: true }`,
the `screen` event is never emitted and `getState` reports `lockSignal: 'unreliable'`,
`lockProof: false`, `lockDelayMs: null`. The keys stay because the row contract is shared with
Android and with stored traces; JS ignores them. The thermal state is still read (`thermal`,
`getThermalState`; diagnostics).

**Android (frozen)** still reports them: `locked = KeyguardManager.isKeyguardLocked`,
`screenOn = PowerManager.isInteractive`, `lockSignal: 'reliable'`, and `appForeground` is "RoadWise
is in front": `AppVisibility`, an `Application.ActivityLifecycleCallbacks` registered from
`Application.onCreate` by `DriveSensePackage` (an Expo `Package`, found by autolinking), before any
activity; the module's `OnCreate` registers late, seeded from the current activity, only if that
hook never ran. In front = at least one RoadWise activity *started* and not in split screen on a
display whose smallest width is under 600 dp. An activity stopped with `isChangingConfigurations` (a
rotation, a fold) is recreated and never counts as leaving; split screen is re-sampled on main after
every row. JS ignores these values too.

---

## 6. Watchdog (rev1: C2) — Android: capture nobody records must stop

**iOS has no watchdog:** every detector drive is journaled and resumed or ended from its journal,
and the detector's own safety stop (§11) ends a drive JS never ends. On Android only JS can decide a
drive is over, so native must not keep sensing when JS is not there:

1. **Claim within 60 s (Android).** The one capture native restarts by itself — the `START_STICKY`
   null-intent restart after the process died mid-capture, of a capture the user had started —
   must be claimed by a JS `startCapture` within **60 s**. Otherwise stop capture, clear the
   capturing and capture-open flags, stop the foreground service, and record exit reason
   `watchdog`.
2. **A row listener must exist.** While capturing, if **no JS listener for `row`** has been
   attached for **5 minutes** continuously (Expo `OnStartObserving`/`OnStopObserving` for `row`),
   do the same. The liveness signal is "a JS row listener is attached" — no JS timer or heartbeat
   is involved, and it catches exactly the failure that matters: nobody consuming rows. So the
   notification can never say "Driving" over a capture nobody records.

`startCapture` from JS always claims. The JS side's own guard is the headless task, which calls
`stopCapture` when its boot fails; the watchdog is the second line.

**Android: the headless task never outlives the drive (review N2N3 I4).** The headless service
holds a partial wake lock until its task finishes, so native owns its end too: a watchdog stop also
stops the headless service **at once** (its `onDestroy` releases the wake lock); a normal
`stopCapture` stops it after a **2-minute** grace for finalize and upload; and the task itself is
bounded (`HeadlessJsTaskConfig` timeout 6 h — never 0; if a drive outlasts it only the headless
service ends, while the capture keeps its own foreground service and wake lock). JS side: the
`DriveSenseTask` promise must settle once the capture has stopped and the drive is finalized.

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
  inside the margin. **"Arrival" has a different base on each platform:** Android measures it on
  the capture's **anchored boot clock** (next bullet), never the wall clock; iOS measures it on the
  **wall clock** (`Date()` at delivery), the same base as its row `ts` and its `CLLocation`
  timestamps (§7 "iOS: when a row closes, and what its `ts` is").
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
6. A second call sends the drive detector's decision table as `detect` vectors
   (`{ "name", "kind": "detect", "inputs": row }`, `src/detect/vectors.ts` without each row's
   `expected`); iOS runs each through the production `DetectPolicy` (`DetectSelfTest.swift`) and
   answers `{ "name", "kind": "detect", "actual": {…} }`; Android has no detector and answers
   `skipped`. JS diffs with `diffDetectSelfTest` (`src/detect/selfTest.ts`), which accepts a skip
   only from Android.
7. A third call sends the forgot-to-start reminder's decision table as `reminder` vectors; Android
   answers `{ "name", "kind": "reminder", "actual": {…} }` (or `skipped` for a row it does not run),
   iOS (no reminder) `skipped` for every row, and JS diffs with `diffReminderSelfTest` (§10).

---
## 9. JS usage

```ts
import DriveSense, { parseRow, createFakeDriveSense } from '@drive-sense';

const sub = DriveSense.addListener('row', (raw) => {
  const row = parseRow(raw); // null → drop it; row.mock → a mock-provider fix (integrity)
  if (row) engine.dispatch({ type: 'row', row });
});

// The background surface, ≤ 1 update per 3 s, on change and every 60 s while unchanged (plan §6):
await DriveSense.setDriveDisplay({ speed: 34, limit: 35, unit: 'mph', points: null, pointsDelta: null, stopped: false });
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
- `startCapture` rejects `E_PERMISSION` with `location: 'none'` (set it with `setState`);
- `setDriveDisplay` is kept (`driveDisplay`) only while capturing and cleared by `stopCapture`,
  as the Android notification is;
- `calls` logs commands and `queries` logs read-only calls, so tests can assert command order;
- delivery is synchronous by default; `asyncDelivery: true` delivers every event on a microtask
  as native always does — use it in integration tests so a host that relies on synchronous
  delivery fails in Jest rather than on a device;
- buffering before the first listener and the 300-event cap are native's, and `speed` is
  dropped, never buffered, while no listener is attached;
- iOS (`platform: 'ios'`, the default) answers the reminder methods with its fixed stubs and keeps no
  lock proof; `rowSeq: true` stamps each row with the journal's `seq` (1 and up per capture).

`createFakeDriveDetect({ available, now, asyncDelivery, sense, permissions })` (`src/fakeDetect.ts`)
is the detector's: `wake()`, `confirm()`, `emitRows()` (journaled with `seq`, and emitted through
`sense` as `row` events), `startWaiting()` (a manual drive from the tap), `waitOver()` (its wait for
driving speed is over), `endFor(cause)`, `jsStop(endedAt)`, an ndjson journal
read back by `readJournal`, settable permissions and the Always answer.

The other controls (`emit`, `loadTrace`, `listenerCount`, `setLastExitInfo`,
`setIgnoringBatteryOptimizations`, `transition`, `failCaptureSubscribe`, `strandSubscription`,
`setTripReminderEnv`, `tripReminderOn`, `postReminderForTest`, `tapReminderForTest`) are documented on
`FakeControls` in `src/types.ts`; `driveSenseError(code, message)` builds a coded rejection for a
hand-rolled stub. The fake's Android reminder runs the reference policy (`src/reminder/policy.ts`) for
its switch, status, claim and the tap's one hand-over.

---

## 10. The forgot-to-start reminder (Android only)

**Android only** (iOS drives start on their own, §11; its reminder code is gone and its methods are
fixed stubs). The app no longer offers the reminder: JS switches it off once per install
(`setTripReminder(false)`) so one left on from before stops posting. What follows is the frozen
Android behaviour. Optional, **off by default**, formerly switched on from onboarding or Settings ›
Driving (`setTripReminder`). It works in **sessions**: a session is a stretch of driving, and it ends 30 min
after its last driving moment (`SESSION_GAP_MS`); every driving moment starts the 30 min again, and
an open drive counts as driving (a session never ends while a drive is open; the drive's driving
end, which JS passes to `stopCapture`, is a driving moment, a drive that was not kept leaves the
clock alone, and the watchdog's stop, which knows nothing of the drive, uses now). Each session gets
**at most one** reminder, posted only **at a stop**, only after the car reached **driving speed with
no drive open** in that session (and after the last drive ended; a drive ended with the car still at
driving speed, `drivingAtEnd`, counts at once, opening a session if there is none, in the vehicle on
Android), and never while a drive is open. JS sets `drivingAtEnd` only when the drive's latest GPS
speed reading, at most 5 s before the end, is the second of two trusted readings in a row at 10 mph
or more: a car that slowed under 10 mph or stopped before the End tap is not driving on.
Nothing else limits it: no daily cap, no spacing, no quiet or back-off, no wait after a drive, no
minimum trip time, no check of calls, Low Power Mode or RoadWise being in front.

The note says **"Forgot to start drive?"** / **"Tap here to start"**, has no buttons and no link, and
carries a **one-use token** (a random UUID per note). **It never starts a capture**: no reminder file
can reach a capture start (`__tests__/native-*.test.ts`) and the capture tells the reminder when it
starts and ends (one direction only). A tap reaches native (the module reads `EXTRA_TAP` off the
launch intent and hands it over once, `reminderTap` + `takeReminderTap`), and `claimReminderTap(token)`
answers true once, for the live note's token, while the reminder is on, its session lasts and no
drive is open, and within 2 min of the tap's hand-over (`TAP_FRESH_MS`). True spends the token and
takes the note down. The app no longer starts a drive from a tap (the JS feature is gone).

The note comes down when a drive starts (any way), when its session ends (its system timeout falls
at the session's end), when it is claimed and when the reminder is turned off. It is **not** taken down when the car moves on, when
the driver walks off or when RoadWise comes to the front: there is one reminder a session, and it
stays tappable.

The policy is one pure reference, `src/reminder/policy.ts`, mirrored by `TripReminderPolicy.kt`
(the shared rules, the tap's hand-over and claim, the transition batch, a capture batch and the
note's timeout) under the same constant names and values (its iOS-only rules stay in the reference
and the table, unused);
`src/reminder/vectors.ts` is the decision table. Jest runs every row against the reference, and a
ground-truth simulation (`__tests__/reminderPolicy.test.ts`: days of trips, red lights, parks and
drives, delivered with each platform's delays, tier changes and replays) checks that no true
session gets two reminders, none comes during a drive, and none comes without driving speed since
the last drive; the self-test runs each row through the native mirror on the phone (below).

**State** is native only (no JS settings key): `DriveSensePrefs.tripReminderJson`, the
`ReminderState` JSON of `policy.ts` (`v: 3`). A stored v2 keeps only its switch; anything
unreadable is off. Stored times more than a day ahead are a clock change and become now.

**Self-test.** The diagnostics self-test (§8) sends each row of `vectors.ts`, without its
`expected`, as a `reminder` vector; `TripReminderSelfTest.kt` runs it through the production policy
and answers the row's `actual`, and `diffReminderSelfTest` (`src/reminder/selfTest.ts`) matches it
against the row's `expected`. Android answers the iOS-only rows with `skipped`; iOS answers every
row `skipped` (`reminderRowRunsOn('ios', …)` is false). A skip of a row the platform has fails.

### Android: activity recognition only

No location. **Driving** is the phone reporting it is in a vehicle: each IN_VEHICLE ENTER and EXIT
is a driving moment, and while the phone is in the vehicle the 30 min clock does not run.
**Driving speed** (what a stop needs) is a live IN_VEHICLE ENTER timestamped after the last drive
ended. A **stop** is a STILL ENTER at most 2 min after an IN_VEHICLE EXIT, at most 45 s old on
arrival, with nothing after it in the same batch saying the driver walked off (WALKING/RUNNING
ENTER) or drove on (IN_VEHICLE ENTER). Tiers (§3): `idle` (no session) asks only for IN_VEHICLE
ENTER, which opens a session; `session` adds IN_VEHICLE EXIT, STILL ENTER and the walking/running
ENTERs. Each batch is read whole: the replay (events before the request's stamp) as the state at
the stamp, never a stop and never driving speed (a replayed ENTER says in the vehicle, a replayed
STILL/WALKING/RUNNING says out of it); then each live event in time order, IN_VEHICLE EXIT first at
the same time, each after deciding the session's end on its own time; then the end at arrival. An
IN_VEHICLE ENTER while already in the vehicle, 30 min or more after the session's newest report, is
a lost EXIT: the old session ends there and a new one opens. While a drive is open the capture's
batches (after their `activity` events to JS) keep the vehicle state only: they never end a
session, post, mark driving speed or touch the token. The note is **silent** (channel
`trip_reminder`, no sound, no vibration, category `recommendation`) and usually shows as the car
parks. Every post and every refresh sets a positive system timeout (`setTimeoutAfter`): the
session's end out of the vehicle, 3 h after the latest batch while in it (`IN_VEHICLE_NOTE_MS`); a
timeout not ahead cancels instead. A refresh never brings back a note that is no longer up. A post
the notification manager refuses is taken back (the session may remind at its next stop). The tap
opens the launcher activity with the token; the module removes the extra at once, ignores a
relaunch from Recents (`FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`), and hands a token over at most once
(the last 8 handed over are kept, `TAP_SEEN_MAX`), so an activity recreated from its saved intent
starts nothing. Warm taps come through `OnNewIntent` (MainActivity is singleTask), cold ones through
the foreground hook (read before the reminder settles) or `takeReminderTap` itself. The feed's
request is skipped only when the same tier was requested in this boot (`Settings.Global.BOOT_COUNT`;
where the phone does not give it, a stamp ahead of the boot clock). `ReminderBootReceiver`
(BOOT_COMPLETED, MY_PACKAGE_REPLACED; unexported, disabled in the manifest, enabled with
`DONT_KILL_APP` only while the reminder is on) only re-subscribes; its replay repairs the vehicle
state. **Driving speed** also comes from the end of a drive ended while the car was still at
driving speed (`stopCapture`'s `drivingAtEnd`): the session (opened then if there is none) has
driven and is in the vehicle, so the next EXIT then STILL is a stop. Known gaps: a red light is
rarely reported (catching lights would need background location); a Play services update or data
clear can drop the registration with no broadcast (it comes back at the next app open); a force
stop or an OEM "deep sleeping" list stops it until RoadWise is opened.

### Rules

| Rule | Number |
|---|---|
| A session ends this long after its last driving moment (an open drive counts as driving) | 30 min |
| Reminders a session | at most 1 |
| Never while a drive is open; after a drive, driving speed with no drive open again, then a stop | — |
| A stop: STILL after leaving the vehicle | 2 min |
| A stop too old on arrival (Android) | 45 s |
| A tap is claimed within this of its hand-over | 2 min |
| The note's timeout while the phone is in a vehicle (Android) | 3 h |

`TripReminderStatus` (`getTripReminderStatus`): `state` `off` / `on` / `needs` (`missing`:
`motion`, `notifications`) / `unavailable` (no Play services); `enabled`, so a reminder still on
can always be switched off.

---

## 11. The iOS drive detector (`DriveDetect`)

iOS only. A second Expo module in this pod (`ios/DriveDetectModule.swift`, registered for Apple
only in `expo-module.config.json`, with the launch hook `DriveDetectAppDelegate`). Android has no
such module: JS reads `DriveDetect.available === false` as "drives start only from Start drive" and
keeps today's capture path. `src/detect/types.ts` is the binding contract; `src/detect/policy.ts`
holds every rule and number, mirrored constant for constant by `ios/DetectPolicy.swift` and
`ios/DetectEndPolicy.swift` (the native text test compares them).

### Bridge

| Method / event | Behaviour |
|---|---|
| `setArmed(armed, ownerId)` | JS's arming for the signed-in owner (at onboarding's end, at sign-in, at each foreground; off at sign-out, account switch and deletion). Resolves the `DetectState`. Detection runs only with Always, Precise and Motion & Fitness: without them the state stays `off` and `status` says `needs`. A different owner forgets the last end. Never rejects. |
| `getState()` | The `DetectState`: `armed`, `ownerId`, `state` (`off`/`armed`/`candidate`/`recording`/`ending`/`suppressed`), `origin`, the live `driveId` and `startedAt`, `since`, `waitUntil`, `lastEnd { decidedAt, cut, lat, lng, driveId }`, `suppressedUntil`, `status` (`on`/`needs`/`unavailable`/`off`) with `missing` (Location Always, Precise Location, Motion & Fitness, Background App Refresh, then Live Activities, only with `needs`), `permissions` (incl. `backgroundRefresh`, `liveActivities`, `canAskAlways`) and `journalDropped` (reported once). |
| `requestAlways()` | The one "Always" request, only from While Using, once per install (`drivesense.detect.alwaysAsked`); afterwards the current answer (`always`/`whenInUse`/`denied`) and JS offers Settings. |
| `startWaiting()` | Start drive: a manual drive opens at once, from the tap (`recording`, origin `manual`, `startSource` `wake`, journaled, `driveStarted`; an auto candidate already open gives way to it, its rows dropped); While Using and Precise are enough. It waits for driving speed (the manual trigger, 10 mph held 15 s) until `waitUntil` (5 min, `WAIT_MAX_MS`): meanwhile the safety stop never ends it on a walk, and on the still clock only once `waitUntil` has passed too (JS ends it unsaved at that deadline). `{ ok: true, waitUntil, driveId, startedAt }`, or `{ ok: false, reason: 'permission' \| 'busy' \| 'unavailable' }`. A native build from before the drive opened at the tap answers `{ ok: true, waitUntil }`: the wrapper passes it on with `driveId` and `startedAt` null. |
| `extendWaiting()` | Any touch while the Start-card drive waits: `waitUntil` = now + 5 min; `null` when it waits no more. |
| `cancelWaiting()` | Ends a manual candidate quietly (none opens any more: JS ends a waiting drive through `stopCapture`). |
| `notDriving()` | "Not driving?": the live drive is cancelled (its journal deleted, `driveEnded { cause: 'cancelled' }`) and detection rests (`suppressed`). No-op when nothing records. |
| `listDrives()` | Every journal file as a `JournaledDrive` (its start line, last seq and row time, bytes, the end if any). A file with no end that is not the live drive is an orphan (the state record lost that drive, e.g. a power loss before it was saved): it is listed as ended, cause `orphan`, at its last row (else its start), so JS adopts and finishes it like any drive native ended. Before the first unlock (the record unreadable) nothing is called an orphan. |
| `readRows(driveId, afterSeq, limit)` | The rows after `afterSeq`, in order, at most `limit` (1-600), each a `row` payload with its `seq`; `done` when the file holds no more. Keeps its place in the file, so a drain reads it once. |
| `discardDrive(driveId)` | Deletes the journal file (JS, once the drive is finalized); resolves when none exists; **rejects `E_BUSY` for the drive that still records**. |
| `wipe()` | The sign-out, device and account-switch wipes: a candidate, a wait, a drive or a rest stops (no `driveEnded`: JS ends its own drive first), every journal file goes, the record starts again empty (no owner, last end, parked region, rest or drive) and the detector is `off` until JS arms it again. Resolves once the files are gone; on Android (no module) a no-op that resolves. |
| `appForeground()` | RoadWise came to the front: an `app` wake (native also takes one on `didBecomeActive`), through the wake gate and the motion gate like a significant change, but past the rest an empty candidate left. Resolves; on Android, or a native build without it, a no-op that resolves. |
| `detectState` | every transition, with its `reason` (`armed`, `wake:slc`, `wake:app`, `linger`, `confirmed`, `timeout`, `cap`, `stillClock`, `moved`, `ended`, `notDriving`, `resumed`, …). |
| `driveStarted` | `{ driveId, origin, startedAt, startSource, startLat, startLng, continues, confirmedAt, firstSeq }` at every confirmation. |
| `driveEnded` | `{ driveId, endedAt, cause, decidedAt, lastSeq, lastRowTs }` when native ends a drive (`still`, `walking`, `limit`, `orphan`) or cancels it (`cancelled`); never for a JS end. |

The three events are buffered by their own hub (`EventHub.detect`, 300 events) until the first
listener. A drive id is a lowercase UUID (the JS `client_trip_id`); native refuses any other before
it names a file.

### States and transitions

The record (`DetectStateRecord`, UserDefaults `drivesense.detect`) is saved before each transition's
side effects; a missing read (unreadable before the first unlock after a reboot) decides nothing.

- **`off` → `armed`** when JS armed it and the three permissions hold: significant-location changes,
  visits and the parked region (`roadwise.parked`, 150 m, exit only, at the last end's place) run.
  None turns GPS on. A permission lost later turns an idle detector `off`; a drive in progress
  finishes first.
- **A wake** (`WakeSources.swift`, `DriveDetectorWatch.swift`): a significant change (the cached fix
  delivered at start, older than `SLC_STALE_MS`, is not one), leaving the parked region, leaving a
  visit within 10 min, or RoadWise coming to the front (`app`: `didBecomeActive`, or JS
  `appForeground`). The gate (`wakeGate`): armed, an owner, the permissions, idle, not resting (a
  significant change or visit within 10 min of a candidate that saw no vehicle or reached its cap),
  fewer than 6 such empty candidates in the hour. A region exit then opens a candidate at once; the
  others first read the last 3 h of motion history and need confident moving car motion in the last
  2 min with the driver not on foot (`motionGate`). The wake's background task ends at the first fix
  or after 25 s.
- **`candidate`**: navigation GPS with no distance filter, 25 Hz IMU, the live motion activity and
  rows into a ring of the last 1800 (30 min, the longest candidate); `speed` events go to JS, rows
  do not. An auto candidate watches while it sees a vehicle sign (a trusted row at 10 mph or more
  with no fresh walk, run or ride report, or a confident automotive report, a car at a light too):
  it ends 3 min after the last one (or after it opened, with none), 5 min once it holds evidence, at
  30 min whatever it sees (`cap`), or on a walk standing 20 s. One that saw no vehicle, or reached
  its cap, rests significant-change and visit wakes for 10 min; only one that saw no vehicle stays
  in the hourly cap's record; one that timed out seeing none puts the parked region where the phone
  rests (its last trusted fix). Every 5 s the detector's clock checks.
- **Confirmation** (`confirmStep`, auto): evidence. A trusted row (a valid fix within 30 m, speed
  rated 2 m/s or better or unrated) at 15 mph or more earns at 1 / hold per ms, the hold
  interpolated through 15 mph 30 s, 20 mph 15 s, 25 mph 10 s and 30 mph 5 s down to 0 at 35 mph,
  never under 1 s (`autoHoldMs`). Under 20 mph a row earns only with fresh car motion (a standing
  confident moving automotive report, or one in the last 2 min, the wake's motion history included),
  so a bike or an e-scooter in that band never confirms; a row with a confident cycling, walking or
  running report 30 s old or less earns nothing. The interval between two earning rows at most 2 s
  apart adds its length at the slower one's rate, so a lone GPS spike earns nothing and from about
  34 mph a drive confirms on the second reading. Crawling and stops keep the evidence; 5 min with
  no trusted row over 3 mph forgets it. It confirms at 1. The Start card's trigger (10 mph spanning
  15 s on the row clock, a dip under it of 5 s or less kept) ends a Start-card drive's wait for
  driving speed.
- **The start** (`startOf`): the last trusted row at or under 3 mph before the first interval that
  earned, going back past a stop shorter than 5 min the car rolled into (trusted, 5 mph or more:
  a red light, a crawl out of a jam), unless the stop was 5 min or more (a parking). A run that
  began before the oldest buffered row is traced from the first one. An auto drive whose rows begin moving starts
  when the motion history's car run began, placed at the last end when the car could have come from
  there (40 m/s plus 300 m), else at the first row. `continues` when the start is within 5 min of
  the last end's decision and 150 m of its place (a hint: JS decides a re-open itself).
- **`recording`**: a new drive id; the journal opens with its `start` line; the rows from the
  traced start are journaled and emitted with `seq` 1, 2, … (the safety stop checks from the first
  live row on, so old buffered rows never end the drive they start), then every new row; `driveStarted`;
  `capturing` true for `getState` (mode `auto` or `mounted`); the "Recording your drive" check is
  scheduled (below).
- **`ending`**: a JS end rule is overdue (5 min without movement, fix-less car time not counting;
  a walk standing 5 s with no fix over 3 mph in the last minute; 12 h; for a Start-card drive still
  waiting for driving speed, no walk, and the 5 min only once its `waitUntil` has passed). Movement again returns to
  `recording`. **The native safety stop** commits the end one minute later (`SAFETY_SLACK_MS`) if JS
  has not: the journal gets `end { cause, endedAt: decidedAt }` (native never computes a cut) and
  JS hears `driveEnded`. JS's own end (`stopCapture`) journals `end { cause: 'js', endedAt: its cut }`
  and emits nothing. Every end runs inside a background task (`drivesense.end`, 25 s), so JS can
  store the drive and post its recap. After any end: sensing off, the capture flag cleared, the Live
  Activity ended (`roadwise.driveDisplay` `ended`), the note removed, `lastEnd` and the parked region
  at the last trusted fix, `armed` again. After an automatic end (native's 5 min still or walk, or a
  JS end that a JS rule would have made by then), unless it was a Start-card drive still waiting, an
  auto candidate opens at once (`linger`: 3 min from the end, 5 once it holds evidence, whatever it sees; no hourly cap entry, no rest, no parked spot): a quick
  restart confirms near where the drive ended, and `continues` lets JS re-open the held drive.
  The walk is read as JS reads it: a confident walking or running report stands until a report of
  another kind replaces it; one at low confidence leaves a standing walk alone.
- **`suppressed`** ("Not driving?"): ten-metre GPS, no IMU, no rows, the live motion activity. It
  ends on a walk standing 20 s, after 5 min with no trusted fix over 3 mph, or at its 3 h cap; then
  GPS off, the parked region at the last fix, `armed`. `lastEnd` is not touched.
- **A relaunch** (`resumeAtLaunch`, at didFinishLaunching and at the first unlock): the wakes are
  asked for again; a candidate never survives a process; a drive whose journal's last row is 5 min
  old or less resumes (the torn tail cut off, a `gap` line, sensors on, the still clock from the
  last row; its rows go on past `RESUME_SEQ_GAP` (1000) seqs after the journal's highest, which the
  `gap` line carries as `lastSeq`, because the last unsynced rows may be gone from the file while JS
  holds them, and a seq handed out twice would make JS drop the new row as a repeat); an older one ends as an `orphan` (`driveEnded`, for JS to
  finalize); a rest resumes until its 3 h cap (measured from when it began), its still clock
  starting again at the relaunch, so a relaunch never ends it at once.

### The row journal

`<Application Support>/drivesense/journal/<driveId>.ndjson` (`RowJournal.swift`,
`RowJournalRead.swift`), excluded from backup, protected until the first unlock (rows keep landing
with the phone locked). One JSON object per line: `start` (`v: 1`, the drive's start, `confirmedAt`,
`nativeBuild`), `row` (the `row` payload with `seq`), `gap { from, to, lastSeq }` (a resume: the rows
go on after `lastSeq`), `end { endedAt, cause, decidedAt, lastRowTs, lastSeq }`. fsync on `start`, `gap`, `end` and every 30 rows; 16 MiB a drive at
most; at most 4 files (opening a fifth deletes the oldest file JS never drained, ended or orphaned,
counted in `journalDropped`). A cancelled drive's file is deleted at once. Readers drop a torn last line and
any row whose `seq` is not the last plus one (a `gap` moves the last to its `lastSeq`). No file timestamps, attribute reads or disk-space
reads (the privacy manifest declares none). `src/detect/journal.ts` reads the same format.

### The Live Activity and the "Recording your drive" note

The Live Activity is `modules/live-drive`'s. drive-sense only forwards the display state and posts
`ended` at every end. At every confirmation `DriveNotifier` schedules a check 20 s out
(`FALLBACK_NOTE_DELAY_MS`): if no Live Activity runs by then (live-drive posts
`roadwise.liveActivity` with `running`) and the drive still records, a quiet local notification goes
up: identifier `roadwise.driveRecording`, title "Recording your drive", body "Tap to open it. Not
driving? You can stop it there.", no sound, the `.active` level, thread `drive-recording`, `userInfo
{ kind: 'driveRecording', url: '/drive' }`. An activity that starts or is adopted cancels the check
and takes the note down (live-drive removes it too), and every end or cancel removes it. So the
driver sees the Live Activity (a push-to-start brings its own alert) or the note, never both.

### Permissions and battery

Location Always + Precise + Motion & Fitness for drives that start on their own; While Using +
Precise for Start drive. Background App Refresh off (Low Power Mode turns it off) is reported as a
need: iOS may then not relaunch RoadWise for a wake. The blue background-location indicator never
shows (`showsBackgroundLocationIndicator = false` on every manager). Idle costs nothing but the
wakes; a candidate is bounded (3 min without a vehicle sign, 30 min at most, 6 empty ones an hour,
the motion gate); a drive costs what a manual drive did.

### Self-test

`detect` vectors (§8): every row of `src/detect/vectors.ts` (confirmation, trace-back, start and
fallbacks, the motion summary and gate, the wake gate, a candidate's clock, the safety stop, the
rest's end, a rest resumed at a relaunch, a relaunch's decision and seq, the status) runs through the production `DetectPolicy` on the
phone (`DetectSelfTest.swift`) and is diffed by `diffDetectSelfTest`.

