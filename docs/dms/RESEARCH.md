# Driver monitoring — research summary (angle, time, drowsiness, false alarms)

Consolidated answers to the owner's questions, with sources.  Marks: **[V]** read in the primary
text, **[S]** secondary summary or abstract only, **[E]** our own estimate, **[M]** measured in
this project (Look Both Ways, 75 sessions of attentive drivers, or the synthetic battery).  The
full evidence, quotes and URLs are in the two memos this summary condenses —
`research/attention_angle_time.md` (A) and `research/drowsiness_metrics.md` (D) — and in the
reference stack's earlier memo `deployment-stack/docs/research/dms_standards_and_thresholds.md`.
The inference-library survey is `research/mobile_inference_options.md`.

## 0. The owner's questions, answered in one paragraph each

**"If I look 5° / 10° / 15° / 20° / 25° off the road centre, how many seconds until it is
unsafe?"**  No standard and no study gives a per-angle time.  Every regulation defines distraction
by the *target* the driver looks at (mirror, cluster, infotainment, passenger, lap), not by an
angle, and leaves the angular geometry to the manufacturer [V, Euro NCAP DSM v1.1/v1.2; EU ADDW
2023/2590].  Up to about 20° of eccentricity the driver is still looking through the windshield,
so no timer runs at all; the first limit appears when the gaze leaves the forward road view, and
it is 3–4 s for a single glance (Euro NCAP long distraction [V]; ADDW 3.5 s at ≥ 50 km/h, 6 s at
20–50 km/h [V]; NHTSA marks 2 s as where crash risk starts to rise, OR 2.19 [V]) and 10 s
cumulative in 30 s (Euro NCAP VATS [V]).  The table in §1 maps angle bands to the target they
most likely contain and to that target's limit.

**"Is there a formula relating time and angle?"**  No.  Liang, Lee & Yekhshatyan (2012) tested 24
crash-risk algorithms on 100-Car data and found that weighting glance duration by glance
location predicted no better than duration alone [V abs].  What angle does change is how much of
the road the driver still perceives: the time-to-collision at which a driver notices a
decelerating lead car falls from 6–8 s at 0° eccentricity to 4 s at 90° (Lamble et al. 1999 [V
abs]), and hazard detection on a real highway is flat through the near periphery and declines
rapidly beyond 20–30°, with a useful field to ~70° (Morando et al. 2022 [V abs]).  The practical
rule (A §2.5, [E]): the angle picks the target class, the class gives the time limit, and the
angle only scales the severity weight (1.0 at ≤ 20° rising to 2.0 at 60°) — never a shorter limit
than the regulatory 3.0–3.5 s.

**"Does the rule change for the mirrors?"**  Yes, by class, not by a shorter timer: NHTSA's
guidelines explicitly do not apply to mirror and gauge glances [V, Table 3]; Euro NCAP scores
driving-task targets (mirrors, cluster) separately but keeps the 3–4 s window [V]; 100-Car found
driving-related glances < 2 s protective (OR 0.45) [V]; AttenD grants the first second of a
mirror/speedometer glance [S].  Measured mirror glances last 0.6–1.1 s on average (Taoka 1990
[V]; 99th percentile ≈ 2.0–2.4 s [E]), so a 4-s limit with a 1-s allowance never fires on a real
mirror check.

**"What about up and down?"**  The one regulatory vertical angle is 30° down: everything below a
plane 30° below the eyes is ADDW "Area 3" (lap, console, footwell, hand-held phone) with the
3.5 s / 6 s timers [V], and NHTSA independently caps every compliant display at a 30.00° (2-D)
or 28.16° (3-D) downward viewing angle [V].  The cluster (≈ −25°) and centre display (≈ −20°)
sit above that plane and are driving-related [E geometry].  Upward: no standard sets a limit;
ADDW Area 1 includes the roof [V], so a sustained gaze above +30° cannot be the road; a lowered sun
visor is ≈ +32°, an overhead traffic light 8 m ahead ≈ +18° [E].

