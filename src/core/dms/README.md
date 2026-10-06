# DMS host: the camera lane the drive plugs into

`src/core/dms` is driver monitoring (product spec v3: "Eyes off road (DMS)", "Drowsiness (DMS)", the DMS 1.25× multiplier, the 20-second setup): the pure engine (`engine/`), the capture policy and privacy gate (`policy/`), the host controller and the setup session (`host/`), the scoring seams (`adapters/`) and the replay tooling (`replay/`, tests only). The app imports only `src/core/dms/index.ts`: the camera bridge (`src/features/camera`), the focus detector (`src/core/detectors/focus.ts`) and the drive engine's finalize.

## One controller per signed-in user

```ts
const dms = createDefaultDmsController({
  onAlert: () => {},                 // the engine's own commands are muted (alerts: 'shadow'); v3 sounds come from the drive's alert player, per event
  onStatus: (s) => chip.set(s),
  profileStore: createSettingsProfileStore(settingsRepo, uid),
  setupStore: createSettingsSetupStore(settingsRepo, uid),
  config: { gazeSource: 'geometric' },
});
```

- **`createDefaultDmsController` binds the native module inside the host** (security T14 m-1). Nothing else imports `modules/dms-vision` or holds the raw wrapper, whose `start` takes a plain string. `imports.test.ts` fails the build if anything outside `src/core/dms/host` references the wrapper or `createGate`, in any import form, or if anything re-exports either. `createDmsController({ native, … })` is for tests with the fake.
- **One native owner.** Every `createDefaultDmsController` shares one slot for the camera module: a controller takes it before its first native call of a drive and gives it back at the drive's end and on `dispose()`. Another controller whose gate would open meanwhile stays closed with reason `busy` and makes no native call.
- **Build it on sign-in and `dispose()` it on sign-out, an account switch or account deletion.** Disposing ignores every later call and stops the camera first, before it ends the drive (security M-2/M-4, T14 I-1).
- **Clear the stores after disposing:** `await dms.dispose(); await profileStore.clear(); await setupStore.clear();` on sign-out and on account deletion. `dispose` may save the uid's profile while it ends the drive, so a `clear()` before it can be undone.
- **The gate's nonce** is `expo-crypto` `randomUUID()`. The token never leaves the controller: never log it or store it.

## Calls

