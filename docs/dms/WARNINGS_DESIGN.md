# Driver monitoring on the phone — warnings design

Companion to `DETECTION_DESIGN.md` (D) and `RESEARCH.md` (R); the event vocabulary, priorities and
cooldowns are the reference deployment stack's (`dms/alerts.py`, `dms/monitor.py`, cited as T).
This document says what the driver sees, hears and feels for every event, and why.

## 1. Severity tiers

The reference's three tiers are kept; the phone adds a presentation channel per tier.  Euro NCAP
requires a visual plus an audible and/or haptic warning "immediately" for transient states,
microsleep / sleep warnings that are "distinct from and deliver a higher perceived level of
urgency than the distraction and impairment warnings", and allows suppression of a transient
warning after the driver acknowledges it (R §1).

| tier | meaning | visual | tone | voice | haptic | repeats |
|---|---|---|---|---|---|---|
| INFO | logged / displayed, never audible | status pill or nothing | — | — | — | — |
| WARNING | a transient or impairment state the driver should correct | top banner (amber for distraction, purple-blue for drowsiness, grey for system) with the message and a "Got it" button | one pattern (§3) | one short sentence | one `notificationAsync(Warning)` | per-type cooldown 4 s (distraction) / 30 s (drowsiness); escalation while the glance persists every 2 s (arbiter, T) |
| CRITICAL | closed eyes, severe drowsiness or an unresponsive stare | full-screen red overlay with a large message; the drive UI stays visible underneath at 40 % | siren (closed eyes) / double-low (severe drowsiness) / double-high (stare) | short imperative, repeated | `impactAsync(Heavy)` × 3 at 150 ms | every 1.5 s while the condition holds (`CRITICAL_REPEAT_S`, T) |

Only one audible alert is presented at a time (the arbiter picks the highest-priority audible
event and holds lower priorities for 3 s, T); the banner always shows the highest-priority active
alert; the overlay pre-empts the banner.

## 2. Event table

Voice lines are ≤ 8 words, imperative, no jargon.  "Tone" names the WAV in
`assets/sounds/dms/` (synthesised: `double_high` 1760 Hz × 2, `double_low` 440 Hz × 2, `single_low`
392 Hz, `siren` 900↔1500 Hz sweep, 1 s).  Priority and severity are the reference's.

| event | severity / priority | banner text | voice | tone | haptic | ack |
|---|---|---|---|---|---|---|
| EYES_CLOSED | CRITICAL 100 | EYES CLOSED — WAKE UP | "Wake up! Eyes open!" | siren | heavy × 3 | never |
| SLEEP | CRITICAL 98 | Asleep — WAKE UP | "Wake up!" | siren | heavy × 3 | never |
| MICROSLEEP | CRITICAL 95 | Microsleep — eyes open! | "Eyes open!" | siren | heavy × 3 | never |
| SEVERE_DROWSY | CRITICAL 90 | Severe drowsiness — stop driving | "You are very drowsy. Pull over." | double_low | heavy × 3 | 30 s |
| PROLONGED_STARE | CRITICAL 85 | Look back at the road! | "Look at the road!" | double_high | heavy × 3 | 30 s |
| LONG_GLANCE | WARNING 80 | Eyes off the road too long | "Eyes on the road." | double_high | warning | 30 s |
| PHONE_PATTERN | WARNING 75 | Repeated glances down — phone? | "Put the phone down." | double_high | warning | 30 s |
| VATS_DISTRACTION | WARNING 70 | Too much time looking away | "Keep your eyes on the road." | double_high | warning | 30 s |
| ATTENTION_BUFFER_EMPTY | WARNING 68, not audible (T) | (gauge only) | — | — | — | — |
| OFF_ROAD_GLANCE | INFO 65 | — (statistics) | — | — | — | — |
| HEAD_DOWN | WARNING 60, audible only while the eyes are unreadable (T) | Head down | "Head up, eyes on the road." | double_high | warning | 30 s |
| HEAD_TURNED | WARNING 55, audible only while the eyes are unreadable (T) | Head turned away | "Face the road." | double_high | warning | 30 s |
| DROWSY | WARNING 50 | Drowsiness detected — take a break | "You seem drowsy. Consider a break." | double_low | warning | 30 s |
| FREQUENT_YAWNING | WARNING 45, audible only above ALERT (T) | Frequent yawning — take a break | "Frequent yawning. Take a break soon." | double_low | warning | 30 s |
| PROLONGED_CLOSURE | WARNING 40, not audible (silent pre-alarm, T) | (pill: "Eyes closing") | — | — | — | — |
| SLOW_BLINKS | INFO 35 | — | — | — | — | — |
| DRIVER_NOT_VISIBLE | WARNING 30 (audible from 10 s, repeat 30 s) | Can't see you — adjust the phone | "I can't see your face." | single_low | — | never |
| HEAD_NOD, YAWN, GAZE_CONCENTRATION, NO_MIRROR_CHECK | INFO | — (drive summary) | — | — | — | — |
| CALIBRATION_PROVISIONAL / CONFIRMED | INFO | pill change (§5) | — | — | — | — |
| RECALIBRATED / REFERENCE_STALE / CAMERA_MOVED / DRIVER_CHANGE | INFO | pill change (§5); CAMERA_MOVED shows "Phone moved — re-learning" for 5 s | — | — | — | — |
| EYES_UNREADABLE | INFO | pill "Eyes not visible — head-only" | — | — | — | — |
| DROWSINESS_RECOVERED | INFO | pill returns to normal | — | — | — | — |