**"How many degrees is 100 % off-road?"**  Below −30° (Area 3 / NHTSA display ceiling) [V];
above +30° (roof, Area 1) [V]; beyond ±55° laterally (Area 1) [V] — refined for the cabin to
about 65° on the driver's side (beyond the side glass edge) and 75° on the passenger's side
(beyond the passenger mirror at ≈ 46° and the glovebox at ≈ 53°, short of the passenger's face
at ≈ 82°) [E].  On our sensor every vertical rule is a head-pitch rule (the landmark gaze reads
relative pitch at gain ≈ 0.1 on drivers [M]).

**"What indicates drowsiness from landmarks; eyes closed X seconds at Y frequency?"**  Eye
closure is the whole regulated signal: microsleep = closure 1–2 s, sleep ≥ 3 s, unresponsive
≥ 6 s (Euro NCAP [V]).  The continuous measure is PERCLOS (P80: share of time the eyes are
≥ 80 % closed, slow closures only — blinks excluded) with 15 % over 60 s as the modern operating
point and > 10 % as the drowsy band over 60–180 s [V]; mean closure duration outperforms PERCLOS
at minute resolution (AUC 0.82 vs 0.68 [V]); blink *rate* is not a usable signal (ρ ≈ 0 with KSS
on 90 h of real driving [V]); long blinks are > 500 ms [V].  Yawns: a yawn holds the mouth open
~6 s [V]; there is **no validated yawns-per-hour threshold** and about half of yawns are
hand-covered [S], so yawning is corroboration only.  Head nods are the last and weakest cue [V].

## 1. Angle versus time (left-hand-drive car; "left" = driver's side)

Limits are per target class (Euro NCAP / ADDW); the angle bands and the targets in them are
geometric estimates [E] for a typical cabin (eye point 0.65 m behind the cluster; A §1.1 gives
the offsets so any value can be re-derived).

| horizontal eccentricity | most likely target | class | single-glance limit | cumulative |
|---|---|---|---|---|
| 0–5° | windshield centre, own lane, lead vehicle | forward road view | none | — |
| 5–10° | own / adjacent lane, road edge | forward road view | none | — |
| 10–15° | adjacent lanes at 25–60 m, signs, oncoming lane | forward road view (windshield) | none | — |
| 15–20° | outer windshield, A-pillar edge, mirror housings | forward view / boundary | none | counts toward VATS |
| 20–25° | rear-view mirror (≈ 29° right, 16° up), upper centre stack | mirror = driving-task; stack = non-driving | 4 s (first 1 s free) / 3 s | 10 s in 30 s |
| 25–30° | rear-view mirror, centre display (≈ 33°), dash-mounted phone | driving-task / non-driving | 4 s / 3 s (ADDW 3.5 s ≥ 50 km/h) | 10 s in 30 s |
| 30–45° | centre stack, driver's door mirror (≈ 39° left) | mirror / non-driving | 4 s (1 s free) / 3 s | 10 s in 30 s |
| 45–60° | passenger mirror (≈ 46° right), glovebox (≈ 53°), shoulder check | mirror / non-driving; beyond 55° = ADDW Area 1 | 4 s / 3 s; relax to 4 s at intersections (far-left glances average 2.4 s in the last 30 m, FHWA SHRP2 [V]) | 10 s in 30 s |
| > 60° | side glass (63–90° left), passenger face (≈ 82° right), rear cabin | never the road; Owl targets | 3 s (2 s once ≥ 50 km/h is known [E]) | 10 s in 30 s |