| Call | When | What it does |
|---|---|---|
| `setGate(g)` | on every change of an input | Evaluated at once. DMS turned off, the drive ending or the app going inactive **stop native in the same call** (directly, never behind a pending native call), and **stop any sound**. |
| `pushRow(row, power, motion?)` | every 1 Hz drive-sense row, **also while the camera is off** | Re-reads the camera permission while running (a read that fails counts as denied), evaluates the capture policy, sends it to native (the heartbeat), feeds the engine, and returns at most one `DmsFocusSample` for the focus detector. The last 10 rows are replayed into the engine when the gate first opens mid-drive. |
| `takeFocus()` | after `pushRow`, until null | The focus samples still waiting (frames between two rows can close more than one glance). |
| `requestPermission()` | the OS camera prompt, in context | Only while DMS is enabled for the session and the app is in front (the user turning DMS on, the setup's start); otherwise `null` and no native call. Never mid-drive out of the blue. |
| `permissionStatus()` | the settings screen's note | Reads the permission under the same rule; `null` when it may not. |
| `beginSetup()` / `endSetup()` | the setup session | SETUP at 15 fps; the preview is allowed only while stationary. |
| `setupCheck()` | during setup | `{ faceVisible, bothEyesTracked, lightingOk, angleOk, phoneSteady }`, each `boolean \| 'unknown'`; `phoneSteady` is the framing (the face box steady for 2 s) and the rows' IMU where real. |
| `setupGaze()` | during the setup's mirror prompts | `{ rel, tracking }`: the last frame's gaze relative to the seeded road centre, and whether the eyes are tracked now. |
| `seedFromSetup()` | at the end of the setup's road step | The C2 seed from the last 3 s of tracking: `{ ok: true, seed } \| { ok: false, reason }`. The setup session stores it with the mirror zones (`dms.setup`); every later drive starts `seeded`, with the mirrors promoted. |
| `tagLastAlert('wrong')` | a "that was wrong" button | Tags the last alert; changes nothing live. |
| `status()` | any time (`onStatus` fires on change) | `{ camera: 'off' \| 'starting' \| 'active' \| 'limited' \| 'paused', reason, calibration, fatigueLevel, dimAdvised, monitoring }`. `active` with TRACKING in the last 1 s, or HEAD_ONLY for under 10 s; HEAD_ONLY for 10 s is `limited` / `eyes_not_visible`; no face is `limited` / `low_light` in the dark, else `face_lost`. `monitoring` = `{ distraction: 'full' \| 'widened' \| 'off', drowsiness: 'full' \| 'limited' \| 'off', reason }` says what the rules are doing, and why. |
| `presence()` | the drive host, every row | `{ lastFaceT, absent, exitEvidence }`: booleans and times only (see Presence below). The host counts the moving rows with a recent face: the payload's `dmsOn` (≥ 80 % of moving time) and `dmsFaceSeen` (≥ 50 %), and the driving screen's `dmsActive`. |
| `summary()` / `endDrive()` | during a drive, and at its end | `endDrive` first closes the gate and stops native (synchronously), then stops every sound, saves the profile (only if calibrated or seed-verified, with nothing pending and the health good) and returns the trip summary with `pendingFocus`: the focus samples not yet handed out, which belong to the ending drive. Nothing of the drive carries into the next. |
| `diagnostics()` | tests | Counts, the engine's rule speed, native's rates and thermal state, the motion evidence, and failed empty-seat probes. |
| `dispose()` | sign-out, an account switch, account deletion | Ignores every later call, stops the camera first, then ends the drive and gives back the native owner slot. |

## The setup session (`createDmsSetupSession`)

About 20 s, parked, from `/settings/dms-setup`: the controller runs as a stationary pseudo-drive in SETUP (no drive-sense capture; the 1 Hz rows are synthesized by `setupRow`), the live preview is the native `previewView()` (blank at any other time), and the pure step machine (`setupMachine.ts`) walks: **mount** (face found, both eyes tracked, enough light, the framing stable, held 1.5 s) → **road** ("Look at the road ahead", 4 s of tracking, then the seed) → **left mirror** → **right mirror** → **rear-view mirror** (3.5 s each; the gaze directions relative to the seeded centre become that mirror's learned zone, `mirrorZoneFromSamples`, within the engine's learned-zone bounds; too few samples leave the default rectangle). On success the record `{ seed, mirrors }` is stored (`dms.setup`, uid-bound) and the screen sets `dms.calibratedAt` and `dms.enabled`. Clear failures: `no_face`, `dark`, `moving`, `eyes`, `unsteady` (the gaze would not settle; the road step is retried once), `timeout`, `permission`, `cancelled`. The OS camera prompt is asked at the start if it is what keeps the camera off. Nothing of a failed or cancelled setup is stored.

## Status and events

- **Camera values:** `off`, `starting`, `active`, `limited`, `paused`.
- **Reasons:** the gate's closing input (`disabled`, `no_drive`, `app_inactive`, `permission`), `error` (off for the drive after the retry, or native paused itself on an error while it is recovered), `interrupted` (native paused itself: another app took the camera, or the OS interrupted it; recovered by stop and start after 5 s), `busy` (another controller holds the camera), the pauses (`thermal`, `low_light`, `absent`), and what a limited camera means (`face_lost`, `eyes_not_visible`, `low_light`). A stop never pauses the camera: it runs at 5 fps watching for sleep only (SLEEP_WATCH).
- **Monitoring reasons:** `stopped`, `heat`, `dark`, `absent`, `speed_unknown`, `app_inactive`, `camera` (the camera was interrupted or failed), `face`, `eyes` (the eyes are not seen: the sleep rules are limited), `learning_eyes` (no EAR reference yet, so the population prior catches deep closures only), and, from the calibration, `recalibrating`, `posture` and `seed_check`.
- **Each family's cause:** `monitoring.why` = `{ distraction, drowsiness }`, each a monitoring reason; the headline `reason` is the most useful of them.
- **Presence:** `lastFaceT` (the frame clock of the last face), `absent` (the empty-seat pause is in force: no face box for 3 min at a stop, probing 5 s every 30 s), `exitEvidence` (the face is lost and its last box was at the door-side edge of the frame). It decides nothing here; the drive host reads it.
- **Event kinds:** attention `d1_warning`, `d1_rearmed`, `d2_warning`, `d2_reset`, `d3_phone_pattern`, `d4_unresponsive`, `glance_end`; drowsiness `microsleep`, `sleep`, `unresponsive`, `blink`, `episode_end`, `nod`, `microsleep_nod`, `yawn`, `eyes_off` (a shallow closure at speed); calibration `calibrated`, `provisional`, `uncalibrated`, `camera_bump`, `driver_change`, `baseline_reset`, `warm_start` (a profile's mount matched), `posture_dual`, `posture_commit`, `posture_revert`, `head_slump`, `driver_change_provisional`, `driver_change_reverted`, `seed_verified` (a profile's, the setup's or a new driver's seed verified against fresh evidence), `posture_suspect`; and `fatigue_minute`. Events carry zones, durations, levels and scores, never a frame value.
- **Calibration causes:** a camera bump by `step` (the step test), `resume`, `rotation` or `stop` (a knock across a stop); a dual state opened by `step` (a translation), `bump`, `resume`, `stop`, `slow` (the slow uncorroborated path) or `seed` (two verification windows disagreeing with a seed); a revert by `relative` (back at c₀), `undecided`, `no_candidate`, `probation` (a commit the samples reversed) or `fatigue` (a lowering or phone-ward commit refused while the fatigue evidence gate is set).

## Gate inputs (`DmsGateInputs`)

Any input that is false, missing or unknown keeps the camera off. v3 removed the adult-only band and the remote beta flag: DMS is for every user, off by default, and the user's own switch is the consent.

- **`enabled`:** DMS is on for this drive (the Start tap's `dmsOn`, from the `dms.enabled` setting and Home's chip), or the setup session is running.
- **`driveActive`:** a drive is recording (never during finalizing), or the setup session is running.
- **`appActive`.**
- **`driverSide`, `sensitivity`, `alerts`** (`live`, or `shadow`, which mutes every engine command; the drive passes `shadow`: v3 sounds come from the drive's alert player, per event).
- **The camera permission** is read by the controller itself. The bridge asks for it when the user turns DMS on and at the setup's start (`requestPermission()`), never mid-drive.

## Alerts (`DmsAlertCommand`)

`{ id, action: 'start' | 'stop' | 'once', tier: 1 | 2 | 3, kind, tMs, epochMs, muted, cause? }` — the engine's own commands, kept for the replay suites and diagnostics. In v3 they are muted (`alerts: 'shadow'`): what the driver hears is the drive's alert player playing the `eyes_off` ("Eyes up") and `drowsy` ("Take a break") events the focus detector emits, on the same tone + optional voice + haptic conventions as every other event.

- **Tier 3** (Critical): `microsleep`, `sleep`, `unresponsive`, `microsleep_nod`. Continuous, and louder every 2 s, until `stop`.
- **Tier 2:** `distraction`, `cumulative` and `eyes_on_road` repeat every 1 s until `stop`; `fatigue` is a single burst (`once`).
- **Tier 1** (`once`): `phone_pattern`, `fatigue_early`, `repeated_glances`, `monitoring_paused` (with `cause: 'heat' | 'dark' | 'fault'`).

## Focus samples (`DmsFocusSample`) and the v3 events

- A non-driving glance over 2 s (never a mirror, the cluster or a shoulder check): `kind: 'glance'`, `glanceS`, `endT`, `q` = the glance's TRACKING share × the calibration factor (1 calibrated, 0.9 seeded, else 0.7), `wideTurn` (the far-lateral zone: a wide head turn).
- Each closure episode that reached F1–F3, each nod-off and each minute at fatigue drowsy or severe: `kind: 'drowsiness'` with its seconds, `lowLight` when the camera was in the dark.
- **The focus detector** (`src/core/detectors/focus.ts`, through the drive host's `extraDetectors`) turns them into the spec's events: `eyes_off` when a glance lasts ≥ 2 s (minor) / ≥ 4 s (severe) with the car at or above 10 mph throughout, not during a turn (the course rate), not a wide head turn below 15 mph, and only at `q ≥ 0.85`; `drowsy` (severe) when drowsiness signs add up to 60 s within 2 min (at most one per 10 min), never from a sample taken in low light. Both respect the first-30-s and poor-GPS rules like every other detector.

## Where the data may go

- **Frames, landmarks, the profile, the setup record and the gate token stay on the device**, always. The profile lives only in `settings['dms.profile'] = { uid, profile }`, the setup record in `settings['dms.setup'] = { uid, setup }`; both are loaded only for the same uid and removed on a mismatch, and both are face-geometry-derived (interocular distance, face box, pose, gaze and eye baselines).
- **What the upload carries** (plan §3): `dmsOn` and `dmsFaceSeen` (two booleans from shares of the moving time, `adapters/flags.ts`), and the `eyes_off` / `drowsy` events like every other event (`type`, `tier`, `startedAt`, `durationS`, a location outside privacy zones, `measured.speedMph`). No camera-specific field exists in the v3 contract; `src/core/dms/__tests__/privacy.test.ts` pins this.
- **The engine's events, the summary and the focus samples** are consumed on the device and dropped at the drive's end.

## Guarantees

- **Nothing runs while the gate is closed:** no native call (the permission read included), no timer, no listener work. Native failures are silent: one retry after 5 s, then off for the drive.
- **Nothing runs outside a drive or the setup:** the bridge opens the gate only while the engine is `recording` with `dmsOn`, or while the setup session runs, and `endDrive()` stops the camera the moment a drive leaves `recording`.
- **Battery:** the capture policy (`policy/capture.ts`): 15 fps only at speed with a face, 5 fps stopped (sleep watch), 5 fps searching for a lost face, paused for heat, the dark or an empty seat, capped at 8 fps below 20 % battery or in Low Power Mode.
- **The camera going off at speed** (heat, darkness, a native fault) keeps a running Critical, bounded at 60 s without frames, and stops a running distraction; the bridge keeps calling `pushRow`.
- **A stop is a cadence change**, never a pause: monitoring is continuous at move-off.

## Known limits

- **A display mounted above the road line and watched heavily from the start can be calibrated as the road** (C9 round 3). The setup's seed and the advice "mount the phone below your line of sight" are the mitigation.
- **A drive adopted after a relaunch** starts its face counting afresh: `dmsOn` may read false for a drive the process died in the middle of.
- **Low light:** no IR on phone cameras. Drowsiness detection is off in the dark (the `lowLight` flag), distraction runs while the face is tracked; the chip says "Too dark to see you".
