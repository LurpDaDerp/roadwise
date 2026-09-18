# `dms/` — driver monitoring rule engine (plain JS)

A faithful, module-for-module port of the Python reference package
`distracted-driving-research/deployment-stack/dms/` (docs/DESIGN.md there is the spec).
Landmarks and a gaze prediction go in; zones, glances, drowsiness, events and one voiced
alert per frame come out.  Everything is time-based — the rules run unchanged at 5, 15 or
30 Hz — and the port is verified frame by frame against the reference (see `tests/PARITY.md`).

## Modules

| file | port of | what it holds |
| --- | --- | --- |
| `util.js` | `dms/util.py` | angle conventions (`unit`, `vectorToAngles`, `anglesToVector`, `angularDistanceDeg`, `headDirection`, `referenceRotation`, `relativeAngles`, `wrapDeg`), the decaying histograms (1-D / 2-D), `CausalMedian`, `TimeWindowSum`, `BucketWindowSum`, `EventCounter`, and the numpy-compatible helpers (`pairwiseSum`, `pyRound`, `pyMod`, `roundHalfEven`) |
| `config.js` | `dms/config.py` | every threshold: `frontEnd`/`calibration`/`attention`/`drowsiness`/`alerts`/`zones` defaults, `defaultZones()`, `createConfig(overrides)` (deep merge), `configFromJson`, `validate(cfg)` |
| `alerts.js` | `dms/alerts.py` | `Severity`, `EventType`, `PRIORITY`, `SEVERITY`, `MESSAGE`, `SOUND`, the `Event` class and its `toDict()` |
| `gaze_inputs.js` | `dms/gaze_inputs.py` | landmarks -> network inputs (`weak3dCloud`, `cameraContext`, `landmarkValidity`), the eye/mouth geometry helpers, the mirror helpers and `SubjectStatisticTracker` |
| `features.js` | `dms/features.py` | `FrameFeatures` (plain object), `headAngles`, `computeFeatures`, `emptyFeatures`, `headTurnDeg` |
| `calibration.js` | `dms/calibration.py` | `ForwardReference`: the label-free "eyes on the road" direction, its admission gates, confidence machine and re-calibration rules; `robustMode` |
| `attention.js` | `dms/attention.py` | zone classification, glance classes, A1-A6 (`AttentionRules`), `TimeMedian` |
| `drowsiness.js` | `dms/drowsiness.py` | `DrowsinessTracker`: closures, blinks, PERCLOS (60 s + 180 s bucketed), yawns, nods, score and level hysteresis |
| `monitor.js` | `dms/monitor.py` | `GazeQuality`, `MonitorOutput`/`outputToDict`, `AlertArbiter`, `DriverMonitor` |
| `app_config.js` | — | `createAppConfig()`: the reference defaults plus the phone deltas of `docs/dms/DETECTION_DESIGN.md` (§5, §6, §7 sensitivity, §7a) |
| `index.js` | `dms/__init__.py` | re-exports everything (flat, plus one namespace per module) |

## Phone options

Seven engine options exist on top of the reference (`docs/dms/DETECTION_DESIGN.md` §5, §6, §7a).
**Every one defaults to the reference behaviour**, so the parity fixtures run unchanged; the
phone values are set by `createAppConfig()` and each option is proved by
`tests/phone_options.test.js`.