| vertical | target | class | limit |
|---|---|---|---|
| up 0–10° | upper windshield, distant signs | forward | none |
| up 10–20° | rear-view mirror (+16°), overhead light at 8 m (+18°) | driving-task | 4 s, 1 s free |
| up 20–30° | sun visor (+32° lowered), header rail | non-driving | 3 s |
| up > 30° | headliner, roof, overhead console (+49°) — ADDW Area 1 | never the road | 2 s [E] |
| down 0–10° | road 7–14 m ahead, bonnet | forward | none |
| down 10–20° | cluster upper edge, HUD, dash-mounted phone (−13°) | driving-task, or a phone | 4 s; phone pattern |
| down 20–30° | cluster centre (−25°), phone at wheel top (−24°), centre stack (−20°); NHTSA display ceiling 28–30° | driving-task / non-driving | 4 s / 3 s |
| down > 30° | lap, hand-held phone (−50°), knee (−60°), footwell — ADDW Area 3 | 100 % off-road | 3.0 s (ADDW 3.5 s ≥ 50 km/h, 6 s at 20–50 km/h) |

Cumulative, angle-free rules: Euro NCAP VATS 10 s in 30 s [V] (Seeing Machines' operational
form adds "no return to the road ≥ 2 s" and counts non-driving targets only [S]); NHTSA per task:
TEORT ≤ 12 s, mean glance ≤ 2 s, ≤ 15 % of glances > 2 s [V]; AttenD 2-s buffer draining at 1 s/s
off-road, refilling on-road, mirrors/speedometer decrement after 1 s [S].

## 2. The relations in the literature

* **Risk vs duration.**  100-Car (Klauer 2006) odds ratios by total eyes-off-road in a 6-s
  window: ≤ 0.5 s 1.31 (n.s.), 0.5–2 s ≈ 1, > 2 s **2.19** (CI 1.72–2.78) [V].  SHRP2 "Safer
  Glances" (Victor 2015): the best predictors are the proportion of time off path in the 3 → 1 s
  before the event and the mean off-path glance duration [S].  Kotseruba & Tsotsos 2021 review
  confirms the 2-s rule [V].
* **Duration alone is the signal.**  Liang, Lee & Yekhshatyan 2012: location-weighted duration
  and the 1.5th power of duration perform the same as plain duration [V abs].
* **Eccentricity and perception.**  Lamble 1999: detection TTC 6–8 s at 0° → 4 s at 90° [V abs];
  Morando 2020: glance response time independent of eccentricity, brake RT rises, detection
  falls at 12° / 40° / 60° [V abs]; Morando 2022: detection flat through the near periphery,
  declining beyond 20–30°, useful field to ~70° [V abs]; Markkula 2021: partial looming
  perception during off-road glances [V abs]; Seppelt 2017: near-crash drivers sample the
  periphery more than crash drivers [V abs].
* **Road-centre region.**  Volvo's patent: mode of the gaze histogram; an 8° radius or a
  20 × 40° oval; PRC > 92 % = cognitive warning, long-glance warning at 4 s, initialised after
  ~20 s above 70 km/h, stable after ~2 min [V].  Research conventions: 6–10° radius, 20 × 15°
  rectangle [V].  These are *measurement* regions for a lab eye tracker; with a 6.4° estimator
  [M] the decision region must be the windshield (22 × 14°): with a 15 × 10° "road" the rules
  voiced 63 alerts/h on attentive drivers, 38.6/h of them with the true gaze inside the
  windshield [M].
* **The synthesised app relation** (A §2.5, [E]): forward ellipse 22 × 14° → no timer; else
  `T_limit = T_class × k_v(speed)` with `T_class` 4 s (driving-task, 1 s free), 3 s (cabin),
  4 s lateral when moving ≥ 30 km/h else 12 s; `k_v` 1.0 at ≥ 50 km/h, 1.7 at 20–50 km/h (the
  ADDW 6 ÷ 3.5 ratio, the only published speed scaling [V]); severity `= t / T_limit × w(ε)`,
  `w` 1.0 to 20°, 2.0 at 60°.  The shipped configuration uses the strict Euro NCAP values as
  "standard" and the ADDW upper bounds as "relaxed" (DETECTION_DESIGN §7).

