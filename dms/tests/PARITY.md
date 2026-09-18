# Parity report

`dms/*.js` against the Python reference (`deployment-stack/dms/*.py`), replayed frame by
frame on the fixtures in `dms/tests/fixtures/`.  Regenerate with
`dms/tests/tools/gen_fixtures.py`, re-measure with `node dms/tests/tools/parity_report.js`.

* fixtures generated: 2026-09-18T00:53:29-07:00
* reference: /home/lurpd/DevelopmentWSL2/distracted-driving-research/deployment-stack (python 3.12.3, numpy 2.5.1)
* app repo commit: 8f7c27d7cbe6f3a76e4a606c0c10335e9f00e0c9
* numeric tolerance asserted: 0.000001 absolute; strings / booleans / integers exact;
  events compared field by field on the reference's own `to_dict()` rounding (identical values).
* 38 fixtures, 1,672,043 field comparisons, worst difference 5.00e-10 (monitor_brief_phone_checks.json, admitted_s).

| fixture | frames | frames compared | field checks | max abs diff | worst field | events matched | result |
| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `util_cases.json` | 4900 | 4900 | 5473 | 4.98e-10 | distance | 69/69 | PASS |
| `gaze_inputs_cases.json` | 20 | 20 | 46236 | 5.00e-12 | cloud[778] | 0/0 | PASS |
| `gaze_inputs_stats_tracker.json` | 400 | 400 | 1600 | 5.00e-13 | current[0] | 0/0 | PASS |
| `features_cases.json` | 20 | 20 | 632 | 4.86e-10 | head_yaw | 0/0 | PASS |
| `drowsiness_drowsy.json` | 3200 | 3200 | 57601 | 4.99e-11 | blink_rate_per_min | 176/176 | PASS |
| `drowsiness_drowsy_then_recover.json` | 5400 | 5400 | 97201 | 5.00e-11 | score | 127/127 | PASS |
| `drowsiness_head_turn_closure.json` | 690 | 690 | 12421 | 5.00e-13 | ear_closed_baseline | 0/0 | PASS |
| `drowsiness_look_down_lowered_lids.json` | 3000 | 3000 | 54001 | 4.99e-12 | score | 28/28 | PASS |
| `drowsiness_microsleep.json` | 1020 | 1020 | 18361 | 4.96e-12 | blink_rate_per_min | 5/5 | PASS |
| `drowsiness_nodding_off.json` | 1668 | 1668 | 30025 | 4.96e-11 | blink_rate_per_min | 11/11 | PASS |
| `drowsiness_normal_driving.json` | 1800 | 1800 | 32401 | 4.87e-11 | blink_rate_per_min | 21/21 | PASS |
| `drowsiness_open_eye_head_dips.json` | 2400 | 2400 | 43201 | 4.95e-12 | blink_rate_per_min | 19/19 | PASS |
| `drowsiness_single_bad_minute.json` | 4200 | 4200 | 75601 | 4.99e-11 | score | 59/59 | PASS |
| `drowsiness_sunglasses.json` | 900 | 900 | 16201 | 0.00e+0 | - | 0/0 | PASS |
| `monitor_brief_phone_checks.json` | 4018 | 1768 | 84868 | 5.00e-10 | admitted_s | 73/73 | PASS |
| `monitor_calibration_camera_moved.json` | 1200 | 1200 | 57604 | 1.61e-10 | q_head_speed | 4/4 | PASS |
| `monitor_calibration_driver_change.json` | 3300 | 3300 | 158404 | 2.61e-10 | q_head_speed | 11/11 | PASS |
| `monitor_calibration_persistent_shift.json` | 3600 | 3600 | 172804 | 5.00e-10 | admitted_s | 4/4 | PASS |
| `monitor_cluster_checks.json` | 3450 | 1200 | 57604 | 5.00e-10 | admitted_s | 62/62 | PASS |
| `monitor_driver_absent.json` | 2580 | 330 | 15844 | 4.99e-10 | admitted_s | 47/47 | PASS |
| `monitor_drowsy_perclos.json` | 3900 | 2400 | 115204 | 5.00e-10 | admitted_s | 210/210 | PASS |
| `monitor_eyes_closed.json` | 5010 | 510 | 24484 | 3.65e-10 | q_head_speed | 54/54 | PASS |
| `monitor_head_bobbing.json` | 3600 | 1350 | 64804 | 5.00e-10 | admitted_s | 65/65 | PASS |
| `monitor_intersection_side_looks.json` | 3270 | 1020 | 48964 | 4.99e-10 | admitted_s | 67/67 | PASS |
| `monitor_lap_look_3.8s.json` | 2457 | 207 | 9940 | 4.99e-10 | admitted_s | 48/48 | PASS |
| `monitor_lap_stare_10s.json` | 2550 | 300 | 14404 | 4.99e-10 | admitted_s | 55/55 | PASS |
| `monitor_microsleep.json` | 4866 | 366 | 17572 | 3.65e-10 | q_head_speed | 48/48 | PASS |
| `monitor_mirror_checks.json` | 3942 | 1692 | 81220 | 4.99e-10 | admitted_s | 70/70 | PASS |
| `monitor_nodding_off.json` | 4941 | 441 | 21172 | 3.65e-10 | q_head_speed | 54/54 | PASS |
| `monitor_passenger_stare.json` | 2460 | 210 | 10084 | 4.99e-10 | admitted_s | 50/50 | PASS |
| `monitor_passenger_talk.json` | 3522 | 1272 | 61060 | 5.00e-10 | admitted_s | 66/66 | PASS |
| `monitor_shoulder_checks.json` | 3240 | 990 | 47524 | 4.99e-10 | admitted_s | 56/56 | PASS |
| `monitor_side_stare_13.5s.json` | 2602 | 352 | 16900 | 4.99e-10 | admitted_s | 54/54 | PASS |
| `monitor_side_stare_at_50kmh.json` | 2475 | 225 | 10804 | 4.99e-10 | admitted_s | 48/48 | PASS |
| `monitor_sleep.json` | 4920 | 420 | 20164 | 3.65e-10 | q_head_speed | 51/51 | PASS |
| `monitor_sunglasses_head_only.json` | 2790 | 540 | 25924 | 4.97e-10 | admitted_s | 65/65 | PASS |
| `monitor_texting_pattern.json` | 2640 | 390 | 18724 | 4.99e-10 | admitted_s | 61/61 | PASS |
| `monitor_visual_time_sharing.json` | 2771 | 521 | 25012 | 4.99e-10 | admitted_s | 75/75 | PASS |

The fixtures run the engine with the REFERENCE defaults: every phone option of
`docs/dms/DETECTION_DESIGN.md` (`calibration.stationary_weight` 1.0,
`attention.hard_left_*_deg` null, `drowsiness.ear_open_freeze_s` /
`perclos_blink_exclude_s` / `blink_stats_min_fps` 0, `perclos_advisory` null) is off, so
the port stays comparable to the Python stack frame by frame.  The phone behaviour is
covered separately by `dms/tests/phone_options.test.js`.

Per-frame output rows are compared from `t_test` onward (the calibration scenarios
compare every frame); events and voiced alerts are compared at EVERY frame of every
fixture, and the "frames compared" column says how many rows carried a full state check.

The residual differences are the fixtures' own 12-significant-digit dump quantisation
(`%.12g`, <= 1e-12 relative), not engine drift: the worst absolute numbers appear on the
largest quantities (`admitted_s` ~ 300 s, head speed ~ 10^3 deg/s).  Event streams, voiced
alerts, zones, confidences, glance classes and drowsiness levels are IDENTICAL.
