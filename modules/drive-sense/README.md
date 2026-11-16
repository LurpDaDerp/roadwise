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
once the speed has been held long enough ((5/3)·(30 − mph) s over 15 mph: 25 s just over 15, 5 s
less for every 3 mph faster, the second reading in a row from 30 mph; stops in traffic keep what was
earned), traces the drive's start
back to where the car pulled away, writes every row to a journal on disk and emits it as a
`row` with its `seq`. Start drive opens a drive at once, from the tap, journaled the same way. JS adopts the drive wherever it runs and
decides its end; native stops sensing on its own only as a safety stop. Phone use is not read: rows
carry a fixed phone sample, and the lock, screen and reminder methods answer fixed values.

**Android.** The same drive detector in Kotlin (`DriveDetectModule.kt`, `detect/*`; §11 "Android"),
with the same rules and numbers, without the car link yet: its wakes are Play services' activity
transitions (a confident in-a-vehicle report), the parked car's geofence and RoadWise coming to the
front; a watch and a drive run in the location foreground service, a watch under a silent "Checking
for a drive" notification. A plain capture (a JS `startCapture` and `stopCapture`, plus its
`START_STICKY` restart under the watchdog, §6) is for tests and dev tools. The forgot-to-start
reminder is retired (§10).

---

## 1. Rules for both native modules

- **Event names.** Declare exactly
  `Events("activity", "row", "speed", "screen", "thermal", "notificationAction", "call", "reminderTap", "dashpalLinkTick")` —
  keep this list **byte-identical** to `DRIVE_SENSE_EVENTS` in `src/types.ts` and to the other
  platform's list (the native text tests compare them). `dashpalLinkTick` is emitted on Android
  only and `reminderTap` never (the reminder is retired), but both platforms declare every one.
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
  region, visits: no GPS). Android: with no drive open only the detector's wakes run (Play services'
  activity transitions and one geofence, delivered to a stopped app: no GPS, no service, no polling).

---

## 2. API

Types are in `src/types.ts`. "Resolves" means the promise resolves with `null`/`undefined`
(JS accepts either for `Promise<void>`).