Speed gate (T, R §6): when the GPS speed is known and below 10 km/h, every event except
DRIVER_NOT_VISIBLE and the closed-eye family (PROLONGED_CLOSURE, MICROSLEEP, SLEEP, EYES_CLOSED) is
neither voiced nor shown as a banner — it is still logged and counted in the summary as
"suppressed (stationary)".  The drowsiness level pill is shown regardless of speed.

## 3. Channels and their arbitration

* **Voice (expo-speech).**  The app already speaks speed-limit changes.  A monitoring alert
  calls `Speech.stop()` first (it has priority over the speed-limit line), speaks at rate 1.0
  and pitch 1.0 (the speed-limit voice uses 0.8 / 0.8; a different voice reads as a different
  source), and never queues: if a new alert arrives while one is being spoken, the higher
  priority wins and the other is dropped (the banner still shows it).  Voice is off entirely
  with `@monitorVoice = false`; CRITICAL still plays the siren and haptics.
* **Tone (expo-audio).**  Four players created once per drive (`useAudioPlayer` per file), each
  `seekTo(0); play()` on use; `setAudioModeAsync({ playsInSilentMode: true })` is already set by
  the drive screen so the ring/silent switch does not mute safety tones.  When a tone and a voice
  line coincide the tone plays first and the voice follows ~250 ms later (a `setTimeout`),
  because the tone is the learned signal and the words are the explanation.
* **Haptics (expo-haptics, added).**  WARNING → `Haptics.notificationAsync(Warning)`; CRITICAL →
  three `Haptics.impactAsync(Heavy)` 150 ms apart, repeated with the siren.  On a dash mount the
  driver may not feel the phone; haptics are a complement, never the only channel.
* **Screen.**  WARNING banner: full width under the status area, 88 px tall, icon + one line of
  text + "Got it"; slides in 200 ms, stays for max(4 s, condition + 2 s), fades out.
  CRITICAL overlay: covers the screen with 85 % red (`t.colors.danger`) and a 40-pt message,
  pulses every 1.5 s with the siren; tapping it acknowledges when the event type allows
  acknowledgement (§4) and otherwise does nothing.  Colours come from the design tokens
  (`theme/tokens.js`: `danger`, `warning`, `accent`); drowsiness banners use a distinct purple
  (`#7c5cff`) added as `monitorDrowsy` so the two families look different at a glance.  All text
  is ≥ 17 pt, high contrast, and every alert carries an icon plus text (never colour alone).

## 4. Acknowledgement, termination, hysteresis

