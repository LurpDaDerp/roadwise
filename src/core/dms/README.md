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
- **One native owner.** Every `createDefaultDmsController` shares one slot for the camera module: a controller takes it before its first native call of a drive and gives it back at the drive's end and on `dispose()`. Another controller whose gate would open meanwhile stays closed with reason `busy` and makes no native call.
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
| `status()` | any time (`onStatus` fires on change) | `{ camera: 'off' \| 'starting' \| 'active' \| 'limited' \| 'paused', reason, calibration, fatigueLevel, dimAdvised }`. `active` with TRACKING in the last 1 s, or HEAD_ONLY for under 10 s; HEAD_ONLY for 10 s is `limited` / `eyes_not_visible`; no face is `limited` / `low_light` in the dark, else `face_lost`. Word `age` and `flag_off` neutrally ("not available on this account"). |
| `summary()` / `endDrive()` | during a drive, and at its end | `endDrive` first closes the gate and stops native (synchronously), then stops every sound, saves the profile if calibrated, and returns the trip summary with `pendingFocus`: the focus samples not yet handed out, which belong to the ending trip's scoring. Nothing of the drive carries into the next. |
| `diagnostics()` | the dev panel | Counts, the engine's rule speed, and native's rates and thermal state. |

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
- **Tier 2:** `distraction` and `cumulative` repeat every 1 s until `stop`. `fatigue` is a single burst (`once`).
- **Tier 1** (`once`): `phone_pattern`, `fatigue_early`, `repeated_glances`, `monitoring_paused` (with `cause: 'heat' | 'dark' | 'fault'`; at most once per 10 min, and at any speed, since it replaces a Critical that was already sounding).
- M7 maps each kind to a tone and a voice key. A throwing `onAlert` never breaks the controller.

## Focus samples (`CameraFocusSample`)

- A non-driving glance over 2 s: `kind: 'glance'`.
- Each closure episode that reached F1–F3: `kind: 'drowsiness'`, `glanceS` = the episode's measured length (at most 60 s), sent when the episode ends. Each `microsleep_nod`: `glanceS` = its deep-lid time, at least 0.5 s. Each minute at fatigue drowsy or severe: `glanceS: 60`.

## Where the data may go (security T14 m-3)

- **Events, the summary and the focus samples stay on the device** until M7 ships a disclosure and a versioned consent that covers their upload. The profile never leaves it.
- **Guardians see nothing DMS-specific** without a new disclosure version.
- **Focus samples change the focus score**, so where DMS is on, the score's own disclosure must mention camera input.

## Guarantees

- **Nothing runs while the gate is closed:** no native call (the permission read included), no timer, no listener work. Native failures are silent: one retry after 5 s, then off for the drive.
- **The camera going off at speed** (heat, darkness, a native fault) keeps a running Critical, bounded at 60 s without frames, and stops a running distraction; M7 keeps calling `pushRow`.
- **The profile** lives only in `settings['dms.profile'] = { uid, profile }`, is loaded only for the same uid, and is removed on a mismatch. It is face-geometry-derived (interocular distance, face box, pose and eye baselines) and notices when someone else is driving: the A10 copy and counsel (U-2) must cover that.

## The dev diagnostics panel (`/(app)/dev/dms`)

- **Where it exists:** development and preview builds only (`EXPO_PUBLIC_DIAGNOSTICS=1` or `__DEV__`), never a production-channel build, even through an OTA update published with the flag (the embedded channel is checked). Preview builds go to **adult team testers only**.
- **Its opt-in is a temporary on-screen switch** (off by default, kept only while the screen is open), because no consent store exists before M7 (security T15 m-2). When M7's versioned camera consent lands, the panel reads it and the switch is removed. Its mounted mode and driver role are simulated too; the remote flag, the age band, the app state and the OS permission are real.
- **The camera runs only while the panel is focused:** on blur its simulated drive ends and its controller is disposed.
- **M7 carry (security T15 Info-2):** the panel must not run while M7's controller has a drive. The owner slot enforces it (the panel shows "end the drive first"); M7 does not need to dispose its controller for the panel.