| Method | Behaviour |
|---|---|
| `startCapture(mode)` | Start full-rate capture (1 Hz GNSS + 25 Hz IMU, rows every second; iOS `kCLLocationAccuracyBestForNavigation` with `.automotiveNavigation` and no distance filter, so Core Location fuses the motion sensors into each fix; Android the fused provider at `PRIORITY_HIGH_ACCURACY`, 1 s) in `mode` ∈ `mounted`/`pocket`/`auto`, set the persisted capture-open flag, `captureStartedAt` = now. **Also the JS claim of the Android sticky restart** (§6). While already capturing it only updates `mode` and claims — `captureStartedAt` and the rate are unchanged. A new capture takes its `ClockAnchor` (§7 "Time base"). **Requires** `location` `whenInUse` or `always`, else rejects `E_PERMISSION` and does not capture. Motion permission is not needed (the IMU needs none). Android: a `SecurityException` from the location foreground service → `E_PERMISSION`; any other refusal → `E_FGS_REFUSED`. iOS: a new capture emits `call { active: true }` once if a phone call is already in progress (later changes as they happen). Both platforms subscribe the motion-activity feed for the capture's life when `motion` is `granted`, **best effort** (Android: a `SecurityException` or missing Play services is logged and swallowed, never rejects `startCapture`, never stops the capture), for the drive's walking end. Android: only ever called from a user's tap in the foreground. **iOS:** the app's Start drive is `DriveDetect.startWaiting` (§11); while a detector drive records `startCapture` only re-modes it, while a candidate or a rest runs it starts nothing, and with nothing open it starts a **plain capture** (tests and dev tools: rows without `seq`, no journal). |
| `stopCapture(end?)` | Stop GNSS, IMU and rows; clear the capture-open flag; Android stops the foreground service (its notification goes with it) and the capture's live activity reports. Idempotent. `end` (`CaptureEnd`): the drive's driving end (`drivingEndedAt`, epoch ms, or null for a drive that was not kept) and whether the car was still at driving speed as it ended (`drivingAtEnd`); sent natively as `(kind, endedAt, drivingAtEnd)` with kind `now` (no `end`), `dropped` or `at`. The watchdog's stop passes none (now). **Both platforms:** a recording detector drive's end: its journal gets `end { cause: "js", endedAt: drivingEndedAt ?? now }` (JS's cut), sensing stops, the parked region is set at the last trusted fix and detection is armed again (after an automatic end the linger's watch follows); no `driveEnded` follows (§11). |
| `setCaptureRate(rate)` | `full` as above. `low`: coarse location (iOS `kCLLocationAccuracyHundredMeters` with **no distance filter**: iOS 16.4+ suspends an app whose location updates use one while significant-change monitoring runs; Android `PRIORITY_BALANCED_POWER_ACCURACY` at 10 s), IMU stopped, and a row is emitted **only when a fix arrives** (IMU-absent encoding, §4). The process stays alive. Ignored (resolves) while not capturing. |
| `getState()` | `DriveSenseState` (below). |
| `getScreenState()` | Android: `{ locked, on }` now (same derivation as the `screen` event). iOS: always `{ locked: false, on: true }` (nothing is read). |
| `getThermalState()` | `nominal`/`fair`/`serious`/`critical` (iOS `ProcessInfo.thermalState`; Android `PowerManager` thermal status: NONE/LIGHT → nominal, MODERATE → fair, SEVERE → serious, CRITICAL and above → critical). |
| `requestMotionPermission()` | iOS: triggers the motion prompt with a one-minute activity query; Android API 29+: requests `ACTIVITY_RECOGNITION` (below 29 it is install-time: `granted`). Resolves `granted`/`denied`/`unavailable` (hardware without motion activity). **Never rejects.** Already granted → `granted` without a prompt. When the OS will not ask again (iOS `denied`/`restricted`; Android refused with `shouldShowRequestPermissionRationale` false after a request, i.e. "don't ask again") → `denied` **without prompting**; the app must send the user to Settings. |
| `excludeFromBackup(uri)` | iOS: sets `isExcludedFromBackup` on the file or directory at `uri` (`file://` URI or a path). Android: resolves (backup exclusion is manifest-level). Rejects `E_NOT_FOUND` if nothing exists at `uri`, and `E_IO` if it exists but the attribute could not be set (iOS). JS callers treat a rejection as non-fatal. |
| `setDriveDisplay(state)` | The background surface (spec "The Live Activity"; plan §6). `state` = `{ speed, limit, unit, points, pointsDelta, stopped, ended?, sky…?, speedTint?, speeding?, notDrivingAvailable?, weatherKind?, weatherText? }` (`DriveDisplayState`); `points`, `pointsDelta` and `stopped` are shown on neither platform. **Android:** the capture's drive notification, Android's Live Activity (`NotificationFactory`, `DriveNotificationController`, ruling 6): title the speed and its unit, **"34 mph"** (`-` for a null speed), the number in `speedTint`; text **"Limit 35"** (`Limit -`), then the weather line (a weather emoji for `weatherKind`, `WeatherSymbol`, and `weatherText`; only with both) and **"Not driving?"** while `notDrivingAvailable`, joined by ` · ` collapsed and one per line expanded (BigTextStyle); the large icon is the limit as the driving screen's sign (the US SPEED LIMIT plate in mph, the round red-ringed sign in km/h, `-` when unknown; `LimitSignBitmap`, the widget's proportions); the ticker is VoiceOver's words (`Speed 34 miles per hour, over the limit. Speed limit 35. Heavy rain. Not driving?`), which Android announces to TalkBack once, as the notification first appears (updates never alert; in the shade TalkBack reads the title and text); a tap opens `roadwise://drive` (the launcher's intent if nothing takes it); no action buttons. Channel `drive_live` "Drive in progress": `IMPORTANCE_DEFAULT`, no sound, vibration, lights or badge, public on the lock screen (the low-importance `drive_recording` is deleted); `setOnlyAlertOnce`, `FOREGROUND_SERVICE_IMMEDIATE`; the small icon is the app's `expo.modules.notifications.default_notification_icon` (the RoadWise mark), else the module's `ic_drive_notification` (the mark as strokes). On Android 16 QPR1+ (`SDK_INT_FULL` ≥ 36.1) with `NotificationManagerCompat.canPostPromotedNotifications()` (`POST_PROMOTED_NOTIFICATIONS` is declared) it asks to be a **Live Update** (`setRequestPromotedOngoing`, chip text `"34 mph"` or the number alone past 7 characters, not colorized, `setColor(accent ?: #FFC300)`); otherwise it is colorized in `skyMid` (navy `#001D3D` without one). Posted only when what it shows changed (a content key; an unchanged keepalive only re-arms the timer); after **2 min** with no call it shows its stale form (speed `-`, no tint, hint or weather; limit, unit and sky kept). Swiped away (Android 14+; its delete intent reaches an unexported receiver registered at runtime), it is not re-posted until a RoadWise activity starts (`AppVisibility`) or the next capture starts. The newest state is kept on disk with the capture's start, so a `START_STICKY` restart shows it at once (its stale form when over 2 min old); only that restart restores it, and a new capture starts empty and forgets it; the stale timer goes by the newest state's age, so an update that lands as it fires is never marked stale; `ended` posts nothing more and forgets it. Ignored while not capturing. **iOS:** forwarded to the Live Activity (`modules/live-drive`) through the process-local `roadwise.driveDisplay` notification (every key, the tint, the hint and the weather line included); a no-op when none is running. Callers (src/drive/display.ts) pace both alike: a new speed number at most every 5 s, the tint alone 15 s after the last update, anything else a second after it, the drive's first known speed and limit, the hint and the weather line at once, and an unchanged state again every 60 s (keeps either from going stale at a long stop). Never rejects. |
| `getLastExitInfo()` | Android: the most recent of `ActivityManager.getHistoricalProcessExitReasons(pkg, 0, 1)` and the persisted watchdog record, as `ExitInfo` (mapping: `REASON_USER_REQUESTED`/`USER_STOPPED` → `user_stopped`, `LOW_MEMORY` → `low_memory`, `CRASH`/`CRASH_NATIVE` → `crash`, `ANR` → `anr`, watchdog stop → `watchdog`, a refused FGS start → `other`, anything else → `other`, unknown → `unknown`); `whileCapturing` from the persisted capture-open flag at that time. iOS: `null`. |
| `isIgnoringBatteryOptimizations()` | Android: `PowerManager.isIgnoringBatteryOptimizations(packageName)` — whether the app is exempt from battery optimisation (permission health). **iOS: always `true`** — iOS has no equivalent per-app restriction, so there is nothing for the user to fix. |
| `selfTest(vectorsJson)` | Runs the native extractor and (Android) gravity filter over golden vectors, the drive detector's policy over `detect` rows (both platforms); resolves a JSON string (§8). Rejects `E_INVALID_INPUT` only if the vectors JSON cannot be parsed at all. |
| `setTripReminder(enabled)` | The retired forgot-to-start reminder (§10): resolves `{ enabled: false, state: 'off', missing: [] }` on both platforms and changes nothing (the bootstrap's one switch-off of an older install's reminder). |
| `getTripReminderStatus()` | Retired: `{ enabled: false, state: 'off', missing: [] }` on both platforms. |
| `requestReminderLocation()` | The current location answer (`always`/`whenInUse`/`denied`) without prompting, on both platforms; the "Always" request is `DriveDetect.requestAlways` (§11). |
| `claimReminderTap(token)` | Retired: always `false`. |
| `takeReminderTap()` | Retired: always `null`. |
| `markLockProof(delayMs)` | Resolves with no effect on both platforms (phone use is not tracked). The wrapper accepts a finite `delayMs` of 0–60 000 only. |
| `listInstalledApps(packages)` | The navigation button. **Android:** for each package, in the order given, `{ package, label }` when `getLaunchIntentForPackage` finds a launcher activity and the app is enabled; `label` is the app's own (`getApplicationLabel`). Only packages the module manifest's `<queries>` names are visible (API 30+ package visibility: exactly the catalogue's Android packages, `src/features/navigation/catalog.ts`; never `QUERY_ALL_PACKAGES`); any failure skips that package. **iOS:** always `[]` (navigation apps are found by URL scheme in JS). The wrapper accepts 1–32 package names, each one of the navigation apps (`NAV_APP_PACKAGES`, `src/navPackages.ts`, equal to the catalogue and the manifest's `<queries>`); native skips any other (`NavPackages.ALLOWED`). |
| `launchApp(package)` | **Android:** opens the app with its launch intent plus `FLAG_ACTIVITY_NEW_TASK \| FLAG_ACTIVITY_RESET_TASK_IF_NEEDED`, as a launcher tap does, so a route in progress is resumed, not reset; resolves `true`, or `false` for a package outside `NavPackages.ALLOWED`, with no launch intent or when the start fails. The wrapper refuses any package that is not one of the navigation apps (`NAV_APP_PACKAGES`) before the bridge. **iOS:** always `false`. |
| `setDashpalLink(state)` | DashPal alerts on the phone. **Android:** the DashPal link service, a `connectedDevice` foreground service (`DashpalLinkService`, notification id 7310 on the silent `dashpal_link` channel "DashPal link", `IMPORTANCE_LOW`: no sound, vibration or badge, a small status-bar icon; title **"DashPal"**, text **"Connected. DashPal alerts play on this phone."** for `connected`, **"Not connected. DashPal plays its alerts itself."** for `waiting`; a tap opens RoadWise), which keeps the process from being cached and frozen while a DashPal is paired, so the dashcam's frames reach JS in the background. `off`: a running service stops (its notification goes) → `stopped`; none running → `stopped`. A **running** service takes `waiting` or `connected` through its own instance (the notification text, the reconnect tick) → `running`: never a second start, so it works from the background. A **stopped** one starts only when a RoadWise activity is visible or the process is in front, and on Android 14+ `BLUETOOTH_CONNECT` is granted; otherwise, or when Android refuses the start, → `refused` (nothing started); else `running` once it is in the foreground (`refused` after 10 s without that). `START_NOT_STICKY`: a process Android ends comes back only when RoadWise is opened. While `waiting` it emits `dashpalLinkTick` every 30 s. It never touches a capture or a wake lock. **iOS:** `unsupported` (an ALERT wakes the app through `bluetooth-central`). Never rejects. |
| `audioOutputState()` | **Sync.** What a DashPal alert would play into now, read fresh: `{ callActive, volume, headphones }` (`AudioOutputState`). iOS: `CXCallObserver` calls not ended, `AVAudioSession.outputVolume` (0-1), a `.headphones` or `.usbAudio` output in the current route (an iPhone's LE output is a hearing aid). Android: the call state the rows' `call` key reads (`PhoneStateReceiver.callState`), the music stream's volume over its maximum (0 when muted), and a wired headset or headphones, a USB headset or (API 31+) an LE-audio headset among the outputs. Bluetooth A2DP (a car, earbuds), hearing aids and CarPlay are not headphones. `null` for a value that cannot be read. |
| `holdAwake(ms)` | **Sync.** **Android:** a partial wake lock (`RoadWise:DashPalAlert`, not reference counted) held for `ms` clamped to 1-10 s, each call re-arming its timeout; it always lapses by itself. `true` when held, `false` on any failure. **iOS:** `false` (an app woken by a Bluetooth notification runs while it handles it). The wrapper accepts an integer 1-10 000. |
| `dashpalLinkRunning()` | **Sync.** Android: the DashPal link service is running now (JS reads it after a runtime rebuild or a refused call instead of assuming). iOS: `false`. |

### Android only: share images and the geocoder

Not in `DRIVE_SENSE_METHODS` (the iOS module has none of them): `ANDROID_SHARE_METHODS`
(`src/share.ts`), `ANDROID_GEOCODE_METHODS` (`src/geocode.ts`) and `ANDROID_UNUSED_APP_METHODS`
(`src/unusedApps.ts`), each reached through a wrapper or a feature check that answers `null` (or
leaves the row out) where the build has no such function (iOS, Jest, an older Android build), so
the caller keeps its own path. None of them rejects but `getUnusedAppRestrictions` (`E_IO`).

| Method | Behaviour |
|---|---|
| `shareImage(uri, text, title)` | The system chooser with the image at `uri` (a `file://` URI or a path; only a `.png`/`.jpg`/`.jpeg` inside the app's cache directory, after resolving links and `..`; a react-native-view-shot capture in the external cache is first moved into the cache, off the main thread, and the chooser then starts on the main thread) as a content URI of `ShareFileProvider` (`${applicationId}.drivesense.share`, `<cache-path>` only, not exported) in `EXTRA_STREAM` and the ClipData with a read grant, `text` in `EXTRA_TEXT` when given, `title` over the sheet. **Save image** on Android 10+: a chooser custom action on 14+ (an explicit, immutable broadcast to the unexported `SaveImageReceiver`), the sheet's first row on 10 to 13 (the unexported, translucent `SaveImageActivity`, which the chooser starts as RoadWise); both copy the image into `Pictures/RoadWise` through MediaStore (written pending, then published; no storage permission) and toast **"Image saved"** or **"Couldn't save the image. Try again."**. Below 10 there is no Save image. Resolves `true` once the sheet is up, `false` with no activity on screen or a file that is not a share image. The file is left in place: JS sweeps shared files 10 minutes old (`sweepStaleShareFiles`). |
| `reverseGeocode(lat, lng)` | `android.location.Geocoder` at the point (the `GeocodeListener` form on API 33+; below it the blocking call on a pool of two background threads, so a drive's start and end labels go side by side, with a lookup whose timeout passed while it waited skipped), with no activity, so it answers with RoadWise behind or headless. Resolves expo-location's address shape (`city`, `district`, `streetNumber`, `street`, `region`, `subregion`, `country`, `postalCode`, `name`, `isoCountryCode`; `district` = the sub-locality, else the feature's name when it has letters, no digit or comma, and is not the street, city, county, state, postcode or country again), `[]` for none, `null` when `Geocoder.isPresent()` is false, on a failure or after 5 s. |
| `forwardGeocode(query)` | The same geocoder for a typed address (1-200 characters): `[{ latitude, longitude }]`, `[]` for none, `null` as above. |
| `getUnusedAppRestrictions()` | Android 11+'s "Pause app activity if unused" for RoadWise, from androidx.core's `PackageManagerCompat.getUnusedAppRestrictionsStatus` (a future, never waited on: its listener runs on the thread that completes it): `'enabled'` (API_30_BACKPORT, API_30, API_31), `'disabled'` (DISABLED), `'unavailable'` (FEATURE_NOT_AVAILABLE). Rejects `E_IO` on its ERROR or with no answer in 5 s. |
| `openUnusedAppRestrictionsSettings()` | The page with that switch (`IntentCompat.createManageUnusedAppRestrictionsIntent`: the app's info page on 12+, its permissions page on 11), started on the main thread. `true` once started, `false` where the phone has no such page (JS then opens the app's settings page). |

### Errors

Rejections are Expo `CodedError`s with one of the codes in `DRIVE_SENSE_ERROR_CODES`
(`src/types.ts`); the wrapper passes them through unchanged, and `isDriveSenseError(e, code)`
tests for one. Anything else a native method throws is a bug.

| Code | Methods | Meaning |
|---|---|---|
| `E_PERMISSION` | `startCapture` | no location permission at all, or (Android) the OS refused the location foreground service for lack of it |
| `E_FGS_REFUSED` | `startCapture` (Android) | the OS refused the foreground service for a reason other than permission |
| `E_NOT_FOUND` | `excludeFromBackup` (iOS) | nothing at the URI |
| `E_IO` | `excludeFromBackup` (iOS); `getUnusedAppRestrictions` (Android) | the file exists but `isExcludedFromBackup` could not be set; the phone could not say whether "Pause app activity if unused" is on |
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
| `speed` | `SpeedSample` `{ ts, speed, speedAcc, hAcc, ageMs }` | each fix at `full` rate, the moment it lands (before its row; iOS: only while a capture is open, never during a watch): the fix's own time (integer epoch ms), its Doppler speed (m/s), speed accuracy (m/s) and horizontal accuracy (m), each `-1` when unknown, and `ageMs`, how old the fix already is (integer ms, ≥ 0; iOS the wall clock less `CLLocation.timestamp`, Android the capture's anchored boot clock less the fix's `elapsedRealtimeNanos`). It drives the driving screen's speed only (`src/core/engine/displaySpeed.ts`); the rows still carry every fix for scoring. Sent only while a JS listener is attached, **never buffered** (a stale speed is worthless). Validate with `parseSpeed` |
| `screen` | `{ locked, on, ts }` | Android only: lock/screen change while capturing (`SCREEN_ON`/`SCREEN_OFF`/`USER_PRESENT`). Declared on iOS, never emitted |
| `thermal` | `{ level, ts }` | a thermal-state change while capturing |
| `notificationAction` | `{ action: 'endDrive', ts }` | Declared for the contract; never sent (neither the Live Activity nor Android's drive notification has a button) |
| `call` | `{ active, ts }` | a call started or ended **while capturing**: once at the start for a call already up, on each change, and `active: false` at the stop for a call still up. `active` is a call ringing, dialling or connected. iOS: `CXCallObserver`. Android: the call state the rows' `call` key reads (`PhoneStateReceiver.callState`), re-read on the audio-mode listener (API 31+), the recording callback (a VoIP call opening or closing its microphone) and, below API 31, at each row; no permission. Buffered like a row |
| `reminderTap` | `{}` | Declared for the contract; never sent (the forgot-to-start reminder is retired, §10) |
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
- **Android** (Play services' activity recognition, `requestActivityUpdates` every 5 s while a
  capture senses: a watch, a drive, a plain capture; never while idle or resting). Each report is a
  list of activities rated 0-100; `type` is the most probable one: IN_VEHICLE → `automotive`,
  ON_BICYCLE → `cycling`, WALKING → `walking`, RUNNING → `running`, ON_FOOT → whichever of walking
  and running the report rates higher (walking when neither is listed), STILL → `stationary`,
  anything else (TILTING, UNKNOWN) → `unknown`; its confidence under 50 is `low`, 50 to 74 `medium`,
  75 and up `high`. Every report goes to the drive detector first (its safety stop, the watch's
  vetoes, car motion and slow traffic); JS hears it only while a drive or a plain capture records
  (never during a watch), and an update equal in type and confidence to the previous one is not
  re-emitted. `ts` is the report's `elapsedRealtimeMillis` converted with §7 "Time base" (never
  after its arrival). Android never sets `exit`.

  **The walking end** (engine, row clock). A report counts only if its walk began after the car
  was last at driving speed (two consecutive rows with a known, trusted GPS speed of 10 mph or
  more): two such rows, the second at or after the walk began, void it for good, however late the
  report arrives. W1: once the car has reached driving speed, such a report that stays the latest
  report ends the drive 10 s after its walk began (its `ts`), once it has stood 3 s since it
  arrived, unless the last known speed is over 3 mph and 15 s old or less (a walker's own pace,
  5 mph or less from a phone that reads as carried, excepted), cut at the last movement at or
  before the walk began. W2: before driving speed, an on-foot report that stays the latest as long
  ends a drive at least 10 min old (it is then dropped, never driven). Without motion permission no reports come and neither applies.

  The activity transitions (IN_VEHICLE in and out, the ENTERs of WALKING, RUNNING, ON_BICYCLE and
  STILL) are the Android drive detector's own (§11 "Android"): its motion history, its wake and the
  "Not driving?" rest. They never reach JS. `createFakeDriveSense` has no mapping to do: tests emit
  `MotionActivity` values directly.

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
non-negative integer epoch ms — **plus the bridge-only `mock`, `call`, `steps` and (iOS) `seq`** (below). Native emits exactly those keys (pinned by
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
| **`steps`** (spec "How a drive ends": the step walk) | the pedometer's count since it started for this drive, a whole number from 0, **absent** before its first count, without Motion & Fitness (Android: Physical activity) or without a step sensor. **iOS:** CMPedometer from the drive's start. **Android:** `PedometerSource`: `TYPE_STEP_COUNTER` (the hardware count since boot, batched in the hub for up to 1 s) less the drive's baseline (its first count after the capture began; a capture the `START_STICKY` restart resumes goes on from the baseline it took, same capture and same boot); a count under the baseline takes a new one (0). A phone with no step counter but a `TYPE_STEP_DETECTOR` counts its steps from the capture's start. Registered from the capture's begin to its end, at both rates. Not a `FeatureRow` extraction field; `parseRow` splits it off, accepts only a non-negative safe integer (anything else rejects the row) and returns it on `row.steps`. |
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
   drive notification can never show a drive over a capture nobody records.

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
   `expected`). Both platforms run every row through their production policy, never a copy kept
   for testing: iOS the Swift `DetectPolicy` (`DetectSelfTest.swift`), Android the Kotlin
   `expo.modules.drivesense.detect.DetectPolicy` (`DetectSelfTest.kt`, routed from `SelfTest.kt`).
   Each answers `{ "name", "kind": "detect", "actual": {…} }` (or the `error` form for a row that
   throws). JS diffs with `diffDetectSelfTest` (`src/detect/selfTest.ts`), which fails a `skipped`
   row from either platform. The Android JVM unit tests (`DetectPolicyVectorsTest.kt`) run the
   same table from `android/src/test/resources/detect-vectors.json`, a generated copy of
   `src/detect/vectors.ts` with the reference's answers; `__tests__/detectFixture.test.ts` fails
   when the file drifts from the table, and
   `UPDATE_DETECT_FIXTURE=1 npx jest modules/drive-sense/__tests__/detectFixture.test.ts`
   rewrites it after a change to the table.

---
## 9. JS usage

```ts
import DriveSense, { parseRow, createFakeDriveSense } from '@drive-sense';

const sub = DriveSense.addListener('row', (raw) => {
  const row = parseRow(raw); // null → drop it; row.mock → a mock-provider fix (integrity)
  if (row) engine.dispatch({ type: 'row', row });
});

// The background surface (≤ 1 update per 3 s on Android, about one a second on iOS), on change
// and every 60 s while unchanged (plan §6):
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
- both platforms answer the retired reminder's methods with fixed stubs; iOS (`platform: 'ios'`,
  the default) keeps no lock proof; `rowSeq: true` stamps each row with the journal's `seq` (1 and up per capture).

`createFakeDriveDetect({ available, now, asyncDelivery, sense, permissions })` (`src/fakeDetect.ts`)
is the detector's: `wake()`, `confirm()`, `emitRows()` (journaled with `seq`, and emitted through
`sense` as `row` events), `startWaiting()` (a manual drive from the tap), `waitOver()` (its wait for
driving speed is over), `endFor(cause)`, `jsStop(endedAt)`, an ndjson journal
read back by `readJournal`, settable permissions and the Always answer.

The other controls (`emit`, `loadTrace`, `listenerCount`, `setLastExitInfo`,
`setIgnoringBatteryOptimizations`, `transition`, `failCaptureSubscribe`, `strandSubscription`) are
documented on `FakeControls` in `src/types.ts`; `driveSenseError(code, message)` builds a coded
rejection for a hand-rolled stub.

---

## 10. The forgot-to-start reminder (retired)

Gone on both platforms: drives start on their own (§11). Its shared methods stay in the contract
with fixed answers (§2) and its `reminderTap` event is never sent. The bootstrap still calls
`setTripReminder(false)` once per install (it resolves). Android deleted its code, its boot receiver
and its `trip_reminder` notification channel (removed from the phone at the next launch).

---

## 11. The drive detector (`DriveDetect`)

A second Expo module in this pod (`ios/DriveDetectModule.swift` with the launch hook
`DriveDetectAppDelegate`; on Android `DriveDetectModule.kt`, without the car link yet: "Android"
below). `src/detect/types.ts` is the binding contract; `src/detect/policy.ts`
holds every rule and number, mirrored constant for constant by `ios/DetectPolicy.swift` and
`ios/DetectEndPolicy.swift` (the native text test compares them).

### Bridge

| Method / event | Behaviour |
|---|---|
| `setArmed(armed, ownerId)` | JS's arming for the signed-in owner (at onboarding's end, at sign-in, at each foreground; off at sign-out, account switch and deletion). Resolves the `DetectState`. Detection runs only with Always, Precise and Motion & Fitness: without them the state stays `off` and `status` says `needs`. A different owner forgets the last end. Never rejects. |
| `getState()` | The `DetectState`: `armed`, `ownerId`, `state` (`off`/`armed`/`candidate`/`recording`/`ending`/`suppressed`), `origin`, the live `driveId` and `startedAt`, `since`, `waitUntil`, `lastEnd { decidedAt, cut, lat, lng, driveId }`, `suppressedUntil`, `status` (`on`/`needs`/`unavailable`/`off`) with `missing` (Location Always, Precise Location, Motion & Fitness, Background App Refresh, then Live Activities, only with `needs`), `permissions` (incl. `backgroundRefresh`, `liveActivities`, `canAskAlways`) and `journalDropped` (reported once). |
| `requestAlways()` | The one "Always" request, only from While Using, once (`drivesense.detect.alwaysAsked`); afterwards the current answer (`always`/`whenInUse`/`denied`) and JS offers Settings. The authorisation going back to not determined (an "Allow Once" grant lapsing, a Location reset) clears it. |
| `startWaiting()` | Start drive: a manual drive opens at once, from the tap (`recording`, origin `manual`, `startSource` `wake`, journaled, `driveStarted`; an auto candidate already open gives way to it, its rows dropped); While Using and Precise are enough. It waits for driving speed (two trusted rows at 10 mph or more in a row, as JS's wait) until `waitUntil` (5 min, `WAIT_MAX_MS`): meanwhile the safety stop never ends it on a walk, and on the still clock only once `waitUntil` has passed too (JS ends it unsaved at that deadline). A relaunch ends the wait, as JS takes the drive back without one. `{ ok: true, waitUntil, driveId, startedAt }`, or `{ ok: false, reason: 'permission' \| 'busy' \| 'unavailable' }`. A native build from before the drive opened at the tap answers `{ ok: true, waitUntil }`: the wrapper passes it on with `driveId` and `startedAt` null. |
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
  rows into a ring of the last 1800 (30 min, the longest candidate); neither `speed` events nor rows
  go to JS (`speed` goes only while a capture is open: a drive from its confirmation or tap). An auto candidate watches while it sees a vehicle sign (a trusted row at 10 mph or more
  with no fresh walk, run or ride report, or a confident automotive report, a car at a light too):
  it ends 3 min after the last one (or after it opened, with none), 5 min once it holds evidence, at
  30 min whatever it sees (`cap`), or on a walk standing 20 s. One that saw no vehicle, or reached
  its cap, rests significant-change and visit wakes for 10 min; only one that saw no vehicle stays
  in the hourly cap's record; one that timed out seeing none puts the parked region where the phone
  rests (its last trusted fix). Every 5 s the detector's clock checks.
- **Confirmation** (`confirmStep`, auto): evidence. A trusted row (a valid fix within 30 m, speed
  rated 2 m/s or better or unrated) over 15 mph earns at 1 / hold per ms, the hold (5/3)·(30 − mph)
  s: 25 s just over 15 mph, 20 s at 18, 15 s at 21, 10 s at 24, 5 s at 27 and 0 at 30, never under
  0.9 s (`autoHoldMs`). 15 mph and under earns nothing. Under 20 mph a row earns only with fresh car
  motion (a standing confident moving automotive report, or one in the last 2 min, the wake's motion
  history included),
  so a bike or an e-scooter in that band never confirms; a row earns nothing while a confident
  cycling, walking or running report arrived 30 s ago or less with no confident automotive report
  after it (`onFootVeto`; a low-confidence, stationary or unknown report never lifts it). The interval between two earning rows at most 2 s
  apart adds its length at the slower one's rate, so a lone GPS spike earns nothing, and the 0.9 s
  floor is the spike guard: from about 29.46 mph (30 mph and over included) a drive confirms on the
  second good reading in a row, never on one; the floor sits under the 1 s row interval, so the 1 Hz
  timer's jitter (rows 997 ms apart, say) never costs a third reading. Crawling and stops keep the evidence; 5 min with no trusted row
  over 3 mph forgets it. It confirms at 1.
- **The start** (`startOf`): the last trusted row at or under 3 mph before the first interval that
  earned, going back past a stop shorter than 5 min the car rolled into (trusted, 5 mph or more:
  a red light, a crawl out of a jam), unless the stop was 5 min or more (a parking). A run that
  began before the oldest buffered row is traced from the first one. An auto drive whose rows begin moving starts
  when the motion history's car run began, placed at the last end when the car could have come from
  there (40 m/s plus 300 m), else at the first row. `continues` when the start is within 5 min of
  the last end's decision and 150 m of its place (a warm-up hint: JS decides the warm-up itself; the
  drive is a new drive either way).
- **`recording`**: a new drive id; the journal opens with its `start` line; the rows from the
  traced start are journaled and emitted with `seq` 1, 2, … (the safety stop checks from the first
  live row on, so old buffered rows never end the drive they start), then every new row; `driveStarted`;
  `capturing` true for `getState` (mode `auto` or `mounted`); the "Recording your drive" check is
  scheduled (below).
- **`ending`**: a JS end rule is overdue (5 min without movement, fix-less car time not counting;
  a walk standing 10 s that the car has not driven since, with no fix over 3 mph in the last 15 s; 12 h; for a Start-card drive still
  waiting for driving speed, no walk, and the 5 min only once its `waitUntil` has passed). Movement again returns to
  `recording`. **The native safety stop** commits the end 10 s later on a walk (`WALK_SAFETY_SLACK_MS`)
  and one minute later otherwise (`SAFETY_SLACK_MS`) if JS has not: the journal gets `end { cause, endedAt: decidedAt }` (native never computes a cut) and
  JS hears `driveEnded`. JS's own end (`stopCapture`) journals `end { cause: 'js', endedAt: its cut }`
  and emits nothing. Every end runs inside a background task (`drivesense.end`, 25 s), so JS can
  store the drive and post its recap. After any end: sensing off, the capture flag cleared, the Live
  Activity ended (`roadwise.driveDisplay` `ended`), the note removed, `lastEnd` and the parked region
  at the last trusted fix, `armed` again. After an automatic end (native's 5 min still or walk, or a
  JS end that a JS rule would have made by then, `lingerAfterJsEnd`: a walk standing 2 s, the 3 s
  floor of JS's walking end less a row, with the last trusted fix at a walker's pace, 5 mph or
  under, more than 15 s old or missing, counts too, since JS counts its walking end from when the
  walk began and lets a carried phone that slow end the drive), unless it was a Start-card drive
  still waiting, an auto candidate opens at once (`linger`: 3 min from the end, 5 once it holds evidence, whatever it sees; no hourly cap entry, no rest, no parked spot): a car
  that sets off again soon is confirmed at once as a new drive with its whole route. The
  parked region's exit during the linger (which iOS sends only once) is never dropped: the linger
  becomes an ordinary watch from the exit (`detectState` `wake:region`), with its evidence, an hourly
  cap entry until it sees a vehicle, vehicle signs (rows at 10 mph or more) keeping it open up to the
  30 min cap, and an empty timeout's parked spot, so a slow restart in traffic is still watched.
  The walk is read as JS reads it: a confident walking or running report stands until a report of
  another kind replaces it; one at low confidence leaves a standing walk alone; two trusted rows at
  10 mph or more in a row, the second at or after its arrival, drop it (the walk to the car, a
  misread at a light or at speed), so it never ends a drive or opens the linger at a later stop, and
  the next confident walking report starts a new one.
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
go on after `lastSeq`), `end { endedAt, cause, decidedAt, lastRowTs, lastSeq }`. fsync on `start`, `gap`, `end` and every 30 rows; 32 MiB a drive at
most (12 h of rows with room); at most 4 files (opening a fifth deletes the oldest file JS never drained, ended or orphaned,
counted in `journalDropped`). A cancelled drive's file is deleted at once. Readers drop a torn last line and
any row whose `seq` is not above the last (a `gap` moves the last to its `lastSeq`), and skip a hole (a row
whose write failed; a failed write cuts its torn bytes off, so the next line starts clean). No file timestamps, attribute reads or disk-space
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

iOS: Location Always + Precise + Motion & Fitness for drives that start on their own; While Using +
Precise for Start drive. Background App Refresh off (Low Power Mode turns it off) is reported as a
need: iOS may then not relaunch RoadWise for a wake. The blue background-location indicator never
shows (`showsBackgroundLocationIndicator = false` on every manager). Idle costs nothing but the
wakes; a candidate is bounded (3 min without a vehicle sign, 30 min at most, 6 empty ones an hour,
the motion gate); a drive costs what a manual drive did.

### Android

The same states, rules and numbers through the Kotlin port of the policy (`detect/DetectPolicy*.kt`),
on one HandlerThread, without the car link (no car methods, no `carLink` event, `carLinkAvailable`
false). What differs is how Android senses:

- **Wakes** (`detect/WakeSources.kt`), none of which turns GPS on: Play services' activity
  transitions (`ActivityTransitionReceiver`: IN_VEHICLE in and out, the ENTERs of WALKING, RUNNING,
  ON_BICYCLE and STILL) build a 3 h motion history (`detect/ActivityHistory.kt`, kept in the
  detector's preferences, each transition dated when it happened), and a confident IN_VEHICLE ENTER
  is the wake iOS's significant change and visits give (reason `wake:slc`; a replay from more than
  2 min before the request is not); the parked car's geofence (`GeofenceReceiver`: "roadwise.parked",
  100 m, exit only, never expiring, no initial trigger, replaced at the last end's place, an empty
  watch's timeout spot and a rest's end) is `wake:region`; RoadWise coming to the front is
  `wake:app`. The wake and motion gates read the history as iOS reads CMMotionActivity's. A reboot
  or an app update drops Play services' registrations: `DetectBootReceiver` (enabled only while the
  wakes run) sets them again. GEOFENCE_NOT_AVAILABLE (location off) sets the geofence again at the
  next foreground. No passive location request and no polling: a passive wake could not start a
  location service from the background (Android 12+).
- **The watch.** A wake opens the location foreground service in its watch form (`startWatch`: the
  transition or geofence broadcast lets it start from the background with "Allow all the time", or
  RoadWise is in front): GPS, IMU and rows as a drive's, into the candidate's 1,800-row buffer, with
  the live activity reports, under the silent minimum-importance "Checking for a drive" notification
  (channel `drive_check`), no JS. A confirmed watch becomes the drive in place (the drive
  notification takes its id; the headless JS host starts when no RoadWise screen is open); the
  start is traced back over the buffer and, when the rows begin moving, the motion history (so a
  geofence exit delivered minutes late still starts at the pull-away). An automatic end turns the
  drive's service into the linger's watch in place. A refused start ends the candidate uncounted.
- **"Not driving?"** rests with no GPS and no service (ruling 4): the transitions say when it ends
  (a walk standing 20 s, dated when it began; 5 min since the phone left the vehicle, held while an
  IN_VEHICLE ENTER stands; 3 h), the evidence kept in the record so it survives the process; the
  parked spot goes where Play services' cached fix (2 min old at most, 100 m) puts the phone.
- **Permissions** (`detect/DriveDetectAccess.kt`): `always` is ACCESS_BACKGROUND_LOCATION on Android
  10+ (any grant below 10); `precise` is ACCESS_FINE_LOCATION; `motion` is Physical activity with
  Play services; `hardware` is Play services; `backgroundRefresh` is `denied` only while battery
  use is Restricted; `liveActivities` is the drive notification allowed. `requestAlways` asks While
  Using first when location is not allowed at all, then "Allow all the time" (Android 10's dialog;
  11+'s settings page), and answers the grant then. Android tells no app about a revoke: every
  wake, foreground and arming re-checks (`permissionLost`).

### Self-test

`detect` vectors (§8): every row of `src/detect/vectors.ts` (confirmation, trace-back, start and
fallbacks, the motion summary and gate, the wake gate, a candidate's clock, the safety stop, the
rest's end, a rest resumed at a relaunch, a relaunch's decision and seq, the status) runs through the production `DetectPolicy` on the
phone (`DetectSelfTest.swift`; on Android the Kotlin port, `DetectSelfTest.kt`) and is diffed by `diffDetectSelfTest`.

---

## 12. The phone heading (`PhoneHeading`, Android only)

The driving screen's compass follows the phone's own heading before a drive's first direction of
travel, in portrait with the screen in front (PRODUCT "The driving screen"). iOS reads it from
expo-location (CLHeading). Android has its own small module, `PhoneHeading`
(`PhoneHeadingModule.kt`, registered for Android only in `expo-module.config.json`), so the shared
DriveSense events and methods stay the same on both platforms; on iOS it does not exist. JS:
`src/heading.ts` (`PhoneHeading.available()`, `PhoneHeading.watch(onReading, onError)`).

| Function (sync) | What it does |
|---|---|
| `available()` | the phone has a `TYPE_ROTATION_VECTOR` sensor |
| `start()` | registers the sensor (and the magnetometer for its calibration status) (true), or false without one; counted, so two callers share one sensor |
| `stop()` | one caller is done; the sensor goes with the last one, and with the JS runtime whatever the count |

| Event | Payload | When |
|---|---|---|
| `heading` | `{ trueHeading, magHeading, accuracy }` (expo-location's heading shape) | while started, at most 5 a second, live only (never buffered) |

`HeadingSource.kt`: `TYPE_ROTATION_VECTOR` at 100 000 µs (10 Hz), no batching, on its own thread.
The heading is the phone's forward direction (`HeadingMath.heading`): the top of the screen and
out of its back (−Z) together, so lying flat it is where the top points, upright in a mount where the
back faces (the road ahead, as iOS's compass reads a portrait phone), and tilted between the two
agree; only a phone tipped about 45° face down has none (no reading). The top of the screen is the
device's +Y, +X, −Y or −X at display rotation 0, 90, 180 or 270 (read at start and on every
`DisplayManager` display change), so a landscape-natural tablet standing in portrait reads right. `magHeading` is magnetic;
`trueHeading` adds `GeomagneticField`'s declination at the newest location the location service
has cached (fused, GPS, network or passive; with location permission; read again every 10 s until
one is known; no fix is ever asked for), else `-1`. `accuracy` is expo-location's 0-3 scale: 0 when
the magnetometer rates its calibration `SENSOR_STATUS_UNRELIABLE` (or has no contact), else that
status, lowered by the rotation vector's own heading-error estimate (`values[4]`, radians) when given:
over 50° → 0, over 35° → 1, over 20° → 2. The calibration status is the magnetometer's
(`TYPE_MAGNETIC_FIELD` at 200 000 µs, registered beside the rotation vector only while the heading
runs and read only for its status), because Android's event dispatch sends every rotation-vector
event as `SENSOR_STATUS_ACCURACY_HIGH`; before the magnetometer's first report, or on a phone without
one, the rotation vector's status stands. JS ignores a reading under 1, as an uncalibrated iOS
compass. The capture never reads either: `SensorSource` stays accelerometer + gyroscope only (a
magnetic mount cannot bend the frame).