* Tapping "Got it" (or the CRITICAL overlay where allowed) calls `monitor.acknowledge(t)`: every
  WARNING/CRITICAL type heard from in the last 3 s is silenced for 30 s (`ack_suppress_s`, T;
  Euro NCAP allows suppression after acknowledgement, R §1).  At most 3 acknowledgements per
  120 s count (`ack_abuse_count`, T); the closed-eye family and DRIVER_NOT_VISIBLE cannot be
  acknowledged (T).
* Termination: a banner clears 2 s after its condition ends (Euro NCAP: termination 2 s after the
  end of a transient state, R §1); the overlay clears as soon as the eyes reopen for one frame
  above the closure exit threshold plus 1 s (Euro NCAP: 1 s of continuous forward gaze), because
  a closed-eye siren that outlives the closure trains the driver to ignore it.
* Escalation: a glance that persists past its limit repeats the WARNING every 2 s and becomes a
  PROLONGED_STARE (CRITICAL) 3 s after the limit (T; Euro NCAP "unresponsive": no return to the
  road within 3 s of the warning, R §1).
* Rate limits beyond the arbiter: at most 12 voiced alerts per 10 minutes; past that the voice
  channel is muted for the rest of the 10-minute window (tones and banners continue) and a
  "Frequent alerts — check the mount" pill appears.  This is a safety valve against a broken
  setup (a phone pointed at the passenger, a mirror flag error), not a tuning knob; the
  reference measures 0.13 alerts per hour on attentive drivers.

## 5. Status pill (calibration and system state)

A small pill in the drive screen header, always visible while monitoring is enabled.

| state | pill | colour |
|---|---|---|
| permission denied | "Monitoring off — camera permission" (tap → settings) | grey |
| camera starting | "Starting camera…" | grey |
| no face for > 5 s | "No face — adjust the mount" | amber |
| face, reference NONE | "Learning your view" + ring (admitted s / 60) | grey → teal ring |
| PROVISIONAL / STALE | "Almost ready" | amber ring |
| CONFIRMED | "Watching" (+ a subtle eye icon) | teal |
| eyes unreadable ≥ 10 s | "Eyes not visible — head-only" | amber |
| drowsiness level DROWSY / SEVERE | "Drowsy" / "Very drowsy" replaces the label | purple / red |
| 60-s PERCLOS ≥ 0.08 while the level is ALERT | "Consider a break soon" (display only, R §6: the DDWS advisory level) | purple outline |
| camera moved | "Phone moved — re-learning" (5 s) then the learning ring | amber |
| thermal / low-power throttle | "Reduced monitoring (hot / low power)" | grey |
| thermal pause | "Monitoring paused — phone too hot" | grey |
| frequent alerts (§4) | "Frequent alerts — check the mount" | amber |

Tapping the pill opens a sheet with the live values (fps, confidence, admitted seconds, PERCLOS,
last alert) and the actions "Re-learn forward view" (`resetCalibration`), "Show preview" (30 s
of camera preview for aiming), and a link to the settings.

## 6. Drive start and end

* Start: if `@monitorEnabled`, request the camera permission on first use with the explanation
  "RoadCash uses the front camera during a drive to warn you when your eyes leave the road or
  close.  Video never leaves the phone and is never stored."  On grant, start the camera; speak
  the optional startup line once the vehicle first exceeds 10 km/h (not before: the driver is
  still parking or pulling out).  Denied → the drive continues without monitoring, the pill says
  so, and no points are withheld.
* End ("Complete Drive" or the 2-minute background timeout): stop the camera, persist the
  reference if CONFIRMED (D §5), write the summary (D §10), and speak nothing.

## 7. Copy for the onboarding / settings screen (what the system can and cannot do)

"RoadCash watches your eyes and head with the front camera while you drive.  It learns where
'the road' is on its own during the first minute or two — no setup.  It warns you when a glance
away lasts too long, when you keep looking down, when your eyes close, and when you look drowsy.
It cannot see your hands or a phone held high, does not work with dark sunglasses (it then
watches your head only), and needs to see your face — mount the phone so the camera faces you.
Nothing is recorded; the camera images never leave your phone."