## 3. Mirror and instrument-cluster exceptions

NHTSA 2013 Table 3: mirrors and gauges — "Guidelines applicable? No" [V].  Euro NCAP:
driving-task long distraction scored separately, same 3–4 s window [V].  100-Car: driving-related
glances < 2 s, OR 0.45 [V].  Taoka 1990 (Green, UMTRI-98-16): left mirror 1.10 ± 0.30 s, right
mirror 0.75 ± 0.36 s, speedometer 0.62 ± 0.48 s, radio 1.44 ± 0.50 s [V]; Rockwell 1988: inside
mirror 0.5–0.7 s, exact speedometer read 1.2 s [V].  The overtaking paradox: a Euro-NCAP-style
algorithm flagged driving-related distraction in 50 % of overtaking manoeuvres because of the
mirror checks (AutomotiveUI 2024 [V abs]) — hence the 1-s allowance, the 4-s limit and no
escalation on repeated mirror glances.

## 4. Vertical glances and the phone

ADDW Area 3 (below 30°) with 3.5 s / 6 s [V]; NHTSA display ceilings 30.00° / 28.16° [V]; Euro
NCAP phone-use targets: basic — knee, lap, dash mount, charge port, wheel centre below the
cluster; advanced — dash mount, 9–11 / 13–15 o'clock on the wheel, inside the windscreen view,
in the cluster view [V].  A dash-mounted phone (≈ −13°) and a wheel-top phone (≈ −24°) are ABOVE
the Area-3 plane [E]: they must be caught by the dwell *pattern* (repeated 0.6–2 s looks down),
not by the angle.  On this sensor the pattern is read from the head pitch (LOOK_DOWN at −12° of
head pitch), so eyes-only glances at a high-held phone are not observable [M].  VTTI texting
statistics: mean off-road glance ~1.5–2 s, TEORT well above 12 s [S].

## 5. 100 % off-road bounds

| bound | beyond it | source |
|---|---|---|
| pitch < −30° | lap, console, footwell, hand-held phone; below every compliant display | ADDW Area 3 [V]; NHTSA [V] |
| pitch > +30° | headliner, roof (ADDW Area 1 includes the roof) | ADDW [V] |
| yaw beyond ±55° | outside the ADDW Area-1 planes | ADDW [V] |
| yaw beyond ≈ 65° driver side | the side glass; road behind the A-pillar | geometry [E]; Euro NCAP driver window = Owl target [V] |
| yaw beyond ≈ 75° passenger side | passenger face (≈ 82°), seat, rear cabin | geometry [E]; Euro NCAP passenger face [V] |

## 6. Drowsiness metrics (landmark-only sensor)