| option | default (= reference) | phone value | what it does |
| --- | --- | --- | --- |
| `calibration.stationary_weight` | `1.0` | `0.25` | multiplies the calibration admission weight while the vehicle speed is known and below `alerts.speed_gate_kmh` (applied after the head gate, before `min_weight`; the iris-median floor weight is untouched), so a parked conversation cannot bootstrap the forward reference |
| `attention.hard_left_driver_deg` | `null` → `hard_left_deg` | `75.0` | the "definitely off road" lateral bound on the DRIVER's side (`left > limit`), widened by the provisional margin as before |
| `attention.hard_left_passenger_deg` | `null` → `hard_left_deg` | `65.0` | the same bound on the passenger's side (`left < -limit`); `driver_relative` has already applied `driver_side`, so both work unchanged for RHD |
| `drowsiness.ear_open_freeze_s` | `0.0` (off) | `120.0` | after this much usable open-eye tracking the open-eye baseline is frozen once and thereafter floored at `ear_open_freeze_ratio x` it (the running median may still raise it), so a driver whose lids droop cannot desensitise the detector |
| `drowsiness.ear_open_freeze_ratio` | `0.9` | `0.9` | the floor's share of the frozen baseline |
| `drowsiness.perclos_blink_exclude_s` | `0.0` (off) | `0.25` | a counted closure no longer than this pushes its closed seconds back out of the 60-s and 180-s PERCLOS accumulators when it ends (PERCLOS is defined on slow closures) |
| `drowsiness.blink_stats_min_fps` | `0.0` (off) | `15.0` | blink rate / mean duration / long count report 0 when the typical frame period exceeds `1 / this`, exactly as the existing `dt_typical > blink_max_s` branch does |
| `drowsiness.perclos_advisory` | `null` (off) | `0.08` | emits the INFO event `PERCLOS_ADVISORY` ("Consider a break soon") at most every `ADVISORY_REPEAT_S` (300 s) while the level is ALERT and the valid 60-s PERCLOS is at or above the value; `DrowsinessState.perclos_advisory` carries the current condition for the display |

`ForwardReference.seedStale(referenceVec, [yaw, pitch] | null, t)` starts a session from a
persisted reference (§5.2): the vector becomes a STALE reference and the engine's own
re-validation path confirms it (`CALIBRATION_PROVISIONAL`, detail `revalidated*`) or replaces it
(`RECALIBRATED`) — that path itself is unchanged. With a head mode it also seeds `head_hist` with
`head_mode_min_s` seconds of mass AND sets `head_mode_xy` / `head_mode_vec`, so the head gate and
the A6 head rules work from the first frame; `_updateModes` then refines the mode from real
frames and the seed decays away.

`PERCLOS_ADVISORY` is the ONLY event type added to the reference vocabulary, appended last so the
C twin's enum order stays comparable.

## Conventions

* **CommonJS** (`require` / `module.exports`) so the files load both under `node --test` and
  under Metro; no React Native imports, no dependencies, no build step.
* **Names**: config fields, event fields and state fields keep the reference's `snake_case`
  (so fixtures, the C header and the docs line up); functions and classes are `camelCase`.
