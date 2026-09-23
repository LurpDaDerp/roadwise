# DMS host: the bridge M7 plugs into

`src/core/dms` is the driver-monitoring lane: the pure engine (`engine/`), the capture policy and privacy gate (`policy/`), the host controller (`host/`), the scoring seam (`adapters/`) and the replay tooling (`replay/`, tests only). M7 imports only `src/core/dms/index.ts`.

## One controller per signed-in user

```ts
const store = createSettingsProfileStore(settingsRepo, uid);
const dms = createDmsController({
  native: DmsVision,              // modules/dms-vision (only src/core/dms/host may import it)
  onAlert: (cmd) => player.play(cmd),
  onStatus: (s) => hud.setCamera(s),
  onEvent: (e) => tripRecord.dms(e),
  profileStore: store,
  config: { gazeSource: 'geometric' },
});
```

- **Build it on sign-in and `dispose()` it on sign-out, an account switch or account deletion.** Disposing stops the camera at once (security M-2/M-4). Call `store.clear()` on sign-out and account deletion as well.
- **The gate's nonce** is `expo-crypto` `randomUUID()`. The token never leaves the controller: never log it or store it.

## Calls

| Call | When | What it does |
|---|---|---|
| `setGate(g)` | on every change of an input | Evaluated at once. Opt-out, role, mode or the app going inactive **stop native in the same call**. The remote `cameraBeta` flag is read only at each drive start. |
| `pushRow(row, power)` | every 1 Hz drive-sense row, **also while the camera is off** | Re-reads the camera permission while running, evaluates the capture policy, sends it to native (the heartbeat), feeds the engine, and returns at most one `CameraFocusSample` for M1's focus detector. |
| `beginSetup()` / `endSetup()` | the C2 mounting flow | SETUP at 15 fps; the preview is allowed only while stationary. |
| `setupCheck()` | during setup | `{ faceVisible, bothEyesTracked, lightingOk, angleOk, phoneSteady }`, each `boolean \| 'unknown'`. |
| `seedFromSetup()` | when setup ends | The C2 seed: `{ ok: true, warmStart: false } \| { ok: false, reason }`. |
| `tagLastAlert('wrong')` | the "that was wrong" button | Tags the last alert; changes nothing live. |
| `status()` | any time (`onStatus` fires on change) | `{ camera: 'off' \| 'starting' \| 'active' \| 'limited' \| 'paused', reason, calibration, fatigueLevel, dimAdvised }`. `active` only with TRACKING or HEAD_ONLY frames in the last 1 s. |
| `summary()` / `endDrive()` | during a drive, and at its end | `endDrive` stops every sound, saves the profile if calibrated, stops native, and returns the trip summary. |

## Gate inputs (`DmsGateInputs`)

Any input that is false, missing or unknown keeps the camera off.

- **`optedIn`:** the current uid's versioned `consents` row of type `camera` (A10). Any read error or version mismatch is `false`.
- **`ageBand`:** `'18_plus'` only when `profiles.age_band` is exactly the adult value. Everything else (u13, 13–17, null, a fetch error) is `'other'` or `'unknown'`.
- **`cameraBeta`:** the remote flag. It is read at drive start; a flag withdrawn mid-drive applies to the next drive.
- **`driveActive`, `mode` (only `mounted` opens), `role` (only `driver` opens), `appActive`.**
- **`driverSide`, `sensitivity`, `alerts`** (`live`, or `shadow`, which mutes every command).
- **The camera permission** is read by the controller itself, never requested. M7 prompts in context.

## Alerts (`DmsAlertCommand`)

`{ id, action: 'start' | 'stop' | 'once', tier: 1 | 2 | 3, kind, tMs, epochMs, muted, cause? }`

- **Tier 3** (Critical): `microsleep`, `sleep`, `unresponsive`, `microsleep_nod`. Continuous, and louder every 2 s, until `stop`.
- **Tier 2:** `distraction` and `cumulative` repeat every 1 s until `stop`. `fatigue` is a single burst (`once`).
- **Tier 1** (`once`): `phone_pattern`, `fatigue_early`, `repeated_glances`, `monitoring_paused` (with `cause: 'heat' | 'dark'`).
- M7 maps each kind to a tone and a voice key. A throwing `onAlert` never breaks the controller.

## Guarantees

- **Nothing runs while the gate is closed:** no native call (the permission read included), no timer, no listener work. Native failures are silent: one retry after 5 s, then off for the drive.
- **The camera going off at speed** (heat, darkness) keeps a running Critical, bounded at 60 s without frames; M7 keeps calling `pushRow`.
- **The profile** lives only in `settings['dms.profile'] = { uid, profile }`, is loaded only for the same uid, and is removed on a mismatch.