| metric | what it needs | evidence and thresholds |
|---|---|---|
| eye closure (EAR, 6-point, near eye, per-driver openness) | ≥ 10 fps for closures; 2-D EAR is pose-dependent | Soukupová & Čech: blink 100–400 ms, EAR threshold dataset-dependent [V]; open-eye baseline must be per driver ("eyes wide open = 0 %", Wierwille 1994 [V]); ≈ 10 % of drivers fall below a fixed 0.23 threshold [E] |
| closure duration bins | consecutive frames | blink < 0.4 s (alert 111 ± 51 ms, Johns 2003 [V]); long blink > **0.5 s** (Johns; Wilkinson 2013 [V] — 0.4 s has no source); prolonged closure 0.5–1.5 s (Friedrichs & Yang 0.5 / 1 s events [V]; Bosch patent warns at 1 s [V]); microsleep 1–2 s, fire at 1.5 s (Euro NCAP [V]; Guardian 1.5 s [V]; 34–39 % of EEG microsleeps are < 3 s, Skorucak 2020 [V]); sleep ≥ 3 s [V]; unresponsive ≥ 6 s [V]; BERN microsleep criteria: lids ≥ 80 % closed, 1–15 s (Hertig-Godeschalk 2020 [V]) |
| PERCLOS (P80) | 5 fps suffices; blinks excluded | definitions Wierwille 1994 / Dinges & Grace 1998 [V]; bands < 0.075 awake, 0.075–0.15 questionable, > 0.15 drowsy (Wierwille 1994, eyeballed from 12 subjects [V]); DDWS field trial advisory 8 % / warning 12 % over 1–5 min [V]; SHRP2 crash coding 12 % over 3 min [V]; modern DMS 15 % over 60 s at a 0.20 closure level: hit 80 %, FA 8.6 %, true sensitivity ≈ 45 % (Llaneras, Meyer & Barnes, NSTSCE 25-UI-177, 2026 [V]; decomposition [E]); > 10 % drowsy over a 60-s rolling window (NSTSCE 26-UI-182 [V]); 1-min vs 3-min windows flip 17–50 % of drowsy calls (NSTSCE 24-UI-134 [V]); 20-min windows correlate best with PVT lapses (Dinges & Grace [V]) |
| mean closure duration | ≥ 15 fps, ≥ 10 blinks | AUC 0.82–0.83 vs %TEC 0.68 (Wilkinson 2013, 33 subjects [V]); dose–response with sleepiness (Ingre 2006; Caffier 2003 [V]); blink detection 51 % at 10 Hz vs 95 % at 30 Hz [V] |
| blink rate | — | not usable: ρ −0.11 / −0.04 with KSS on 90 h of real driving (Friedrichs & Yang [V]); direction disputed |
| amplitude-velocity ratio, saccades, pupil | 250–600 Hz | out of reach [V] |
| yawn (MAR = inner-lip gap / mouth width) | mouth visible | MAR > 0.5–0.6 sustained; yawn mean 6 s (Provine [V]; 6.28 s on 123 driver yawns [V]); drowsy > alert yawn frequency (p < 0.01) but no rate given [V]; "> 1 yawn/min = fatigued" is an unvalidated assertion (Kassem 2020 [S]); 44–67 % of yawns hand-covered [S]; "yawn" appears 0 times in Euro NCAP and DDAW [V] |
| head nod | head pitch from the network's rotation | drowsy nods 12–20° vs 2–8° normal [V]; closed eyes required to separate a nod from a cluster glance (Colic; Seeing Machines US11144756B2 ±5° head pitch = a glance down [V]); the last and weakest cue (72.5 %, Bergasa 2006 [V]) |
| gaze stability | 60-s statistic of a 6°-error estimator | best of six cues in Bergasa 2006 (95.6 %, before the ocular cues) but on acted behaviour; acute sleep deprivation reverses the sign (saccade amplitude 19 → 28°) [V] — advisory only |
| fusion and level | — | Euro NCAP drowsiness = KSS > 7 [V]; DDAW KSS ≥ 8, sensitivity > 40 % [V]; DDAW warnings cascade until acknowledged [V]; no official recovery duration exists; the benefit of an alert does not last beyond the minute (Dinges & Grace [V]) |

## 7. False-alarm considerations

* **Speed.**  No distraction warning when stationary; Euro NCAP measures from 10 km/h after a
  1-minute allowance, warns from 20 km/h, learns impairment baselines from 50 km/h [V]; DDAW
  active above 70 km/h [V].  Speed influences off-road glance durations during phone tasks but
  not during normal driving (Tivesten & Dozza 2014 [V abs]).
* **Mirror scanning / overtaking** (§3); **intersections and turns**: far-side glances of
  2.4 s / 1.8 s in the last 30 m [V], drivers self-regulate in complex contexts [V] → lateral class
  12 s without speed, 4 s above 30 km/h, head-turn required [M].
* **Parking / drive-through**: speed gate.
* **Estimator error**: 6.4° mean [M] → windshield-sized forward region (§2); yaw gain ≈ 0.74,
  pitch gain ≈ 0.10 [M] → vertical rules from the head.