* **Numbers**: float64 everywhere (JS numbers are IEEE doubles, like numpy's default).
  Typed arrays are used for histogram counts and landmark clouds only.  `Float32Array`
  appears exactly where a runtime needs it: `prepareInputs().cloud`, `.context`, `.validity`.
* **Missing values**: `NaN` for an unmeasurable float, `null` for "not applicable" (the
  reference's `None`), matching the Python field for field.
* **Landmarks** are accepted as a flat array of 478*3 numbers (row-major `[x0,y0,z0,x1,...]`,
  any `Array`/`Float32Array`/`Float64Array`) or as an array of 478 `[x, y, z]` triples.

## Using it

```js
const { DriverMonitor, createConfig } = require('./dms');

const monitor = new DriverMonitor(createConfig({ front_end: { focal_scale: 0.75 } }));
monitor.setVehicleSpeed(kmh);            // optional (CAN / GPS); null = unknown

// synchronous network:
const out = monitor.process({ t, landmarks, width, height, face_present: true },
                            (cloud, context, validity) => runtime.runSync(cloud, context, validity));

// asynchronous runtime (ONNX / TFLite in RN): split the frame in two halves
const inputs = monitor.prepareInputs(frame);          // null when there is no usable face
const prediction = await runtime.run(inputs.cloud, inputs.context, inputs.validity);
const out2 = monitor.finishFrame(frame, inputs, prediction);   // {gaze: [3], rotation: [9]}

// features computed elsewhere (replays, parity):
monitor.processPrediction(t, gazeVec, rotation, feat);
```

`out.voiced` is the single alert to sound this frame (`null` most frames); `out.events` is
everything that fired; `out.active_alerts` is what has been heard from in the last 3 s;
`outputToDict(out)` is the JSON-safe record (non-finite floats become `null`).
`monitor.acknowledge(t)` silences the active alerts for `alerts.ack_suppress_s`,
`monitor.resetCalibration()` forgets the forward reference, `monitor.reset()` starts over.

The model bundle's subject-statistic training mean and eye gate are baked into
`monitor.js` (`TRAINING_MEAN`, `EYE_GATE`) from `models/gaze_direct.meta.json`; pass
`new DriverMonitor(cfg, { trainingMean, eyeGate })` if the bundle is ever re-exported.

## Tests

```sh
cd dms && node --test                       # the whole suite (parity + behaviour), ~35 s
node --test "dms/tests/*.test.js"           # same, from the repo root
node --test dms/tests/monitor.test.js       # one file
node dms/tests/tools/parity_report.js       # re-measures and rewrites tests/PARITY.md
```

(Node 24 no longer expands a bare directory passed to `--test`, so use a glob or run it
from inside `dms/`; there is no jest, babel or TypeScript anywhere in this folder.)

* `util.test.js`, `gaze_inputs.test.js`, `features.test.js`, `drowsiness.test.js`,
  `monitor.test.js` replay JSON fixtures recorded from the Python reference and assert
  parity (1e-6 absolute on numbers, exact on strings / booleans / events).
* `phone_options.test.js` proves the seven phone options above (and that each default is inert).
* `behavior.test.js` is the JS twin of `tools/behavior_eval.py`: the same scenario shapes on
  a DIFFERENT RNG (mulberry32), gating "normal driving is silent" and "unsafe behaviour is
  voiced within its latency" at 30 / 15 / 5 Hz.
* `tests/synthetic.js` is the JS port of `tests/synthetic.py` + the `Run` harness,
  `tests/helpers.js` holds the fixture decoder and the comparator, `tests/parity.js` and
  `tests/replay.js` hold the comparisons shared by the tests and the report.

### Fixtures

`tests/fixtures/*.json` (~15 MB, 44 files, every one under 1.5 MB) are generated from the
reference with its own defaults (no phone option is on), never by hand:

```sh
cd /home/lurpd/DevelopmentWSL2/distracted-driving-research/deployment-stack
/home/lurpd/DevelopmentWSL2/distracted-driving-research/gaze-pretrain/.venv/bin/python \
    /mnt/c/Users/lurpd/Documents/dev/RoadCash-dms/dms/tests/tools/gen_fixtures.py
```

The generator imports `dms`, `tests/synthetic.py`, `tools/behavior_eval.py` and
`tools/synth_streams.py` READ-ONLY.  Input floats are quantised *before* the reference sees them
(timestamps to 12 significant digits, everything else to 8), so the JSON carries the exact
doubles both engines start from; outputs are dumped at 12 significant digits and event dicts keep
the reference's own `to_dict()` rounding.  Frame columns are stored column-wise with
constant / run-length / alias encoding.  `manifest.json` records the generation date, the
app-repo commit and the sha256 of every reference file used.

Three space savers, none of which drops a comparison the engine can fail silently:

* every scenario of one frame rate begins with the IDENTICAL 150-s warm-up (same seed, same
  `seg(WARMUP_S)`), so those input frames live once in `monitor_warmup_{10,15,30}hz.json` and each
  scenario references them through `inputs_prefix`;
* per-frame OUTPUT rows are stored only from `t_test` onward (the calibration scenarios keep every
  frame) — events and voiced alerts are still compared at EVERY frame, and the state is
  cumulative, so a drift inside the warm-up fails at the first compared frame;
* outputs that are verbatim copies of an input (`t`, `head_yaw`, `head_pitch`, `face_present`)
  are asserted against the input columns instead of being stored twice.

`mirror_permutation_478.json` (the mesh mirror involution) and `onnx_parity.json` (the
bundle's recorded input/output case) are shipped for the app runtime itself: the first is
what mirror TTA needs, the second is the runtime self-test.
