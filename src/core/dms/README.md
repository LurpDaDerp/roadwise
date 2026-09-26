# DMS host: the bridge M7 plugs into

`src/core/dms` is the driver-monitoring lane: the pure engine (`engine/`), the capture policy and privacy gate (`policy/`), the host controller (`host/`), the scoring seam (`adapters/`) and the replay tooling (`replay/`, tests only). M7 imports only `src/core/dms/index.ts`.

## One controller per signed-in user

```ts
const store = createSettingsProfileStore(settingsRepo, uid);
const dms = createDefaultDmsController({
  onAlert: (cmd) => player.play(cmd),
  onStatus: (s) => hud.setCamera(s),
  onEvent: (e) => tripRecord.dms(e),
  profileStore: store,
  config: { gazeSource: 'geometric' },
});
```

- **`createDefaultDmsController` binds the native module inside the host** (security T14 m-1). M7 never imports `modules/dms-vision` or holds the raw wrapper, whose `start` takes a plain string. `imports.test.ts` fails the build if anything outside `src/core/dms/host` references the wrapper or `createGate`, in any import form, or if anything re-exports either. `createDmsController({ native, … })` is for tests with the fake.
- **One native owner.** Every `createDefaultDmsController` shares one slot for the camera module: a controller takes it before its first native call of a drive and gives it back at the drive's end and on `dispose()`. Another controller whose gate would open meanwhile stays closed with reason `busy` and makes no native call. The slot is taken before the permission read, so a panel whose OS permission is denied still holds it until its drive ends or it is disposed (final review n-3: acceptable for a developer screen). **M7 carry:** the HUD maps `busy` to its own message, "camera in use by diagnostics", never a generic off (the dev panel is the only other holder, and it lets go on blur).
- **Build it on sign-in and `dispose()` it on sign-out, an account switch or account deletion.** Disposing ignores every later call and stops the camera first, before it ends the drive (security M-2/M-4, T14 I-1).
- **Clear the profile after disposing:** `await dms.dispose(); await store.clear();` on sign-out and on account deletion. `dispose` may save the uid's profile while it ends the drive, so a `clear()` before it can be undone. Run the handover wipe after both (security T14 m-3).
- **The gate's nonce** is `expo-crypto` `randomUUID()`. The token never leaves the controller: never log it or store it.

## Calls

| Call | When | What it does |
|---|---|---|
| `setGate(g)` | on every change of an input | Evaluated at once. Opt-out, role, mode or the app going inactive **stop native in the same call** (directly, never behind a pending native call), and **stop any sound** (a gate close ends monitoring; the drive goes on). The remote `cameraBeta` flag is read only at each drive start. |
| `pushRow(row, power)` | every 1 Hz drive-sense row, **also while the camera is off** | Re-reads the camera permission while running (a read that fails counts as denied), evaluates the capture policy, sends it to native (the heartbeat), feeds the engine, and returns at most one `CameraFocusSample` for M1's focus detector. The last 10 rows are replayed into the engine when the gate first opens mid-drive. |
| `requestPermission()` | the camera prompt, in context | Only when the permission is the one input keeping the gate closed; otherwise `null` and no native call. |
| `beginSetup()` / `endSetup()` | the C2 mounting flow | SETUP at 15 fps; the preview is allowed only while stationary. |
| `setupCheck()` | during setup | `{ faceVisible, bothEyesTracked, lightingOk, angleOk, phoneSteady }`, each `boolean \| 'unknown'`. |
| `seedFromSetup()` | when setup ends | The C2 seed: `{ ok: true, warmStart: false } \| { ok: false, reason }`. |
| `tagLastAlert('wrong')` | the "that was wrong" button | Tags the last alert; changes nothing live. |
| `status()` | any time (`onStatus` fires on change) | `{ camera: 'off' \| 'starting' \| 'active' \| 'limited' \| 'paused', reason, calibration, fatigueLevel, dimAdvised, monitoring }`. `active` with TRACKING in the last 1 s, or HEAD_ONLY for under 10 s; HEAD_ONLY for 10 s is `limited` / `eyes_not_visible`; no face is `limited` / `low_light` in the dark, else `face_lost`. Word `age` and `flag_off` neutrally ("not available on this account"). `monitoring` = `{ distraction: 'full' \| 'widened' \| 'off', drowsiness: 'full' \| 'limited' \| 'off', reason }` says what the rules are doing, and why. |
| `presence()` | the drive host, for its auto-end | `{ lastFaceT, absent, exitEvidence }`: booleans and times only (see Presence below). |
| `summary()` / `endDrive()` | during a drive, and at its end | `endDrive` first closes the gate and stops native (synchronously), then stops every sound, saves the profile (Task C8: only if calibrated or seed-verified, with no posture dual state, probation or provisional driver change pending, and with gaze and eye health good and the fatigue gate clear for the last 10 min; the verified EAR/MAR reference and the face luma and IOD it was taken under, or, C8 round 1, the reference as raised when it was only ever raised in the drive; never a downward adaptation), and returns the trip summary with `pendingFocus`: the focus samples not yet handed out, which belong to the ending trip's scoring. Nothing of the drive carries into the next. |
| `diagnostics()` | the dev panel | Counts, the engine's rule speed, native's rates and thermal state, the motion evidence, and failed empty-seat probes. |
| `dispose()` | sign-out, an account switch, account deletion | Ignores every later call, stops the camera first, then ends the drive and gives back the native owner slot. |