* **Debounce set** (sourced): 0.3 s in-out-in tolerance (ADDW §3.3.2.4 [V]); 0.4 s to open a
  glance [M]; 1 s of continuous forward gaze ends an intervention, 2 s after a transient state
  (Euro NCAP [V]); ≥ 60 s attentive before judging (ADDW spot check [V]); acknowledgement
  suppression per journey (Euro NCAP [V]); base rate of Euro-NCAP-defined long distraction ≈ 1 per
  1.1 h, VATS ≈ 1 per 4.8 h [S] → an alert rate above ~1/h in ordinary driving is almost certainly
  false.
* **Drowsiness false alarms**: the DDWS field trial's ~95 % false-alarm rate came from
  "eyes not found = eyes closed" (39 %) and gaze/head rotation (35 %) [V] → unusable frames count in
  neither PERCLOS term; look-down lowers the lids (34 % of the aperture at 40° of downgaze [V],
  ≈ 0.6–0.9 %/deg) → look-down guard and deep-closure requirement; far-eye hallucination in head
  turns [M] → near-eye read and a 45° gate; sunglasses are opaque to a visible-light sensor →
  head-only mode and "inform within 10 s" (Euro NCAP occlusion table [V]); talking/singing → MAR
  must stay above threshold on every frame for ≥ 1.5 s [M: zero false yawns in 7.55 h]; a
  phase-locked 5-fps stream reads PERCLOS 0.25 from normal blinking [E] → blink exclusion and
  blink statistics suppressed below 15 fps.

## 8. Where the phone configuration departs from the reference stack, and why

| change | value | basis |
|---|---|---|
| lateral hard limit asymmetric | driver side 75°, passenger side 65° (was 60 / 60) | §5 [E]; intersections [V] |
| calibration admission while stationary | weight 0.25 (was 1.0) | Volvo initialises above 70 km/h [V]; Euro NCAP 1 min at ≥ 10 km/h [V]; parked conversations would bootstrap a wrong reference [E] |
| persisted forward reference across drives (STALE seed) | on | Euro NCAP per-journey re-enable and driver identification [V]; the reference's own STALE re-validation path [M] |
| open-eye baseline floor after 120 s | floor = 0.9 × the frozen alert median | sleepy drivers stop fully opening the eyes (Friedrichs & Yang [V]); production practice freezes an alert baseline (US10740633B2 [V]) |
| PERCLOS excludes closures < 0.25 s | on | PERCLOS is defined on slow closures (Wierwille; Abe 2023 cut-offs 250–500 ms [V]) |
| long blink / slow-blink mean | 0.5 s (was 0.4) | Johns 2003, Wilkinson 2013 [V] |
| blink statistics below 15 fps | suppressed | 51 % detection at 10 Hz [V] |
| long-blink score weight | 30 with ≥ 10 blinks (was 20 with ≥ 5) | closure duration AUC 0.82 vs PERCLOS 0.68 [V] |
| PERCLOS 60-s ≥ 0.08 | display-only "consider a break" hint | DDWS advisory level [V] |
| not adopted | head-roll rule, blink-rate scoring, yawn-triggered alerts, a 130-ms closure floor on falling head pitch (covered by the look-down guard), gaze-concentration drowsiness alarm | D §9.1 |

Corrections to the reference documentation found on the way (the deployment stack is read-only;
recorded here): `THRESHOLDS.md` cites "Meyer & Llaneras 2022, > 10 % over 150 s" — the source is
Llaneras & Meyer, NSTSCE 26-UI-182 (2026), > 10 % over a 60-s rolling window; "25-UI-177" is
Llaneras, Meyer & Barnes (2026) and its 80.05 % is an overall hit rate, not sensitivity;
`long_blink_s` 0.4 s has no primary source; blink *duration* (not velocity) is observable at 15 fps.