## Status and events

- **Camera values:** `off`, `starting`, `active`, `limited`, `paused`.
- **Reasons:** the gate's closing input (`not_opted_in`, `flag_off`, `age`, `no_drive`, `mode`, `role`, `app_inactive`, `permission`), `error` (off for the drive after the retry, or native paused itself on an error while it is recovered), `interrupted` (native paused itself: another app took the camera, or the OS interrupted it; recovered by stop and start after 5 s), `busy` (another controller holds the camera), the pauses (`thermal`, `low_light`, `absent`), and what a limited camera means (`face_lost`, `eyes_not_visible`, `low_light`). A stop never pauses the camera: it runs at 5 fps watching for sleep only (SLEEP_WATCH).
- **Monitoring reasons:** `stopped` ("Stopped: watching for sleep only"), `heat` ("Camera paused: phone too hot; sleep alerts off"), `dark` ("Too dark to see you; sleep alerts limited"), `absent` ("No one in the driver's seat"), `speed_unknown` ("Speed unknown: distraction alerts paused"), `app_inactive`, `camera` (the camera was interrupted or failed), `face` ("Can't see your face"), `eyes` (the eyes are not seen: the sleep rules are limited), `learning_eyes` ("Learning your eyes: sleep alerts limited": no EAR reference yet, so the population prior catches deep closures only; C6 round 1), and, from the calibration tasks, `recalibrating`, `posture` and `seed_check`. Task C7: the gaze accuracy monitor (engine/health.ts) also reads as recalibrating with distraction widened (+5° on the on-road zones, never a re-centre), and a corroborated eye-baseline fault (H5) as drowsiness limited for the eyes reason. The copy is M4's (U-5).
- **Each family's cause:** `monitoring.why` = `{ distraction, drowsiness }`, each a monitoring reason; the headline `reason` is the most useful of them (at a stop with the face lost: `stopped`, with `why.drowsiness` = `face`).
- **Presence:** `lastFaceT` (the frame clock of the last face), `absent` (the empty-seat pause is in force: no face box for 3 min at a stop, probing 5 s every 30 s), `exitEvidence` (the face is lost and its last box was at the door-side edge of the frame; strict for now, so a real exit may read false, which fails safe: the no-movement end then comes later). It decides nothing here; the drive host reads it for the auto-end. A failed empty-seat probe is counted (`diagnostics().probeFailures`), never a camera fault.
- **Event kinds:** attention `d1_warning`, `d1_rearmed`, `d2_warning`, `d2_reset`, `d3_phone_pattern`, `d4_unresponsive`, `glance_end`; drowsiness `microsleep`, `sleep`, `unresponsive`, `blink`, `episode_end`, `nod`, `microsleep_nod`, `yawn`, `eyes_off` (a shallow closure at speed: the eyes_on_road alert; C7 round 6); calibration `calibrated`, `provisional`, `uncalibrated`, `camera_bump`, `driver_change`, `baseline_reset`, `warm_start` (a profile's mount matched; C8 round 1: a failed comparison retries every 5 s of tracking, for up to 5 min of driving), `posture_dual`, `posture_commit`, `posture_revert`, `head_slump`, `driver_change_provisional`, `driver_change_reverted`, `seed_verified` (a profile's, C2 seed's or new driver's seed verified against fresh evidence; Task C8); and `fatigue_minute`. Events carry zones, durations, levels and scores, never a frame value.
- **Calibration causes:** a camera bump by `step` (the step test), `resume`, `rotation` or `stop` (a knock across a stop); a dual state opened by `step` (a translation), `bump`, `resume`, `stop`, `slow` (the slow uncorroborated path) or `seed` (two verification windows disagreeing with a seed; Task C8; or, C8 round 2, two agreeing with a calibration pass that a verified profile disputed: such a pass never replaces the profile's centres by itself); a revert by `relative` (back at c₀), `undecided`, `no_candidate`, `probation` (a commit the samples reversed) or `fatigue` (a lowering or phone-ward commit refused while the fatigue evidence gate is set).

## Gate inputs (`DmsGateInputs`)

Any input that is false, missing or unknown keeps the camera off.

- **`optedIn`:** the current uid's versioned `consents` row of type `camera` (A10). Any read error or version mismatch is `false`.
- **`ageBand`:** `'18_plus'` only when `profiles.age_band` is exactly the adult value. Everything else (u13, 13–17, null, a fetch error) is `'other'` or `'unknown'`.
- **`cameraBeta`:** the remote flag. It is read at drive start; a flag withdrawn mid-drive applies to the next drive.
- **`driveActive`, `mode` (only `mounted` opens), `role` (only `driver` opens), `appActive`.**
- **`driverSide`, `sensitivity`, `alerts`** (`live`, or `shadow`, which mutes every command).
- **The camera permission** is read by the controller itself. M7 prompts in context through `requestPermission()`.

## Alerts (`DmsAlertCommand`)

`{ id, action: 'start' | 'stop' | 'once', tier: 1 | 2 | 3, kind, tMs, epochMs, muted, cause? }`

- **Tier 3** (Critical): `microsleep`, `sleep`, `unresponsive`, `microsleep_nod`. Continuous, and louder every 2 s, until `stop`.
- **Tier 2:** `distraction`, `cumulative` and `eyes_on_road` repeat every 1 s until `stop`. The eyes-on-road alert (C7 round 6, the user's decision R4-T) is a closure at 20 km/h or more that was never deep (the eyes lowered, not shut): it plays as a distraction alert (it stops when the eyes are back on the road, merges with D1, and never counts as drowsiness), and becomes a sleep Critical only if the closure turns deep or lasts 6 s. `fatigue` is a single burst (`once`).
- **Tier 1** (`once`): `phone_pattern`, `fatigue_early`, `repeated_glances`, `monitoring_paused` (with `cause: 'heat' | 'dark' | 'fault'`; at most once per 10 min, and at any speed, since it replaces a Critical that was already sounding).
- M7 maps each kind to a tone and a voice key. A throwing `onAlert` never breaks the controller.

## Focus samples (`CameraFocusSample`)

- A non-driving glance over 2 s: `kind: 'glance'`.
- Each closure episode that reached F1–F3: `kind: 'drowsiness'`, `glanceS` = the episode's measured length (at most 60 s), sent when the episode ends. Each `microsleep_nod`: `glanceS` = its deep-lid time, at least 0.5 s. Each minute at fatigue drowsy or severe: `glanceS: 60`.
- **Stop-time sleep events** (raised while the car is stopped or creeping below 10 km/h, U-14): they always sound and are counted in the summary (`stopSleepEvents`). What else they feed is `fatigue.stopEventsFeed`: `'none'` (the default) gives no focus sample and no fatigue level; `'long_and_nod'` counts only closures that reached F2 or F3 (3 s or more) and `microsleep_nod`; `'all'` counts everything. An episode counts as stop-time only if every F event in it was raised while stopped: one that fires again after the move-off is moving-time.

## Where the data may go (security T14 m-3)

- **Events, the summary and the focus samples stay on the device** until M7 ships a disclosure and a versioned consent that covers their upload. The profile never leaves it.
- **Guardians see nothing DMS-specific** without a new disclosure version.
- **Focus samples change the focus score**, so where DMS is on, the score's own disclosure must mention camera input.
- **Passing `cameraFocus` to the drive engine is an upload** (security T16 I-1). M1's existing trip-event pipeline sends each focus sample to Supabase as a trip event with source 'camera', the measured `glanceS` and `focusKind` (`glance` or `drowsiness`), at the event's location rounded to 3 dp, and the trip's `camera_session` and the daily `camera_day` follow from it. `src/core/dms/__tests__/privacy.test.ts` pins exactly these fields; any new camera-derived field fails it.
- **M7 carry, the upload gate:** M7 passes `cameraFocus` only for a trip whose driver has seen the A10 disclosure and holds the versioned camera consent (`consents(type='camera')`), checked per trip; otherwise `cameraFocus` is null (M7 tests that). The panel never passes it.
- **M7 carry, guardians:** guardian-facing views show no camera-sourced events (source 'camera') until a new guardian disclosure version covers them.

## Guarantees

- **Nothing runs while the gate is closed:** no native call (the permission read included), no timer, no listener work. Native failures are silent: one retry after 5 s, then off for the drive.
- **The camera going off at speed** (heat, darkness, a native fault) keeps a running Critical, bounded at 60 s without frames, and stops a running distraction; M7 keeps calling `pushRow`.
- **Sleep alerts at every speed** (Task C2, the user's rule): F1, F2, F3 and `microsleep_nod` fire at any speed, stopped included, and no stop ends a sleep Critical. While stopped it ends when the eyes are open for 1 s, the gaze anywhere; while moving, the gaze must be on the road. A D4 (distraction) Critical ends after 5 s stopped. Everything else stays silent below its floor (20 km/h; D4 10 km/h), and while stopped the distraction and fatigue accounting is frozen. "Stopped" is a GNSS speed below 10 km/h or the drive host's sensor stop (`motionEvidence`, passed with each row); when the evidence goes missing, the last one is held for 3 s (`context.rowStaleMs`) and then the speed is unknown, neither stopped nor moving.
- **A Critical never sounds forever** (U-23, the user's ruling, reversible): with no TRACKING face for 60 s (`alerts.criticalLostMaxS`; LOST, HEAD_ONLY or no frames, continuously) it stops and one `monitoring_paused` (cause `face_lost`) plays. The accepted cost: a driver slumped out of view gets 60 s of alarm, then the notice. The 60 s without frames is measured from the last frame, whether or not the camera-off was announced.
- **The summary counts the drive the camera did not see**: `cameraOffS` by cause (heat, dark, fault, gate, paused, stall) at a monitored speed; `trackingCoverage` and `cameraSession` include it, and `thermalMinutes['3']` is the time at L3.
- **The profile** lives only in `settings['dms.profile'] = { uid, profile }`, is loaded only for the same uid, and is removed on a mismatch. It is face-geometry-derived (interocular distance, face box, pose and eye baselines) and notices when someone else is driving: the A10 copy and counsel (U-2) must cover that. Since Task C8 it also holds the face ROI luma and the projected IOD under which the eye baseline was taken (`earAppearance`) and the gaze spread (`sigmaDeg`), both optional. Since C7 round 4 the open-eye EAR it holds is noise-corrected (the P90 of open frames less the per-frame EAR noise, `earNoiseCorrected: true`); a profile saved before that may be lowered once, by the drive's first calibration pass, by at most 8 %.

## The dev diagnostics panel (`/(app)/dev/dms`)

- **Where it exists:** development and preview builds only (`EXPO_PUBLIC_DIAGNOSTICS=1` or `__DEV__`), never a production-channel build, even through an OTA update published with the flag (the embedded channel is checked). Preview builds go to **adult team testers only**.
- **Its opt-in is a temporary on-screen switch** (off by default, kept only while the screen is open), because no consent store exists before M7 (security T15 m-2). When M7's versioned camera consent lands, the panel reads it and the switch is removed. Its mounted mode and driver role are simulated too; the remote flag, the age band, the app state and the OS permission are real.
- **The camera runs only while the panel is focused:** on blur its simulated drive ends and its controller is disposed.
- **M7 carry (security T15 Info-2):** the panel must not run while M7's controller has a drive. The owner slot enforces it (the panel shows "end the drive first"); M7 does not need to dispose its controller for the panel.
