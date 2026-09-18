# Drowsiness from face landmarks alone — what is measurable, what it means, and where to set the thresholds

Research memo for the RoadCash phone DMS, 2026-09-18.  Sensor: one phone front camera on a dash
mount, visible light only, MediaPipe 478-point face mesh + the camera-frame gaze vector, 15–30 fps.
No infrared, no EEG, no lane or steering telemetry, no pupil diameter.

This memo answers three questions the owner asked: **what can gaze and landmarks measure that
indicates drowsiness; how does eye-closure duration and frequency map onto a driver state; and how
does yawn detection work and at what rate is it unsafe.**  It extends and, in four places,
*corrects* the earlier sourced memo `deployment-stack/docs/research/dms_standards_and_thresholds.md`
(cited below as **SM §n**) and the shipped thresholds in `deployment-stack/docs/THRESHOLDS.md` (**T**)
and `deployment-stack/docs/DESIGN.md` §6/§12 (**D6**, **D12**).

**Verification marks, used on every number.**
**[V]** = read directly in the primary text (PDF or HTML fetched and grepped; most government and
arXiv PDFs were downloaded and text-extracted locally).  **[S]** = only an abstract, a vendor page,
or a secondary source quoting the primary was reachable — said explicitly each time.  **[E]** = my
own arithmetic or estimate, not a measurement.  Where a source could not be found at all, the memo
says so rather than guessing.

---

## Answers in brief

* **Eye closure is the whole of the regulated drowsiness signal.**  Euro NCAP's Safe Driving DSM
  protocol v1.1 contains the word "yawn" **0 times**, "PERCLOS" **0 times** and "blink" **0 times**;
  it defines microsleep as a 1–2 s eye closure, sleep as ≥ 3 s, unresponsive as ≥ 6 s, and
  drowsiness as "a KSS level > 7 at the latest, or an equivalent metric" [V].
* **PERCLOS (P80) is the one validated continuous measure a landmark sensor can compute**, but its
  published "80 % hit rate" is not sensitivity — decomposing the source table gives a true
  drowsy-detection sensitivity of ~45 % [E on published counts], and the largest field trial of a
  PERCLOS device recorded **721 valid alerts out of >15,000**, i.e. ~95 % false alarms, ~35 % of them
  caused by gaze direction and head rotation alone [V].
* **Closure *duration* beats PERCLOS at minute resolution.**  In a 33-subject sleep-restriction
  crossover, the mean duration of eye-closure episodes reached ROC AUC 0.816–0.834 against missed
  vigilance signals, while %TEC (the PERCLOS analogue) reached only 0.683 [V].
* **Blink rate is not a usable drowsiness signal.**  On 90 h of real road driving it correlated with
  KSS at ρ_p −0.11 / ρ_s −0.04, essentially zero, and the direction of the effect is disputed in the
  literature [V].  Mean blink *duration* is usable at ≥ 15 fps; blink *velocity* and the
  amplitude–velocity ratio are not reachable below ~250–500 Hz [V].
* **Yawning is real but weak, late and structurally lossy.**  ~44 % of yawns are hand-covered even
  when the yawner is alone, and 51–67 % in public [S via a primary quoting two primaries] — a
  mouth-geometry detector structurally misses about half of them.  There is **no validated
  yawns-per-hour threshold** in the literature; the widely-quoted "more than one yawn per minute =
  fatigued" is an asserted heuristic in one conference paper with no validation against KSS or PVT
  [S].  Keep yawns as corroboration only, never as a trigger.
* **Head nods are the last cue to appear** and the worst-performing of six visual cues in the one
  study that ranked them (72.5 % vs PERCLOS 93.12 % and fixed gaze 95.62 %) [V].  Published nod
  thresholds span 12–20°, 21°, 30° and 45° for the same phenomenon — the cue is not a defined
  quantity.
* **The gaze vector adds exactly one drowsiness cue that a 6°-error, 30 fps estimator can actually
  compute: gaze *stability* (a second-order statistic of gaze direction over tens of seconds).**
  Everything else the gaze literature offers — saccadic peak velocity, microsaccades, slow eye
  movements, pupillary unrest — needs 200–600 Hz and/or millimetre pupillometry and is out of reach
  by one to two orders of magnitude [V].

---

## 1. What a landmark-only sensor can measure

### 1.1 The measurement chain

MediaPipe returns 478 3-D landmarks plus, optionally, 52 ARKit-style blendshape coefficients
computed **from the landmarks themselves** (the blendshape sub-model's input tensor is
`1 x 146 x 2`, i.e. 146 2-D landmark coordinates — no second image pass) [V,
https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker].  `eyeBlinkLeft`,
`eyeBlinkRight`, `eyeSquintLeft/Right` and `jawOpen` are therefore available to a landmark-only
pipeline at no extra image cost, and are a pose-robust alternative to raw EAR/MAR ratios worth
benchmarking.  Everything below is computed from the landmark cloud, the gaze vector and the
auxiliary head rotation.

### 1.2 Eye aspect ratio (EAR) and its pose dependence

EAR = (‖p2−p6‖ + ‖p3−p5‖) / (2‖p1−p4‖) over six eyelid/corner landmarks (Soukupová & Čech 2016)
[V, SM §3].  MediaPipe six-point sets: left 33, 160, 158, 133, 153, 144; right 362, 385, 387, 263,
373, 380 [V, SM §3].

EAR is a **2-D image-plane ratio and is therefore pose-dependent by construction**:
"is inherently viewpoint dependent, as it relies on 2D landmark distances that distort under head
rotation" [V, https://arxiv.org/html/2511.19519v1].  The same paper's 3-D replacement, the *eyelid
angle* (ELA, the angle between planes fitted to the upper and lower lid landmarks), "exhibits
significantly lower variance across viewing angles" and reaches 2.8° / 3.3° mean absolute error
under ±40° vertical / horizontal camera sweeps [V].

**No published study quantifies EAR error per degree of head yaw or pitch.**  An aggregator page
circulates a "15 %" figure; it does not appear in the primary paper and must not be cited [V,
checked].  The geometry is unambiguous though, and gives the sign: head **yaw** foreshortens the
eye-corner (denominator) distance by ≈ cos θ and leaves the vertical alone, so EAR is *inflated* by
≈ 1/cos θ (+6 % at 20°, +16 % at 30°, +30 % at 40°); head **pitch** foreshortens the numerator, so
EAR is *deflated* by ≈ cos φ (−6 % at 20°, −13 % at 30°) [E].  The two have opposite sign and a
mirror check does both at once.  Production systems do not correct for this; they gate it out —
a Mercedes/Seeing Machines real-road study declares the system active only for
"head yaw angle |ψ| ≤ 15°" [V, Friedrichs & Yang 2010].

**Consequence for us:** compute openness in the head frame (using the gaze model's auxiliary head
rotation), or use the ELA/blendshape form; and keep the existing `closure_head_turn_deg` gate.
T's 45° gate is far more permissive than the 15° used by an IR production system, which is
defensible only because our near-eye read (`ear_near`) already drops the foreshortened far eye
at a 0.85 corner-width ratio (**D6**).

### 1.3 Eyelid aperture and the mandatory per-driver baseline

Euro NCAP requires the DSM to be functional across an **eyelid aperture of 6.0 mm to 12.0 mm**,
"measured when driver is awake and attentive" [V, protocol v1.1 §1.1.1.1].  Published norms bracket
that range: 8.0 ± 1.0 mm (male) / 8.2 ± 1.1 mm (female) in 498 Asian adults [V,
https://pubmed.ncbi.nlm.nih.gov/18349663/]; 9.7 ± 1.2 mm in 76 young adults [V,
https://pubmed.ncbi.nlm.nih.gov/17041316/]; 11.55–11.94 mm in 103 Hong Kong young adults [V,
https://pmc.ncbi.nlm.nih.gov/articles/PMC3730197/].  **A 2× population range in the EAR numerator
makes a fixed absolute threshold indefensible.**

Measured directly in EAR units: across 27 drivers on a 640×480 30 fps webcam, open-eye EAR was
normally distributed with **mean 0.2570, SD 0.02109**, and the authors used a fixed closed-eye
threshold of 0.23 because it is "about 1.3 standard deviations below the average EAR" [V,
https://pmc.ncbi.nlm.nih.gov/articles/PMC12899127/].  **That means ≈ 10 % of drivers have a
fully-open-eye EAR at or below the fixed "closed" threshold** [E, normal tail at −1.28 SD] — one
driver in ten scored as permanently asleep.  Independently, per-video optimal EAR thresholds range
0.2103–0.2923 (a 39 % spread), and on one sequence the standard 0.2 threshold gave 21.1 % accuracy
where 0.2105 gave 95 % [V, https://pmc.ncbi.nlm.nih.gov/articles/PMC9044337/].  Personalised
thresholding measured +1.5 pp overall but, crucially, moved **open-eye** accuracy from 89.0 % to
98.9 % [V, https://arxiv.org/html/2604.22479] — that is the false-alarm axis.

From 90 h of real-road driving with a production IR DMS: "Baselining was needed, as it was observed
that there are huge variations between different drivers, especially regarding to blink duration
and frequency… The variation between drivers has a severe impact on the features and overlays the
drowsiness-related patterns" [V, Friedrichs & Yang 2010].  Their baseline is the mean or maximum of
each feature over **the first 15 minutes of the drive**, assumed awake.

**A caveat that directly threatens our design.**  The same study observes: "We observed that drivers
often do not completely open their eyes any more when they become sleepy" [V].  A *running* open-eye
baseline (ours is a 120-s running median, **D6**) will therefore track the driver down into
drowsiness and desensitise the detector exactly when it matters.  Production practice is a
**fixed baseline captured while the driver is known-alert**: Seeing Machines' calibration patent
takes "the median of the EO values" over ~90 frames (~3 s at 30 fps) "at the beginning of a driving
excursion, when the driver is assumed to not be drowsy" [V,
https://patents.google.com/patent/US10740633B2/en].  See §9 for the recommended change.

### 1.4 PERCLOS

The canonical continuous measure.  Full treatment in §2.

### 1.5 Blink duration, frequency, amplitude–velocity ratio

Reference values, read in the primary: "While blink duration in rested conditions lasts for less
than 200 ms, sleep deprivation results in increased blink duration, episodes of slow eye closure
lasting more than 500 ms, and increased proportion of time the eyes are closed" [V, Wilkinson et al.
2013, https://pmc.ncbi.nlm.nih.gov/articles/PMC3836343/].  A blink lasts ≈ 100–400 ms overall
(Soukupová & Čech; Harvard BioNumbers) [V, SM §3]; a rested adult blinks ≈ 15–20 per minute, falling
to ≈ 3 per minute under cognitive load [V, Friedrichs & Yang quoting Andreassi and Svensson].

The **amplitude–velocity ratio (AVR)** — the ratio of an eyelid movement's amplitude to its peak
velocity — is the single best eyelid feature measured against KSS on real roads (ρ_p +0.50, ρ_s
+0.53), ahead of average eye-closure speed (−0.46 / −0.48) and far ahead of PERCLOS70 baselined
(+0.27 / +0.40) [V, Friedrichs & Yang, Table IV].  **It is also unreachable on a phone.**  See §1.11.

### 1.6 Long-closure share and prolonged closures

"The proportion of long closure duration blinks proves to be an informative parameter" (Caffier
et al. 2003, 60 subjects) [S — PubMed abstract only, the full text is paywalled,
https://pubmed.ncbi.nlm.nih.gov/12736840/].  Quantified on 20 sleep-deprived professional drivers,
with closures scored at "80 % closure as per PERCLOS ≥ 1 s": median **0 s/h of eyelid closure after
3 h awake rising to 34 s/h after 23 h awake**, with "episodes lasting from 7 seconds up to 18
seconds" developing after 20 h; closure frequency correlated with crashes r = 0.43 (p < 0.01) and
with SD of lateral lane position r = 0.60 (p < 0.01) [V,
https://pmc.ncbi.nlm.nih.gov/articles/PMC4957187/].  Note the scale: even at 23 h awake, closures
≥ 1 s occupy **under 1 % of the hour** — PERCLOS's 10–15 % comes overwhelmingly from partial droops,
not from long closures.

### 1.7 Microsleep

See §3.  The BERN visual-scoring criteria (Hertig-Godeschalk et al. 2020, SLEEP 43(1):zsz163) are
cited in **T** as "1–15 s with the lids ≥ 80 % closed"; the primary is paywalled at Oxford and the
open repository copies at ZORA/BORIS are behind bot protection, so **that criterion remains [S] for
us** and should be labelled as such wherever it is quoted.  The independently readable definitions
are: "brief (0.5–15 s) episodes of complete failure to respond accompanied by slow eye-closures"
(Poudel et al. 2014) [V abstract, SM §3]; polysomnographic microsleep "lasting from 3 to 15 s, with
no blink on the electro-oculogram nor on the frontal leads of the EEG" [S,
https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8161762/]; and the operational DMS definition "eye
closures longer than 0.5 s (1 s for MICROSLEEP1S)", of which the paper notes "MICROSLEEP events
occur in an advanced phase of drowsiness" [V, Friedrichs & Yang].

### 1.8 Mouth aspect ratio and yawning

See §5.

### 1.9 Head pitch (nods) and head roll

See §6.

### 1.10 Gaze-derived cues — what the gaze vector actually adds

The gaze model gives a camera-frame direction at ≈ 6.3° mean absolute error at 15–30 fps.  Against
that, the gaze literature splits cleanly into *reachable* and *unreachable*:

**Reachable — gaze stability / dispersion.**  Bergasa et al. (IEEE T-ITS 7(1), 2006) compute a
"fixed gaze" parameter as the mean + SD of horizontal pupil position over 2-s windows averaged over
60 s, and it is **the best of their six visual parameters at 95.62 % correct detection with no false
positives**; "A fatigued driver loses the focus of the gaze… This loss of concentration usually
takes place before other sleepy behaviors do, such as nodding" [V,
https://invett.aut.uah.es/sotelo/IEEETITS2006.pdf].  Their operating points: "a level above 0.05 is
always considered to be an indicator of drowsiness.  Values greater than 0.15 represent a high
inattentiveness probability", reaching 0.4 in their fatigue bouts [V].  **Caveat, read in the same
paper: the ground truth was "manually obtained by analyzing eye movements frame by frame for the
intervals where a fixed gaze behavior was being simulated" — the cue is validated against acted,
not spontaneous, drowsiness** [V].  Corroboration on real drivers: an observer-rating rubric built
from 223 night-shift drivers' own vehicles places "fixating on single points" at the *Moderately
Drowsy* level [V, https://arxiv.org/pdf/2010.11162]; 36 commercial drivers showed on-road fixation
duration **+58.80 %** and deviation of visual search angle **−26.94 %** after 4 h of driving [V,
https://www.czasopisma.pan.pl/Content/115590/PDF/11_ace-2018-0023.pdf].

**The direction is not settled.**  Under *acute total sleep deprivation* the opposite is measured:
fixation rate fell 76.91 ± 16.50 → 60.80 ± 19.74 per minute (p = 0.002) while **saccade amplitude
rose 19.16 ± 11.05 → 27.77 ± 13.26°** (p = 0.031) and gaze entropy increased, which the authors read
as "a more dispersed distribution of gaze"; lane-departure odds ratio 3.20 (95 % CI 1.49–7.34) [V,
https://pmc.ncbi.nlm.nih.gov/articles/PMC5797225/].  The one quantity both camps agree on is
**fixation duration rising**.  Treat gaze concentration as an *advisory* only, never an alarm.

**Not reachable from this sensor** (see §1.11): saccadic peak velocity, microsaccades, slow eye
movements, pupillary unrest.

### 1.11 What is NOT measurable, and why

| Measure | What it needs | Source |
|---|---|---|
| Saccadic **peak velocity** | > 300 Hz sampling; at 60 Hz only saccades > 10° are estimable; the sleep-deprivation effect is only 5–11 % of peak velocity | [V] https://bop.unibe.ch/JEMR/article/download/2300/3496/8524 ; https://ntrs.nasa.gov/api/citations/20190033423/downloads/20190033423.pdf ; https://www.dr-goldich.co.il/wp-content/uploads/2017/01/11.pdf (64.8 → 59.6 deg/s, 8 % mean decrease, 28 h TSD) |
| **Microsaccades** | ≥ 200 Hz; amplitude bound 1–2°, i.e. smaller than our 6° error | [S] https://link.springer.com/article/10.3758/s13428-020-01430-3 |
| **Slow eye movements (SEMs)** | Defined electrically in the EOG: 0.2–0.6 Hz, 20–200 µV, > 2 s, recorded at 500 Hz. No primary measures SEMs from a video gaze estimate | [V] https://pmc.ncbi.nlm.nih.gov/articles/PMC12473391/ |
| **Blink velocity / AVR / lid-closure speed** | ≥ 250 fps for a "comprehensive assessment of blink dynamics"; maximum velocities "markedly underestimated below 250 fps"; a production 60 Hz DMS says "the calculation of the blinking velocity becomes more inaccurate" and cites ≥ 500 Hz | [S abstract] https://www.sciencedirect.com/science/article/pii/S1542012426000091 ; [V] Friedrichs & Yang 2010 |
| **Pupil diameter / PUI (pupillographic sleepiness test)** | 25 Hz at **0.05 mm** spatial resolution, 11 min in **enforced darkness** with IR goggles; clinical cutoffs PUI < 6.6 normal / > 9.8 pathologic mm·min⁻¹ | [V] https://www.amtech.de/en/products/pstxs3 ; https://pmc.ncbi.nlm.nih.gov/articles/PMC7078331/ ; [S] cutoffs. "Although pupillography measures sleepiness, it is impractical to use while driving" [V] https://www.jstage.jst.go.jp/article/indhealth/44/4/44_4_564/_pdf/-char/en |
| **EEG / EOG** | Electrodes | — |
| **Lane position, steering, SDLP** | Vehicle telemetry.  Note these are what the EU DDAW regulation actually contemplates: "a reduction in the number of micro-corrections within driver steering… an increase in the variability of a vehicle's lateral lane position" [V via text proxy of EUR-Lex] | Reg. (EU) 2021/1341 |
| **Reaction time / PVT** | A task | — |

### 1.12 Frame-rate requirement per metric

Derived from the frame period `dt` and the closure interval `T`; a closure is sampled by at least
one frame with probability ≈ min(1, T/dt) [E].

| Metric | Minimum usable rate | Why |
|---|---|---|
| PERCLOS (P80 share) | **≥ 10 fps**, comfortably at 15–30 | "For accurate estimation of PERCLOS the frame rate should be greater than 4 fps"; ">90 % at frame rates more than 5 fps" [V] https://arxiv.org/pdf/1505.06162 . Published devices sample at 2–120 Hz [V] Abe 2023 |
| Microsleep / sleep / eyes-closed (≥ 1 s events) | **≥ 5 fps** | A ≥ 1 s event is sampled by ≥ 5 frames at 5 Hz [E] |
| Blink **detection / rate** | **≥ 15 fps** | At 15 fps (dt = 67 ms) every sub-threshold interval ≥ 67 ms is caught with certainty; at 5 Hz only ~50 % of 100-ms closures are caught [E], which matches the measured 1–3 blinks/min at 5 Hz against 10–20 real (**D6**). Bergasa report ~80 % blink-frequency performance "because some quick blinks are not detected using a frame rate of 25 frames/s" [V] |
| Mean blink **duration** over ≥ 10 blinks | **≥ 15 fps** | Uniform quantisation error dt/√12 averages down: at 15 fps the SD of the mean over 20 blinks is 4.3 ms, negligible against the 200 ms vs 400 ms distinction [E]. One downsampling study found "blink amplitude and duration showed minimal bias and narrow LoA across all frame rates" from 250 down to 25 fps [S abstract] |
| **Per-blink** duration classification | **≥ 60 fps** | At 15 fps a 150-ms blink spans 2.25 frames (±44 % resolution); at 30 fps 4.5 frames (±22 %) [E] |
| Blink **velocity / AVR** | **≥ 250–500 Hz** | §1.11 |
| Yawn (MAR ≥ 1.5 s) | **≥ 5 fps** | A 4–7 s event [E] |
| Head nod (≥ 0.5 s drop) | **≥ 15 fps** | Needs the drop *rate*, not just the angle [E] |
| Gaze concentration over 60 s | **≥ 10 fps** | A second-order statistic of a slow signal [E] |

**Correction to D12.** `DESIGN.md` §12 lists "blink velocity and duration at ≤ 15 fps" among the
not-observable items.  Velocity is correct; **duration is not** — the *mean* blink duration over a
minute is measurable at 15 fps to a few milliseconds [E], and it is a better-validated drowsiness
feature than PERCLOS at minute resolution (§4).  What is genuinely unavailable at 15 fps is
*per-blink* duration and anything velocity-derived.

---

## 2. PERCLOS in depth

### 2.1 The definitions, verbatim

**Wierwille, Wreggit, Kirn, Ellsworth & Fairbanks (1994), DOT HS 808 247** — the origin.  Read in the
full report text [V, https://rosap.ntl.bts.gov/view/dot/2578/dot_2578_DS1.pdf]:

> "PERCLOS: The percentage of time that the eyes were 80% to 100% closed over a one-minute interval."

and, in the measures list:

> "PERCLOS: The proportion of the time that a subject's eyes were closed 80% or more.  (Again, eyes
> wide open represented zero percent and eyes closed represented 100 percent.)"

Note that **the percentage is relative to *that subject's* wide-open eye by construction** — in 1994
it was a human rater's per-subject judgement, not a calibrated distance.  Any automated
implementation must supply that per-driver normalisation itself (§2.6).

**Dinges & Grace (1998), FHWA-MCRT-98-006** define the three variants [V,
https://rosap.ntl.bts.gov/view/dot/113/dot_113_DS1.pdf]:

> "PERCLOS had three drowsiness metrics:
> • **P70**, the proportion of time the eyes were closed at least 70 percent;
> • **P80**, the proportion of time the eyes were closed at least 80 percent; and
> • **EYEMEAS (EM)**, the mean square percentage of the eyelid closure rating."

**Slow closures, not blinks.**  "PERCLOS is the percentage of eyelid closure over the pupil over time
and reflects slow eyelid closures ('droops') rather than blinks" [V, same].  Blink exclusion
cut-offs used across the literature are < 250 ms, < 400 ms or < 500 ms, with sampling rates of
2, 3, 6, 10, 24, 60 or 120 Hz [V, Abe 2023, https://pmc.ncbi.nlm.nih.gov/articles/PMC10108649/].
VTTI's manual reduction excludes "eye closures due to blinking, considered 1 to 2 syncs in duration"
where "1 sync = 1/10th of a second", i.e. ≤ 0.2 s [V, NSTSCE 24-UI-134].

**Our P80 implementation already matches the definition**: `perclos_closed` 0.2 on the normalised
openness scale is exactly "the eyelid is less than 20 % open" [V, Abe 2023].  **We do NOT exclude
blinks** — see §8.6 for why that matters at low frame rates.

### 2.2 Window lengths — and the trade

| Window | Status | Source |
|---|---|---|
| **1 min** | The definitional unit, and the least reliable | "over a one-minute interval" [V, Wierwille 1994]; "all technologies had a better prediction of PVT lapses when sampling a longer (20-minute) rather than briefer (1-minute) period" [V, Dinges & Grace 1998] |
| 2 / 4 / **6 min** | 6 min measured slightly better in the 1985 precursor | "The six-minute interval data were found to provide slightly better discrimination of drowsiness-induced impairment" [V, Wierwille 1994] |
| **3 min** | The naturalistic-video-reduction standard | "A trained reductionist watches 3 minutes of video just prior to the start of the SCE or BL" [V, NSTSCE 24-UI-134]; SHRP 2 / AAA used "the final three minutes of video preceding each crash (recorded at 15 frames per second)" [V, https://aaafoundation.org/wp-content/uploads/2026/01/FINAL_AAAFTS-Drowsy-Driving-Research-Brief-1.pdf] |
| **20 min** | Best coherence with PVT lapses | [V, Dinges & Grace 1998] |
| **60 s rolling** | What modern production DMS units actually emit | "PERCLOS values over a 60-second rolling time window with a 0.20 threshold for eye-closure" [V, NSTSCE 25-UI-177 and 26-UI-182] |

The 1-vs-3-minute difference is **not** benign.  Overall agreement on the fatigue/no-fatigue call is
95.89–99.48 %, but that is dominated by the not-fatigued majority: "Of the 185 truck SCEs marked
fatigued using PERCLOS 3, approximately 1 of every 6 did not meet the fatigue threshold when
PERCLOS 1 was used (31 SCEs; 16.76 %)", and for motorcoach baselines "half did not meet the fatigue
threshold when PERCLOS 1 was used" [V, NSTSCE 24-UI-134].  **Short windows lose drowsy events; long
windows are late.**  Our two-window rule (60 s AND 180 s, **D12**) is the right shape for exactly
this reason and is better supported than either window alone.

### 2.3 Thresholds actually used by validated systems

| Threshold | Window | Context | Source | Mark |
|---|---|---|---|---|
| **< 0.075 awake / 0.075–0.15 questionable / > 0.15 drowsy** | 1 min | The original bands | "Classification PERCLOS Value / Awake PERCLOS < 0.075 / Questionable 0.075 < PERCLOS < 0.15 / Drowsy PERCLOS > 0.15" — Wierwille 1994 DOT HS 808 247 p. 171 | [V] |
| **8 % advisory / 12 % full warning** | 1 min (high sensitivity) | NHTSA/VTTI Drowsy Driver Warning System field operational test, the only large US government deployment | "initial advisory tone occurs at 8 percent PERCLOS (4.8 s), with full warning occurring at 12 percent PERCLOS (7.2 s)" | [V, DOT HS 811 117] |
| **9 % advisory / 12 % full warning** | 3 min (medium) | same | "initial advisory tone occurs at 9 percent PERCLOS (16.2 s), with full warning occurring at 12 percent" | [V] |
| **10 % advisory / 12 % full warning** | 5 min (low) | same | "initial advisory tone occurs at 10 percent PERCLOS (30.0 s), with full warning occurring at 12 percent" | [V] |
| **> 12 %** | 3 min | Naturalistic truck/motorcoach fatigue coding | "If the PERCLOS score was greater than 12 %… the SCE or BL was considered 'fatigued.'" (Hammond et al. 2021) | [V, NSTSCE 24-UI-134] |
| **≥ 12 %** | 3 min (or 1 min fallback), 15 fps | SHRP 2 crash coding | "the driver was classified as drowsy if the driver's eyes were closed in 12 % or more of the video frames in the three-minute or one-minute period preceding the crash" | [V, AAA Foundation] |
| **15 %** | 60 s rolling, P80 | The modern DMS operating point | "PERCLOS of 15 % was also used as the threshold to define drowsiness." | [V, NSTSCE 25-UI-177] |
| **10 %** | not stated | Real-driving study: PERCLOS at the moment of a 1-s microsleep | baseline 6.13 %, at 1-s microsleep 10.54 %, at end point 12.22 %; "PERCLOS threshold can be set at 10 %, assuming critical point to be 1-second microsleep" — Lin, Tan, Chua, Tey & Ang, *J Vision* 2012 (VSS abstract) | **[S]** — ARVO blocks automated fetch; read only in a search-engine rendering of the abstract page |
| **< 5 % alert / 6–8 % moderately drowsy / > 10 % drowsy** | 60 s rolling | NSTSCE sampling bands | [V, NSTSCE 26-UI-182] — **note the same report elsewhere uses < 5 / 5–10 / 10–15 / > 20 %; the report is internally inconsistent** | [V] |
| **≥ 0.3 (or closure ≥ 2 s)** | per episode | Visual drowsiness episodes validated against EEG in OSA drivers at 30 fps; 94.3 % / 95.1 % agreement with EEG on 927 episodes | [V, https://pmc.ncbi.nlm.nih.gov/articles/PMC11055081/] | [V] |
| **> 0.32** | not stated | One MDPI system's fatigue point | [V, https://www.mdpi.com/2076-3417/11/19/9195] | [V] |

**Important corrections to T.**  (a) `THRESHOLDS.md` attributes "> 10 % over 150 s = drowsy, < 5 %
alert" to "Meyer & Llaneras 2022".  **No such report exists and the string "150" does not occur in
either Llaneras & Meyer NSTSCE report.**  The correct citation is **Llaneras, R. E. & Meyer, J.,
"Drowsiness Metrics and Thresholds: The Search for Valid and Reliable Standards", NSTSCE Report
#26-UI-182, 2026**, and the window is **60 s rolling, not 150 s**.  (b) `THRESHOLDS.md` cites
"VTTI NSTSCE 25-UI-177" — that report is real and the numbers check out exactly, but its authors are
**Llaneras, Meyer & Barnes** and it was submitted **2026-03-05**, not 2022.

### 2.4 How well does PERCLOS actually work

**The good.**  Bout-to-bout Pearson correlations with 20-minute PVT lapse counts, 10 scorable
subjects [V, Dinges & Grace 1998, Table 1]: P70 0.55–0.95, **P80 0.67–0.97**, EM 0.70–0.95 (means
0.862 / 0.878 / 0.868 [E], my arithmetic on their table).  PERCLOS had the highest average of the
nine metrics tested and "correlated more highly with PVT lapses than did the subjects' ratings of
their own sleepiness" [V].  On the road, ρ_p 0.74 with KSS and 0.67 with EEG for one well-behaved
night-drive subject [V, Friedrichs & Yang 2010].  In 12 professional drivers after 24 h of total
sleep deprivation, "PERCLOS was moderately associated with variability in both vigilance performance
(r = 0.68, P < .05) and variation in lane position on the driving task (r = 0.61, P < .05)"
[V abstract, https://pubmed.ncbi.nlm.nih.gov/26065627/].

**The headline number that is not what it looks like.**  Against observer ratings (ORD ≥ 70 = drowsy)
on 21 on-road drivers, PERCLOS 15 % over 60 s gave an "Overall Hit Rate" of **80.05 %**, false-alarm
**8.62 %**, miss **11.33 %** [V, NSTSCE 25-UI-177 Table 2].  But the report's "hit rate" pools correct
*drowsy* and correct *not-drowsy* calls, and its own decomposition is Hit-Drowsy 9.36 % vs Miss
11.33 % — so the **true drowsy-detection sensitivity is ≈ 45 %** [E, 9.36/(9.36+11.33)].  The
companion report 26-UI-182 gives 9.21 % / 7.40 %, i.e. ≈ **55 %** [E].  **Never quote "80 % hit rate"
as sensitivity.**  (For calibration, the EU DDAW regulation's acceptance floor is an average
sensitivity > 40 % [V, SM §1] — so a ~45–55 % sensitivity is a *pass*, not a failure; it is simply
not the 80 % the headline implies.)

**Where PERCLOS measurably fails** [all V, Abe 2023]: "PERCLOS in simulated driving was not sensitive
to moderate sleep restriction (2–4 h of sleep reduction)"; no change in older adults on-road after
29 h of sleep deprivation despite increased lane deviation; no change on aviation tasks; no change
after night-shift driving; no difference in naturalistic OSA driving.  And on the crash link
specifically: "Studies investigating the relationship between PERCLOS and crashes have produced
conflicting results, with some studies finding a correlation … and others finding no correlation",
while the PERCLOS ↔ lane-departure link is "robust" [V].  Also: "different devices may output
different PERCLOS values" [V].

**PERCLOS is late by construction.**  "This is one of the major weaknesses that PERCLOS detects
fatigue too late and fails to detect participants that are drowsy with eyes wide open" [V, Friedrichs
& Yang].  Quantified from the other direction by Johns: "the majority (78 %) of lapses in performance
recorded here occurred while the subject's eyes were open for at least long enough to see the
stimulus" [V, https://www.mwjohns.com/wp-content/uploads/2017/05/apss_2003_06_03_the_amplitude_velocity_ratio_of_blinks_a_new_method_of_monitoring_drowsiness_poster_69.pdf].
Time-to-drowsy on real roads: mean 23 / 33 / 42 minutes into a trip for PERCLOS 10 / 15 / 20 %
[V, NSTSCE 25-UI-177].

**Combining PERCLOS with a second channel transforms the false-alarm rate**: PERCLOS ≥ 15 % *and*
SDLP ≥ 0.40 m gave hit 90.16 %, **false alarm 0.81 %**, miss 9.03 % [V, NSTSCE 26-UI-182].  We have
no SDLP, but the principle — require a second, independent condition — is what our 60 s AND 180 s
rule and the drowsiness score already implement.

### 2.5 Failure modes, with the field numbers

The single most useful document here is the **NHTSA/VTTI Drowsy Driver Warning System field
operational test, DOT HS 811 117 (2009)**, 102 heavy-vehicle drivers, naturalistic, using the
Attention Technologies Driver Fatigue Monitor — the direct commercial descendant of the
Dinges/Grace work [all V, https://rosap.ntl.bts.gov/view/dot/9004/dot_9004_DS1.pdf]:

> "Data reductionists visually evaluated over 15,000 total alerts… A total of 721 valid alerts were
> obtained from this process."

i.e. **≈ 95 % of every PERCLOS alarm produced in the field was a false alarm.**  The causes, Table
108, 14,665 invalid alerts:

| Cause | Count | % |
|---|---|---|
| Device failure (clear view of the eyes, could not locate them) | 5,780 | 39.41 |
| **Looking away** | **3,015** | **20.56** |
| **Driving-related scanning** (mirrors) | **2,137** | **14.57** |
| **Outside light level** | **1,275** | **8.60** |
| Eyes obstructed | 324 | 2.21 |
| Driver shifting position | 229 | 1.56 |
| Driver movement | 209 | 1.43 |
| Glasses / sunglasses | 87 | 0.59 |
| Driver distraction (phone, reading, eating, tobacco, CB, hygiene, other) | 1,219 | 8.31 |
| Multiple actions / undetermined | 390 | 2.66 |

**35.1 % of all false alarms are gaze-direction and head-rotation artefacts.**  The mechanism is
stated outright:

> "The DFM categorized any glance away from the forward roadway as eyes-closed, an action which
> artificially inflated the PERCLOS values used to calculate alert presentation."

> "The DFM assumed that if no eyes were found, the driver was closing his or her eyes."

**This is the single most important design lesson in this memo for a gaze-based pipeline.**  The
dominant real-world failure of PERCLOS is that *eyes-not-found* is coded as *eyes-closed*.  Our
engine already avoids it (unusable frames "count in neither" numerator nor denominator, **D6**), and
the look-down and head-turn guards (**D12**) remove the other two-thirds of the gaze artefacts.

**Looking down, quantified physiologically.**  The palpebral fissure narrows with downward *gaze*
alone, in a fully alert person: vertical aperture **9.7 ± 1.2 mm in primary gaze → 6.4 ± 1.1 mm at
40° downgaze** (n = 76), while the horizontal aperture barely moves (27.1 → 25.6 mm) [V,
https://pubmed.ncbi.nlm.nih.gov/17041316/].  An independent 10-subject cohort measures
10.8 mm at 0° → 8.7 mm at −20° → 7.8 mm at −30° [V,
https://www.scielo.br/j/abo/a/jjLPyC8JqWQKW6PtzrC9sBz/].  In EAR terms that is a **−0.75 to
−0.93 % of baseline per degree of downward gaze** [E, interpolating the two cohorts], so the
commonly used 0.75 × baseline closure threshold is reached by **27–33° of pure downward gaze with
the eyes fully open** [E].  This is not theoretical — a production system had to add a duration
floor because "many of the vertical looks to the dashboard are still recognized as blinks" [V,
Friedrichs & Yang].  It also cross-checks our own measured ~0.6 % per degree (**D12**) to within
the difference between head pitch and gaze pitch.

**Glasses and light.**  The DDWS FOT excluded bespectacled drivers by protocol: "One driver with
glasses was tested… As expected, the DDWS was not able to reliably detect eyes in this real-world
evaluation" [V].  The whole trial was confined to "an in-cab illuminance reading of 10 lux or
lower" because the device "only worked in low illumination" [V].  Even a modern IR production DMS
loses frames on glasses: active time "70–90 % for most drives.  For some drivers with glasses it was
lower (≈ 60 %)" [V, Friedrichs & Yang].  And in the original laboratory validation, 4 of 14 subjects
were unscorable because "glare from other equipment prevented PERCLOS scoring" — a **29 % subject
loss indoors** [V, Dinges & Grace].

### 2.6 P80 with a personalised baseline

The 1994 definition normalises to the subject's own wide-open eye via a human rater; automated
systems must reproduce that.  The clearest published method is a granted DMS patent [V,
https://patents.google.com/patent/US10740633B2/en, Fotonation/Tobii, priority 2017-10-02]:

* window ≈ **90 frames at ~30 fps ≈ 3 s** per analysis window, repeated until enough valid data;
* statistic: "the **median** of the EO values is chosen and output as an Interim BEO value" — median,
  not maximum (corrupted by surprise) and not mean (corrupted by blinks);
* timing: the baseline "is acquired at the beginning of a driving excursion, **when the driver is
  assumed to not be drowsy**";
* normalisation: eyelid-opening % = measured aperture ÷ BEO × 100; P80 then falls out as
  "time with normalised opening ≤ 20 %".

Friedrichs & Yang do the same at feature level: "We assume that the drivers are usually awake during
the first 15 minutes of a drive.  The mean or maximum of features during this time is then used for
normalization" [V].

**No peer-reviewed study demonstrates that a personalised PERCLOS baseline improves accuracy** — it
is industrial practice, and the closest published evidence is the EAR-level result that
personalisation moves open-eye accuracy from 89.0 % to 98.9 % [V, arXiv 2604.22479].  That is enough
to justify it on false-alarm grounds alone.

---

## 3. Eye closure duration → driver state

### 3.1 The bins, with the source of each boundary

`t` = duration of a continuous closure in which the lids are ≥ 80 % closed (P80), measured on
consecutive frames with a per-driver openness baseline.

| Bin | Duration | What it means | Boundary source | Recommended severity |
|---|---|---|---|---|
| **Normal blink** | **t < 0.4 s** | Background. Alert blinks are 100–400 ms overall; at half-amplitude 111 ± 51 ms with a normal range **59–182 ms** (n = 202) | "The eye blink lasts approximately 100–400 ms" [V, Soukupová & Čech]; "The mean D for alert subjects here was 111 +/- 51 msec, and the normal range was 59-182 msec" [V, Johns 2003]; "blink duration in rested conditions lasts for less than 200 ms" [V, Wilkinson 2013] | none — count into statistics only |
| **Long blink** | **0.4–0.8 s** | Drowsy-type blink. The physiological boundary is **500 ms**, not 400 | "In the drowsy state some blinks last longer than 500 msec because the eyelids stay closed for some time" [V, Johns 2003]; "sleep deprivation results in … episodes of slow eye closure lasting more than 500 ms" [V, Wilkinson 2013]; blink duration bands < 400 / 400–800 / > 800 ms [V, Soukupová & Čech citing prior work] | none — feed the long-blink share |
| **Prolonged closure** | **0.5–1.5 s** | The first actionable band. The professional-driver study counts every "eyelid closure episode (80 % closure as per PERCLOS) **≥ 1 s**" | "Events are defined as eye closures longer than **0.5 s** (1 s for MICROSLEEP1S)" [V, Friedrichs & Yang]; "≥ 1 s" [V, https://pmc.ncbi.nlm.nih.gov/articles/PMC4957187/]; Bosch patent "A warning takes place, for example, if the duration of the critical state reaches **1 sec**" [V, US10105104B2] | silent at 0.5 s, soft alert at 1.0 s |
| **Microsleep** | **1.0–3.0 s** (fire at 1.5 s) | Euro NCAP's regulated band is **1–2 s**. Commercial practice clusters at **1.5 s** | "a short duration eye closure (1-2 seconds)" [V, Euro NCAP v1.1 §1.3.3 and v1.2 §1.3.3, both identical]; "ΔTmicrosleep shall be between 1 and 2s" [V, Euro NCAP SD 202 v1.2]; "eyes are closed (or almost closed) for **1.5 seconds** or longer" [V, Seeing Machines Guardian]; Bosch patent "microsleep being detected as soon as the duration exceeds a specific limit value (for example, **1.5 s**)" [V, US10748404B2]; US7301465B2 "about **1-1.5 seconds** continuously" [V] | **warn**, distinct urgent tone |
| **Sleep** | **≥ 3.0 s** | Regulated | "A driver is deemed asleep when displaying a continued eye closure **≥3 seconds**" [V, Euro NCAP v1.1/v1.2 §1.3.4]; "ΔTsleep is fixed to 3s" [V, SD 202 v1.2]; US8063786B2 "closed for more than three seconds" [V]; ORD "Extremely Drowsy … prolonged eyelid closures (**4 seconds or more**)" [V via 100-Car Appendix C] | **urgent**, distinct from every other alert |
| **Unresponsive** | **≥ 6.0 s** | Regulated escalation | "when the eyes have been closed for ≥ **6 seconds**" [V, Euro NCAP §1.3.5]; test procedure holds 13 s to trigger the Emergency Function [V, SD 202 v1.2]; Hyundai patent uses "about 6 seconds or greater during 60 seconds" as a PERCLOS-10 % equivalent [V, US10262219B2] | **emergency**, and treat the driver as incapacitated |

The clinical scoring anchors line up with the same ladder: "**Very Drowsy**: As a driver becomes very
drowsy eyelid closures of **2 to 3 seconds or longer** usually occur"; "**Extremely Drowsy**: …
prolonged eyelid closures (**4 seconds or more**)" (Wierwille & Ellsworth 1994 ORD, read verbatim in
the 100-Car report's Appendix C) [V].

### 3.2 What the clinical microsleep literature says about the 3-second line

The BERN visual-scoring criteria define a microsleep episode as **1–15 s** with "eyes ≥ 80 % closed
(visually estimated in face videography)" plus occipital theta [V, Hertig-Godeschalk et al. 2020,
publisher PDF via the ETH Zurich Research Collection,
https://www.research-collection.ethz.ch/handle/20.500.11850/391782].  This upgrades the **T** note
on the BERN criteria from hearsay to a verified primary and confirms the wording exactly.

**The decision-relevant number:** in 18 sleep-deprived participants, "A 34.4 % share of the MSEs were
shorter than 3 s in the MWT and **38.5 %** in the driving simulator", with a median MSE duration of
**3.40 s** in the simulator and a rate of **0.74 per minute** [V, Skorucak et al. 2020,
https://www.frontiersin.org/journals/neuroscience/articles/10.3389/fnins.2020.00008/full].
**A detector that only fires at 3 s misses more than a third of EEG-scored microsleeps.**  Our
1.5 s `microsleep_s` sits in the right place; Euro NCAP's 1–2 s band is the regulated floor and we
should not drift above it.

Other duration statistics worth having: behavioural microsleeps in a 50-min tracking task averaged
**3.3 s (median 2.5 s)** at a rate of **79/h**, bounded 0.5–15 s by definition [V, Poudel et al.
2014, https://pmc.ncbi.nlm.nih.gov/articles/PMC6869765/].  In an MWT population the most frequent
eyelid-closure episode duration was **2–4 s**, ~90 % were < 10 s, and **more than 50 % of all closure
episodes occurred in the five minutes preceding the first microsleep** [V, Santschi et al. 2023,
https://www.dovepress.com/article/download/86027] — i.e. closure *rate* accelerates sharply just
before the event, which is the signal a short-window PERCLOS is good at catching.

### 3.3 One claim to stop repeating

**SM §1** and several vendor pages assert that "eye closures > 500 ms are linked to risk".  The
primary behind that figure uses > 500 ms as the **outcome** ("The vehicle monitored lane departures
and behavioural microsleeps (blinks >500 ms) during the drive") rather than as a risk threshold
[V abstract, Lee et al. 2020, *Accid Anal Prev* 135:105386], and Abe 2023 states the eye-closure ↔
*crash* evidence is conflicting while the ↔ *lane-departure* evidence is robust [V].  The defensible
phrasing is: **closures > 500 ms are the standard operational definition of a behavioural microsleep
in naturalistic driving, and they co-occur with and are predicted by lane departures** — not "they
are linked to crash risk".

---

## 4. Blink frequency and duration → drowsiness

### 4.1 Blink RATE is not a usable signal, and the literature says why

The direction of the effect is genuinely disputed, and the reason is that blink rate is driven by
at least three things at once — time-on-task, visual demand and cognitive load — which push it in
opposite directions.

| Finding | Direction | Source | Mark |
|---|---|---|---|
| "The evidence of increases in blink rate as a function of time on task is compelling.  However, variables other than time on task also affect blink rate." | **up** with time-on-task | Stern, Boyer & Schroeder 1994, *Hum Factors* 36(2):285–97 | [S abstract] |
| "whereas mental workload of cognitive tasks would increase blink rate, visual demand would inhibit it" | **both**, by mechanism | Recarte, Pérez, Conchillo & Nunes 2008, *Span J Psychol* 11(2):374–85, n = 29 | [S abstract] |
| A relaxed person blinks 15–20 /min, dropping to ~3 /min under a cognitive task | **down** under load | [V, Friedrichs & Yang quoting Andreassi and Svensson] | [V] |
| "Reduction of blink duration and reopening time as well as **increase in blink frequency** were significant" after CPAP, i.e. sleepier ⇒ fewer blinks | **down** with sleepiness | Caffier, Erdmann & Ullsperger 2005, *Sleep Med* 6(2):155–62, 21 OSA patients | [S abstract] |
| 10 OSA bus drivers vs 10 controls on-road: blink duration separated them (82.3 vs 51.9 ms) but **"No significant differences between the groups appeared in average blink frequency"** | **none** | Häkkänen et al. 1999, *Sleep* 22(6):798–802 | [S abstract] |
| Blink frequency vs KSS over 90 h of real road driving: **ρ_p −0.11, ρ_s −0.04** | ≈ zero | [V, Friedrichs & Yang, Table IV] | [V] |
| Acute total sleep deprivation raised blink rate 39.42 → 52.40 /min | **up** | [V, https://pmc.ncbi.nlm.nih.gov/articles/PMC5797225/] | [V] |

The cleanest statement is Johns' own reason for leaving blink rate out of the JDS entirely:

> "It is noteworthy that the frequency of blinks per minute was not included in the JDS although
> others have used that variable.  **We have found that it is too task-dependent and too
> subject-specific to be useful as a measure of drowsiness.**"
> [V, Johns et al. 2007, *Somnologie* 11:234–242]

**Recommendation: keep blink rate as a displayed diagnostic only.  Never let it move the drowsiness
level, in either direction.**  This matches what the engine already does (**D6**: "nothing else
depends on the rate").

### 4.2 Blink DURATION does track sleepiness, with a measurable dose–response

**The best single table in the literature** — 10 shift workers, 424 observations, EOG at 128 Hz,
blink duration measured at half amplitude, in a 2-h simulated drive [V, Ingre, Åkerstedt, Peters,
Anund & Kecklund 2006, *J Sleep Res* 15(1):47–53, open PDF at
https://fatiguemanagersnetwork.org/wp-content/uploads/Ingre-et-al.2005_Subjective-Sleepiness-Simulated-Driving-Performance-and-Blink-Duration.pdf]:

| KSS | Mean blink duration | | KSS | Mean blink duration |
|---|---|---|---|---|
| 1 | 102.3 ms | | 6 | 119.0 ms |
| 2 | 110.9 ms | | 7 | 125.0 ms |
| 3 | 113.7 ms | | 8 | 140.2 ms |
| 4 | 118.4 ms | | 9 | 151.2 ms |
| 5 | 118.3 ms | | | |

* Linear trend **+5.6 ms per KSS level** (SE 0.6, χ² = 49, df = 1, P < 0.001), plus a significant
  squared term (χ² = 8.78, P = 0.003) — the curve is flat from KSS 1 to 7 (102 → 125 ms) and rises
  sharply at 8–9 [V].
* **The individual-difference problem, quantified:** the random-intercept SD is **1.7× the average
  increase between two KSS levels**, and ICC = 0.30 — "30 % of the error variance in BLINKD was
  explained by stable individual differences in the intercept after removing the fixed effect of the
  KSS" [V].  The authors' own conclusion is that a fixed-threshold warning would be "systematically
  underestimated for #4 and with frequent false alarms for #8" [V].  **A per-driver baseline is
  mandatory for blink duration too, not just for EAR.**
* "serious behavioural and physiological changes do not occur until relatively high levels of
  sleepiness (KSS ≥ 7) are reached" [V] — which is exactly where Euro NCAP puts its drowsiness line.

**Component durations, alert vs 34–40 h awake** (5 subjects, IR oculography) [V, Tucker & Johns 2005,
https://www.mwjohns.com/wp-content/uploads/2017/05/apss_2005-06-18_the_duration_of_eyelid_movements_during_blinks.pdf]:

> "The mean duration of eyelid closure increased significantly after sleep deprivation, from
> **103 ± 18 ms (SD) to 165 ± 118 ms** (p<0.001).  The duration of eyelid reopening also increased
> significantly, from **162 ± 49 ms to 273 ± 100 ms** (p<0.001).  In alert subjects, the eyelids
> remained closed only very briefly (**0.3 ± 4 ms**), but this increased markedly to
> **144 ± 506 ms** (p<0.001)… The total duration of blinks … in subjects when alert
> (**265 ± 57 ms**) also increased significantly after sleep deprivation (**586 ± 592 ms**, p<0.01)."

Note the variances: the drowsy distributions are enormously wider than the alert ones.  **The
variability of blink duration is itself the strongest single JDS input** (log SD of blink duration,
β = 0.41, the largest of the four terms) [V, Johns et al. 2007].

**Cross-validation on other datasets:** 32–34 h wake on a closed track raised inter-event duration by
**+18.6 ms** and blink total duration by **+65.3 ms** (both P < .0001) and multiplied the rate of
long eye closures by **2.9** [V, Shekari Soleimanloo, Wilkinson, Cori et al. 2019, *JCSM*
15(9):1271–1284, https://pmc.ncbi.nlm.nih.gov/articles/PMC6760410/].  Acute sleep deprivation in a
simulator raised blink duration 179.88 → 200.75 ms [V, https://pmc.ncbi.nlm.nih.gov/articles/PMC5797225/].

### 4.3 How accurate is blink duration, in ROC terms

All against real impairment outcomes:

| Predictor | Outcome | Accuracy | Source |
|---|---|---|---|
| **Inter-event duration (mean closure episode duration)** | ≥ 4 consecutive missed OSLER signals | **AUC 0.816** (95 % CI 0.715–0.886) | [V, Wilkinson et al. 2013, PMC3836343] |
| Blink total duration | same | AUC 0.767 | [V] |
| JDS | same | AUC 0.745 | [V] |
| +AVR (closing) | same | AUC 0.733 | [V] |
| **%TEC (the PERCLOS analogue)** | same | **AUC 0.683 — the worst of the five** | [V] |
| Inter-event duration | ≥ 3 PVT lapses in a minute | sens **71 %** / spec **88 %**; for ≥ 5 lapses **100 % / 86 %** | [V] |
| JDS | ≥ 3 / ≥ 5 PVT lapses | sens 77 % / 100 %, spec 85 % / 83 % | [V] |
| Blink parameters | out-of-lane event in the same minute | spec **70.12–84.15 % at sensitivity 50 %** | [V, Shekari Soleimanloo 2019] |
| Same, over a 15-min window | driving impairment | sens **85–91 %** at spec 50 % | [V] |
| Blink total duration **> 426 ms** | drive termination (the driver gives up) | AUC 0.71, spec 78.94 % at sens 50 % | [V] |
| Pre-drive % time eyes closed | whole-drive impairment (> 3.5 lane departures/h) | AUC **0.87** (vs KSS 0.85, PVT RT 0.72) | [S abstract, Cori et al. 2023, *J Sleep Res* 32(3):e13785] |

**The ordering matters for us: mean closure duration beats PERCLOS at minute resolution** (0.816 vs
0.683 in the one head-to-head), which is an argument for weighting the long-blink term in the
drowsiness score more than we currently do (§9).

### 4.4 The long-blink share — and a correction

**T** uses `long_blink_s` = 0.4 s and **D6** counts "long blinks (> 400 ms)".  Searching the primary
literature, **no source uses a "% of blinks > 400 ms" rule.**  The two thresholds that exist are:

* **> 500 ms** — the physiological drowsy-blink boundary: "In the drowsy state some blinks last
  longer than 500 msec because the eyelids stay closed for some time, presumably because tonic
  contraction of the LP muscles is inhibited for longer than normal" [V, Johns 2003].  The upper
  limit of the *alert* normal range is **182 ms** at half amplitude [V, same].
* **> 10 ms fully closed** — Optalert's "%LC / percent long closures", a device-specific definition
  that is nothing like ours: "proportion of time eyes are fully closed > 10 ms" [V, Wilkinson et al.
  2013].

Caffier's "proportion of long closure duration blinks" is named as informative but the threshold is
not given in the reachable abstract [S].  **0.4 s is therefore our own choice, not a citation** — it
is defensible as a conservative midpoint between the 182 ms alert ceiling and the 500 ms drowsy
floor, but it must be marked [E] in `THRESHOLDS.md`, and 0.5 s is the better-sourced value.  A
warning from Johns: among blinks with abnormal amplitude–velocity ratios, "**two thirds of them were
of normal duration**" [V] — duration alone misses most of the early signal, which is precisely the
part we cannot reach without high frame rates.

### 4.5 The amplitude–velocity ratio, and why we cannot have it

AVR is the ratio of an eyelid movement's amplitude to its peak velocity.  Because it is a ratio of
two quantities in the same distance units, it is **calibration-free** — "So long as the measurements
of A and PCV involve the same units of distance, their ratio can be derived from uncalibrated
measurements" [V, Johns 2003].  In alert subjects amplitude and peak closing velocity correlate at
r = 0.82–0.95; the ratio is 4.1 ± 0.8 when alert and 6.4 ± 6.0 after sleep deprivation (ANOVA
p < 0.0001), with abnormal values appearing intermittently "with a frequency of at least 2/min"
after ~19 h awake [V, Johns 2003].  Splitting by phase, the *reopening* AVR nearly doubles
(1.4 ± 0.2 → 2.7 ± 0.9) while the closing AVR barely moves (1.2 ± 0.2 → 1.5 ± 1.0) [V, Johns &
Tucker 2005].  On real roads AVR is the best eyelid feature against KSS (ρ_p +0.50, ρ_s +0.53) [V,
Friedrichs & Yang].

**The instrument behind every one of those numbers samples at 500 Hz** ("brief pulses of invisible IR
light… repeated at a frequency of 500 Hz"; "The velocity of movements was calculated 500 times per
second as the change in position per 50 ms") [V, Johns et al. 2007].  One nuance worth keeping: the
velocity is deliberately a **50 ms difference**, "a method that was devised to measure the velocity
of the slowest rather than the fastest movements" [V] — so AVR does not need 500 Hz to resolve a
peak, it needs a stable 50 ms slope.  At 30 fps a 50 ms interval is 1.5 frames.  **AVR is out of
reach on a phone, but it is closer than "you need 500 Hz" suggests, and is the obvious thing to
revisit if a 60–120 fps capture path ever becomes cheap.**

For reference, the commercial operating points derived from AVR (the Johns Drowsiness Scale, 0–10,
updated every minute from 64 eyelid parameters) [V,
https://www.optalert.com/what-is-the-optalert-jds-and-why-is-it-leading-the-drowsiness-monitoring-field/;
https://pmc.ncbi.nlm.nih.gov/articles/PMC6760410/]: **0–3.0 alert; 3.0–4.4 risk rising; 4.5–4.9
"the point at which intervention becomes worthwhile"; ≥ 5.0 "risk of performance failure is 10 times
higher than for an alert driver"**.  Measured: alert 2.5 ± 1.5 vs drowsy-and-lapsing 6.8 ± 2.3
[V, Johns 2007]; at a cut-off of 4.0, sensitivity 91.0 % and specificity 51.3 % for off-road events;
at 7.0, 45.0 % and 85.2 %; AUC 76.1 % [V, Johns et al. 2008, *Somnologie* 12:66–74].  **This is the
shape of every drowsiness detector: high sensitivity or high specificity, not both.**

### 4.6 What is usable at 15–30 fps — and a measured frame-rate result

A controlled synthetic study (blink classification and detection from 3-D landmarks) gives the only
direct measurement I found of frame-rate effects on blink features [V, Table III of
https://arxiv.org/pdf/2511.19519]:

| Frame rate | Blink **detection** accuracy | Blink classification |
|---|---|---|
| 10 Hz | **51 %** | 77 % |
| 30 Hz | **95 %** | 98 % |
| 50 Hz | 95 % | 92 % |

and, critically: "the detected **closing duration decreased by 32 % between 30 Hz and 50 Hz**.  As
this feature strongly discriminates between alert and drowsy states, such sampling differences
likely introduce systematic bias" [V].  Training across mixed frame rates was worse than any single
rate [V].

**Practical conclusions for the phone.**

1. **Blink detection and blink rate are fine at 15–30 fps** (95 % at 30 Hz measured; every
   sub-threshold interval ≥ 67 ms caught at 15 fps [E]) and **collapse at 10 Hz and below** (51 %
   measured) — which is exactly what we see on the 5 Hz LBW replay (1–3 blinks/min against 10–20
   real, **D6**).  **Do not compute blink statistics in the 10 fps thermal/stationary fallback**;
   suppress them and say so in the log.
2. **Mean blink duration over ≥ 10 blinks is usable** — at 15 fps the quantisation SD of the mean
   over 20 blinks is 4.3 ms [E], negligible against a 102 → 151 ms effect.  **But phase-level
   features (closing duration, velocity) carry a measured 32 % frame-rate bias and must not be
   used.**
3. **Per-blink classification is not usable at 15 fps** (±44 % on a 150 ms blink [E]).
4. Because the frame rate varies on a phone (30 → 10 fps under thermal load), **any blink-duration
   statistic must be tagged with the frame rate it was measured at and never compared across
   rates** [V, the mixed-rate result above].

### 4.7 Recommended use

Blink statistics are **corroboration only**, and only above ~15 fps:

* **mean blink duration ≥ 1.4 × the driver's own alert-baseline mean**, over ≥ 10 blinks in a 3-min
  window → +evidence.  (Dose basis: 102 → 151 ms is ×1.48 from KSS 1 to 9 [V, Ingre]; 265 → 586 ms
  is ×2.2 for total duration [V, Tucker & Johns]; the baseline must be per-driver because the
  individual SD is 1.7× the per-KSS-level step [V, Ingre].)
* **long-blink share** (> 0.5 s, sourced; not > 0.4 s) over a 3-min window → +evidence.
* **blink rate** → displayed, never scored.

---

## 5. Yawning

### 5.1 How detection works

The mouth aspect ratio (MAR) is the mouth's vertical opening divided by its width.  Formula variants
actually published:

* dlib 68-point, inner lip: `MAR = (‖p63−p67‖ + ‖p64−p66‖) / (2‖p61−p65‖)` [V,
  https://arxiv.org/html/2604.22479];
* dlib 68-point, outer lip with corners 49/55 and vertical pairs 52/58 and 53/57 [V of the page,
  https://www.emergentmind.com/topics/mouth-aspect-ratio-mar];
* an 8-point, three-vertical-pair variant `(‖P2−P8‖ + ‖P3−P7‖ + ‖P4−P6‖) / (3‖P5−P1‖)` [V via text
  proxy, MDPI *Sensors* 24(19):6261].

For MediaPipe, the landmark **sets** are confirmed in a peer-reviewed paper — upper lip 61, 185, 40,
39, 37, 267, 269, 270, 409, 291; lower lip 0, 17, 314, 405, 321, 375, 89, 87, 14, 317, 402, 318;
inner contour 78, 191, 80, 81, 82, 313, 312, 311, 310, 415, 308 [V, YawDD+, arXiv:2512.11446].  **The
specific ratio `dist(13,14)/dist(78,308)` that our engine uses appears only in blog and GitHub
sources, not in the peer-reviewed literature** — it is a reasonable instantiation of the published
families, but it should be marked as our own choice.  The same paper notes that dlib "exhibited
significant temporal instability and imprecise localization around the mouth, particularly under
varying illumination and head pose conditions common in vehicular environments" — a point in favour
of the MediaPipe mesh (or the `jawOpen` blendshape) over dlib-era work.

**Published MAR thresholds and duration gates are all over the place:**

| Threshold | Duration gate | Source | Mark |
|---|---|---|---|
| ratio > 0.5 | **> 20 frames at 30 fps ≈ 0.67 s** | Wang & Shi 2005, quoted verbatim in the Cambridge/JLR paper | [V of the quoting text] |
| MAR > 0.5 | single frame | Chen et al. 2023 via emergentmind | [V of page] |
| "index of 55" | **≥ 5 s** | MDPI *Sensors* 24(19):6261 | [V via proxy] |
| **1.4 × a 5-s personal calibration** | 15-frame averaging buffer | arXiv 2604.22479 | [V] |

**There are no published numeric MAR values for a closed mouth, for talking, or for a yawn.**
Several papers explicitly decline to give ranges.  This is a real hole in the literature and one we
are unusually well placed to fill from our own logs (**D6** already measures that talking on the LBW
drivers gives MAR runs above 0.6 of 1–4 frames, ≤ 0.8 s, with one run of 1.4 s).

### 5.2 How long a yawn lasts

> "The yawn runs its course over **about six seconds on average**, but its duration can range from
> about **three and a half seconds** to much longer than the average."
> [V, Provine RR, "Yawning", *American Scientist* 93:532–539 (2005),
> https://www.americanscientist.org/sites/americanscientist.org/files/200510314450_646.pdf]

Independently measured on real sleep-deprived drivers: **123 spontaneous yawns, mean duration
6.28 s** (12 participants, 24 h deprivation, 90-min simulator drives) [V,
https://www.cl.cam.ac.uk/~mmam3/pub/FG2018-HBU-yawining.pdf].  A circadian-stratified driving
corpus gives audio-labelled yawns of **mean 4.03 s, SD 2.26 s, max 9.63 s** [V, arXiv 2305.02888].

Yawns also come in bouts with "a highly variable inter-yawn interval of around **68 seconds**", and
"There is no relation between yawn frequency and duration" [V, Provine 2005].  A yawn is a fixed
action pattern — "There are no half-yawns… a reason why you cannot stifle a yawn" [V] — which is why
a *duration* gate works: speech is fast and intermittent, a yawn is one slow sustained opening.

**Our 1.5–12 s window is well inside these bounds.**  A lower bound of 1.5 s is conservative against
a 3.5 s minimum, and the 12 s ceiling correctly rejects a held-open mouth.

### 5.3 Does yawning indicate sleepiness at all?

Yes, as a *marker*, in one direction only.  The best review concludes [V, Guggisberg, Mathis,
Schnider & Hess 2010, *Neurosci Biobehav Rev* 34(8):1267–1276,
http://www.tutis.ca/Senses/L9Auditory/Guggisberg.pdf]:

> "Yawning occurs preferentially during periods of drowsiness… Behavioural studies consistently
> reported that yawns occur most frequently before and after sleep… Furthermore, the individual
> subjective feeling of drowsiness correlates with increased yawning rates."

> "Thus, sleep pressure and drowsiness proved significantly greater when subjects yawned than when
> they moved only." (EEG delta power, n = 16)

But the reverse — that yawning restores alertness — is rejected: "no specific arousing effect of
yawning on the brain or the autonomic nervous system could be observed.  Experimental evidence
therefore suggests a rejection of the arousal hypothesis"; "The slowing of alpha power observed
after yawning indicates increased sleepiness" [V].  The thermoregulation hypothesis is judged
"inconclusive" with "important explanatory gaps" [V].  Provine frames yawning as a **state-transition
signal** — "wakefulness to sleep, sleep to wakefulness, alertness to boredom" [V] — and boredom alone
raises the rate by ~70 % [V].

In driving-specific terms, yawning is an *early and mild* marker.  A drowsiness annotation rubric
built from 223 night-shift drivers in their own vehicles places "repeated yawning" only at the
**Slightly Drowsy** level ("clear signs of drowsiness but otherwise alert and attentive in driving")
and drops it entirely from the Moderately and Extremely Drowsy descriptors, which are eyelid- and
fixation-based [V, https://arxiv.org/pdf/2010.11162].  A survey of drivers found early signs "such
as yawning, frequent eye blinks" were "related with continuing to drive while sleepy" whereas
advanced signs were associated with close calls [S abstract, Watling et al. 2015, *Accid Anal Prev*].

### 5.4 How frequent is unsafe? — the honest answer

**There is no validated yawns-per-unit-time threshold in the literature.**  I searched for a study
tabulating yawn counts against KSS and could not find one; the best candidate (Ahlström et al. 2025,
*J Sleep Res* 34, real-road truck drivers for DDAW evaluation) is paywalled.

What exists:

* **The only quantified drowsy-vs-alert comparison:** "the yawning frequency in the drowsy phase
  (phase 1) is significantly higher than the frequency in the alert phase (phase 2).  One-tail
  paired t-test showed the difference is significantly different with **p < 0.01**" — 12
  participants, 24 h deprivation vs rested, within-subject [V, Cambridge/JLR FG2018].  **The
  absolute rate is only in a bar chart, so no yawns/hour figure can be quoted from it.**
* **The "one per minute" claim:** Kassem, Chowdhury, Abawajy & Al-Sudani, "Yawn Based Driver Fatigue
  Level Prediction", *EPiC Series in Computing* 2020, pp. 372–382, DOI 10.29007/67kk, define three
  states — **alert = no yawning; early fatigue = one yawn per minute; fatigued = more than one yawn
  per minute** [V of the publisher's abstract page, https://easychair.org/publications/paper/NMPW].
  **This is an asserted heuristic.  It is not validated against KSS, PVT, EEG or any driving
  outcome, and the paper trains on YawDD, an acted dataset.**  Treat it as a ceiling on plausibility,
  not as evidence.
* **Regulators do not use yawning at all.**  The word "yawn" appears **zero times** in the Euro NCAP
  Safe Driving Driver Engagement protocol v1.1 (and the substring counts are: yawn 0, PERCLOS 0,
  blink 0, KSS 1, microsleep 12, drowsi 10) [V, both my own grep and an independent check], and zero
  times in Commission Delegated Regulation (EU) 2021/1341 (DDAW), which keys drowsiness to KSS ≥ 8
  and to steering/lane indicators [V via text proxy].
* **No tier-1 vendor advertises it.**  Seeing Machines ("head-pose, eyelid closure and precise
  eye-gaze direction"), Smart Eye ("eye, head, and face movements") and Bosch (steering-based,
  "approximately 70 signals") do not mention yawning on their own product pages [V, all three
  fetched].

### 5.5 Covered yawns — the structural problem

> "an observational study of a large transit center in Italy showed that **50.8 % of male commuters
> and 67.4 % of female commuters** actively covered their yawns in public" (Schino & Aureli 1989)
>
> "a more recent laboratory study from the United States reported that college students covered
> their yawns **44 % of time even when alone in a testing room**" (Gallup & Church 2015)
>
> [V of the quoting primary, https://pmc.ncbi.nlm.nih.gov/articles/PMC13308540/; the two 1989/2015
> primaries themselves were not read — **[S]** for the underlying studies]

"most of these methods are not able to detect hand-covered yawning since the hand covers most of the
mouth corners" [V, Cambridge/JLR].  **A MAR detector structurally misses roughly half of all yawns**,
and that loss is not random — it is biased toward socially aware drivers.

The one method that handles it adds the **eye region**: "We can distinguish between yawning and
speaking states by considering features that include mouth openness, mouth appearance, wrinkles
between eyebrows, and eye appearance", reaching "both hand-covered and uncovered yawns with an
accuracy of 95 %" under leave-one-participant-out on spontaneous yawns (F1 92.77 %) [V].  A bonus
finding from the same study, directly usable by a landmark pipeline: "**hand-over-face gestures are
generally also more frequent in the drowsy phase** compared to the alert phase.  To our knowledge,
this is the first study that explored hand-over-face touches in drowsiness detection" [V] — a hand
over the face shows up in our pipeline as a sudden partial-landmark failure, which is a cheap signal
we currently discard.

### 5.6 Talking, singing and laughing

"the MAR is inherently sensitive to partial yawns and other mouth-related actions such as speech or
laughter" [V, https://pmc.ncbi.nlm.nih.gov/articles/PMC12899127/, where MAR-based yawn detection
scored 85.19 %].  "the mouth can remain open for other purposes such as talking, laughing, or
sighing, which could lead to many false positives" [V, arXiv 2305.02888].  The mechanism that makes
a duration gate work is stated explicitly: "temporal information carried in a sequence of these
frames can be useful when identifying yawns from other actions such as speech, due to **differences
in the rate of mouth motion**" [V].  A current graph-network paper concedes that methods are still
"not capable of distinguishing between driver states, such as talking versus yawning or blinking
versus closing eyes" [S abstract, PubMed 34606468].

**No paper reports a measured false-alarm rate for yawn detection attributable to talking or
singing.**  We have one: our engine's 1.5-s all-frames gate produced **zero yawn events in 7.55 h of
LBW driving**, against talking runs of 1–4 frames (≤ 0.8 s) and one 1.4-s run (**D6**) — that is a
genuinely novel measurement and worth writing up.

### 5.7 Recommended rule and its confidence

| Rule | Value | Confidence |
|---|---|---|
| Yawn detected | MAR > 0.6 **on every frame** for ≥ 1.5 s, ended below 0.4, dropped if > 12 s | **Medium.** Duration bounds well sourced (3.5–6.3 s mean); the 0.6 level is our own calibration [E], the published levels are 0.5 and "1.4 × personal baseline" |
| Prefer a personalised level | 1.4 × a 5-s neutral-posture calibration MAR | **Medium** [V, arXiv 2604.22479] — measured +1.3 pp accuracy and a much better open/closed separation |
| Frequent yawning | **≥ 3 yawns in 10 min** → corroboration only, voiced only when the level is already above ALERT | **Low.** No primary supports any rate threshold. It is *below* the only published heuristic (> 1/min = fatigued, unvalidated) and *above* the measured awake base rate (1 yawn in 6.8 h of awake driving, **T**), which is the right place to sit given ~44–67 % of yawns are invisible to a mouth detector |
| Never | a yawn or a yawn rate may not, on its own, raise the drowsiness level or fire an alert | **High.** Regulators ignore yawning entirely; no vendor ships it; ~half of yawns are covered; the cue marks the *mild* end of the scale |

---

## 6. Head nods and head drops

### 6.1 There is no standard definition

No standards body defines a drowsy head nod.  Euro NCAP's non-transient states are eye-closure and
KSS only; the word "nod" does not appear in the protocol's driver-state criteria [V].  Published
pitch thresholds for the same phenomenon disagree by a factor of ~4:

| Threshold | Context | Source | Mark |
|---|---|---|---|
| normal head movement **2–8°**, drowsy nod **12–20°** | the most explicit published separation | [V] https://www.mdpi.com/2079-9292/12/1/26 — "The driver's general head movement Pitch shifts between 2° and 8°, while the Pitch amplitude is higher during drowsy head nodding, between 12° and 20°" |
| **21° pitch** (with yaw 20°, roll 20.5°) | generic "over-angle", tuned on 10 one-minute videos | [V] https://www.mdpi.com/2076-3417/11/19/9195 |
| **30°** "in a short period" | nodding criterion | [V] https://www.naturalspublishing.com/files/published/883kd603o78f0h.pdf |
| **45°** average nod angle during microsleeps | ultrasonic sensor study | [S] doi 10.17576/jkukm-2025-37(2)-40 |
| minimum event length **0.5 s**, pitch threshold left symbolic | a recent pipeline | [V] https://pmc.ncbi.nlm.nih.gov/articles/PMC13364414/ |
| head "falls in any direction for … **two to three seconds**" | patent | [V] US8063786B2 |

Our 15° drop within 1 s sits inside the 12–20° band and is defensible; it should be marked as a
choice within a wide published range rather than as a sourced value.

### 6.2 Is the closed eye required?

The literature splits, and the practical answer is yes:

* **Required:** "For a 'true nod', the driver has to keep his eyes closed while moving his head
  downwards.  If at anytime the driver opens his eyes while going down in his nodding sequence, the
  sequence is canceled" [V,
  https://faculty.eng.fau.edu/bfurht/files/2016/11/DriverDrowsinessDetection.pdf].
* **Observed to co-occur:** "When nodding takes place, the driver closes his or her eyes and the head
  goes down, touching the chest or the shoulders" [V, Bergasa et al. 2006].
* **Not required** in some pipelines [V, PMC13364414].

Our `nod_min_closed_s` = 0.3 s of closed eyes during the drop implements the first, which is the
only version that separates a nod from a glance.

### 6.3 Nod vs a look at the cluster — the best published rule

A Seeing Machines patent inverts the problem and gives the cleanest discriminator [V,
https://patents.google.com/patent/US11144756B2/en, priority 2016-04-07]:

> "The invention relies on the premise that a glance down is often associated with a change in head
> pose of the subject (e.g. pitch angle), whereas a fatigue event is typically not."

Claim 1 classifies a detected eye-closure event as a **downward glance** when the head pitch changes
by more than a predetermined angle during it, and as an **actual eye closure** when it does not.
Parameters: "An example predetermined head pitch angle is **±5 degrees**.  However, in some
embodiments, the predetermined head pitch angle may be in the range of **±1° to ±10°**"; eye closure
threshold **0.3** on a 0–1 scale; a **12-frame** buffer; the classification window spans "up to 2
seconds before the event and … up to 2 seconds after" [V].

**This is a direct, favourable validation of our look-down guard** (**D12**: no closure may start
while the head pitch is in LOOK_DOWN; a closure younger than 0.5 s is dropped when the head goes
down).  Two differences worth noting: (a) the patent's trigger is a **change** of ±5° *during* the
closure, ours is an absolute **−12°** relative to the resting pose — the patent's form catches a
small nod from an already-lowered resting pose, ours does not; (b) the patent looks ±2 s *around*
the event, i.e. non-causally, which we cannot do in a live alert but could do for the logged record.

Other published discriminators: velocity asymmetry — "Human nodding… consists of head slowly
dropping down followed by **rapid recovering** right back into original position.  Our system takes
this into account.  The speed of each stage of the nodding is measured in order to filter out
potential false positives such as driver nodding in agreement" [V, Colic et al.]; and amplitude —
talking nods 2–8° vs drowsy 12–20° [V, MDPI 12-00026].  **No paper gives a deg/s velocity threshold**
for the drop.

A confound to be aware of: drowsy drivers genuinely look down more — "drivers significantly more
likely to look toward their lap when drowsy" [S abstract,
https://www.sciencedirect.com/science/article/abs/pii/S092575351830211X].  A lap glance is therefore
weak evidence *for* drowsiness as well as a false-alarm source for closure detection.

### 6.4 How useful is the nod, really — it is late and weak

* **Last to appear:** "Nodding is the last fatigue effect to appear.  In the two fatigue intervals,
  nodding occurs after the increase of the other parameters" [V, Bergasa et al. 2006, IEEE T-ITS
  7(1):63–77].
* **Worst of six cues:** in the same study, correct-detection rates were fixed gaze **95.62 %**,
  PERCLOS **93.12 %**, face direction 87.5 %, eye-closure duration 84.37 %, blink frequency ~80 %,
  **nodding 72.5 %** — "It is not correlated with the three previous parameters and is not robust
  enough for fatigue detection.  Consequently, it can be used as a **complementary parameter** to
  confirm the diagnosis established based on other more robust methods" [V].  (Caveat: the fatigue
  behaviours were acted.)
* **By the time you see it, it is too late:** "if someone nodes his head, he is already in the
  sleeping mode, resulting a car clash… the head of the driver is initially not moving very much and
  then the nodding behavior occurs just before the accident" [V, Choi & Kim 2015].
* **Not universal:** "not every subject tilts their heads when drowsy" [S,
  https://link.springer.com/article/10.1186/s12544-026-00780-x].
* **Microsleeps happen without nods:** "Even if microsleep can occur in the absence of head noddings,
  the idea of an optimal indicator is that it indicates severe sleepiness before the driver falls
  asleep" [V, https://www.jstage.jst.go.jp/article/indhealth/44/4/44_4_564/_pdf/-char/en].

**No study validates head-nod sensitivity/specificity against polysomnographic microsleep.**

### 6.5 Head-movement energy is non-monotonic — do not build a monotonic rule

The literature contradicts itself because head-movement energy follows an inverted U: it **rises**
through mild and moderate sleepiness (fidgeting, self-arousal attempts, reduced tone) and then
**collapses to stillness immediately before sleep onset**, with discrete nods on top at the very end.

**Rises:** mean head-vector velocity 2.7 deg/s rested → 3.5–4.0 deg/s sleep-deprived, with
within-test rises from 2.5 to 4.2 deg/s [V,
https://www.jstage.jst.go.jp/article/indhealth/44/4/44_4_564/_pdf/-char/en]; "Surprisingly, head
motion increased as the driver became drowsy, with large roll motion coupled with the steering
motion… **Just before falling asleep, the head would become still**" [V, Vural et al., ICCV-W 2007,
https://mplab.ucsd.edu/46/media/vesra.pdf].

**Falls:** head-pitch variance vs KSS on 90 h of real road driving, **ρ_p −0.25, ρ_s −0.32** — head
movement *decreases* as KSS rises [V, Friedrichs & Yang, Table IV]; "head motion decreases according
to driver's drowsiness" [V abstract, accelerometer study]; an explicit "Immovable" head-pose
criterion where "As this value is closer to zero, the degree of drowsiness is high" [V, Choi & Kim].

**Implication:** our `HEAD_NOD` is a *discrete event* detector, not a variance feature, which is the
right side of this problem.  Do not add a "head movement variance" term to the score.

### 6.6 Head roll

One well-cited primary measures roll directly, on subjects who actually fell asleep: the correlation
between head motion and steering rose from **0.33 (alert) to 0.71 (non-alert)** for one subject and
0.24 → 0.43 for another; the authors report "a potential association between head roll and driver
drowsiness, and the coupling of head roll with steering motion during drowsiness" [V, Vural et al.
2007].  A laboratory study found no directional preference at all — left–right head velocity did not
differ from forward–backward under sleep deprivation, which the authors themselves called
"surprising" [V].  Two systems treat roll as co-equal with pitch [V, MDPI 12-00026 and 11-09195].
**There is no published roll-angle threshold specific to drowsiness**; the 20.5° figure is a generic
over-deflection bound tuned on ten one-minute videos [V].

**Recommendation:** log head roll and its coupling to nothing (we have no steering), but do not add
a roll rule.  It is the least-supported head cue and we cannot reproduce the one measurement that
supports it.

---

## 7. Combining the metrics into a drowsiness level

### 7.1 What the anchor is

Both regulators anchor on the **Karolinska Sleepiness Scale**, read verbatim from a primary that
reproduces it [V, Friedrichs & Yang, Table I]: 1 Extremely alert · 2 Very alert · 3 Alert · 4 Rather
alert · 5 Neither alert nor sleepy · 6 Some signs of sleepiness · 7 Sleepy, no effort to stay awake ·
8 Sleepy, some effort to stay awake · 9 Very sleepy, great effort to keep awake, fighting sleep.

* **Euro NCAP** (Safe Driving / Driver Engagement v1.1 Oct 2025 **and v1.2 July 2026, unchanged**):
  "Systems capable of detecting a driver reaching a **KSS level >7** at the latest, or an equivalent
  metric appropriate to assess risky levels of drowsiness are eligible to score points.  The system
  shall be functional **from 50 km/h**" [V].
* **EU DDAW**, Reg. (EU) 2021/1341: "The DDAW system shall provide a warning to the driver at a level
  of drowsiness which is equivalent to or above **8** on the reference sleepiness scale" [V via text
  proxy of EUR-Lex; the same wording is in **SM §1** as [V]].  Validation floor: average sensitivity
  > 40 %, or a lower 90 % CI bound > 20 % [V, SM §1].

Useful equivalences measured on real roads [V, NSTSCE 25-UI-177]: KSS 8 ≈ **JDS 6.26**; PERCLOS
10–15 % ≈ **JDS 6.70**; "PERCLOS levels over 15 % are commonly interpreted to represent high levels
of drowsiness".  Correlations among all the measures top out at **0.45–0.69** — "indicating moderate
levels of correlation" [V].  **No two drowsiness measures agree closely; a fusion rule is not
optional.**

### 7.2 How validated systems fuse

* **PERCLOS-led, with a second independent condition.**  PERCLOS ≥ 15 % *and* SDLP ≥ 0.40 m moved the
  false-alarm rate from 8.39 % to **0.81 %** at a similar hit rate [V, NSTSCE 26-UI-182].
* **Weighted eyelid composite (the JDS).**  A four-term linear model on log features, with the
  largest weight on the **variability** of blink duration: "log SD of a measure of blink duration
  (β = 0.41), log mean AVR for eyelids reopening (β = 0.37), log mean duration of eyelids remaining
  closed (β = 0.16), and log mean AVR for eyelids closing (β = −0.12)"; R = 0.74 over 804 minutes;
  scale truncated to 0–10 [V, Johns et al. 2007].
* **Corroboration hierarchy from an independent ranking:** fixed gaze 95.62 % > PERCLOS 93.12 % >
  face direction 87.5 % > eye-closure duration 84.37 % > blink frequency ~80 % > nodding 72.5 %
  [V, Bergasa 2006].
* **Head pose is not negligible.**  On 223 real night-shift drivers, "the head pose related features
  (pitch, yaw and roll) are among the most predictive for drowsiness, second only to mouth-open.
  These results are somewhat surprising given that anecdotally it is often assumed that eye closures
  and yawns are the main drowsiness predictors" [V, arXiv 2010.11162, macro ROC-AUC 0.78].

### 7.3 Required warning behaviour

* **Immediate, and distinct for the severe states.**  "A visual and (haptic and/or audible) warning
  shall be issued immediately after driver is classified as drowsy, (micro)sleeping or unresponsive.
  For drowsiness impairment, **prompting rest areas in the navigation system is allowed as an
  alternative warning**… **Microsleep and sleep warnings shall be distinct from and deliver a higher
  perceived level of urgency than the distraction and impairment warnings**" [V, Euro NCAP §1.4.2,
  identical in v1.1 and v1.2].
* **Cascade until acknowledged.**  DDAW: the warning "may cascade and intensify until acknowledgement"
  [V, SM §1].
* **Speed gates.**  Distraction, microsleep, sleep and unresponsive from ≥ 20 km/h; impairment
  (including drowsiness) from ≥ 50 km/h with a learning period of up to 10 minutes; measurement may
  start after 1 minute at ≥ 10 km/h [V, Euro NCAP].  DDAW applies to vehicles with a maximum design
  speed > 70 km/h — that is a **scoping** criterion for the regulation, not an activation threshold
  [S; worth checking before quoting it as a gate].
* **Test tolerances** (useful for our own fixtures): "The tolerance for Microsleep warning tests is
  [0.2] s" and the same for Sleep; ΔTsleep is fixed at 3 s, ΔTmicrosleep must be between 1 and 2 s
  [V, Euro NCAP SD 202 v1.2].

### 7.4 Hysteresis and recovery

**No standard defines a recovery duration, and I could not find one in any primary.**  Say so
plainly wherever the number appears.  What is sourced:

* The benefit of an alert is short: "The alerting stimuli provided in this experiment did not
  markedly reduce lapses in drowsy subjects **beyond the minute in which the alert occurred**,
  suggesting only a narrow window of opportunity for a drowsy driver to safely leave the roadway"
  [V, Dinges & Grace 1998].  That justifies re-warning on the order of a minute, and it justifies
  the rest-area prompt over a bare chime.
* Drowsiness is a slow, latching state: intra-subject drowsiness progressions were "highly similar"
  across experiments six months apart, and "each subject had a characteristic 'signature' of
  drowsiness progression" [V, same].
* Volvo's road-centre patent is the only sourced example of an explicit post-warning reset (PRC reset
  to 80 after a cognitive warning) [V, SM §4] — a precedent for resetting an integrator rather than
  waiting for it to decay.

Our `level_recovery_s` = 60 s with separate exit thresholds is consistent with all of the above and
should keep its **[E]** mark.

### 7.5 A closing calibration on how good any of this can be

The best full-stack real-road numbers available: an artificial neural network over 18 eyelid and
head features from a production IR DMS, cross-validated by whole drives, reached **88.0 % recall on
Awake, 81.2 % on Questionable and 62.6 % on Drowsy** (total 82.5 %), and the authors' own conclusion
is that "camera based drowsiness detection works very well for some drivers, but is ill-posed for
others" [V, Friedrichs & Yang].  For context, the Euro NCAP programme paper reports literature
detection performance of roughly **40 % sensitivity at 11–24 % false positives for drowsiness**
[V, SM §1].  **A phone-camera, visible-light, 15–30 fps system should target the conservative end of
that range and be explicit with the user that it cannot see everything.**

---

## 8. False-alarm considerations

Ordered by measured impact.  Every mechanism below is either already implemented (**D12**) or is a
recommendation in §9.

### 8.1 Eyes-not-found coded as eyes-closed — the dominant field failure

39.41 % of the DDWS field trial's false alarms were "device not working" with a clear view of the
face, and the device's stated assumption was "if no eyes were found, the driver was closing his or
her eyes" [V].  **Our rule — unusable frames count in neither the PERCLOS numerator nor the
denominator — is the single most important thing the engine does.**  Never relax it.

### 8.2 Looking down

35.1 % of DDWS false alarms were "looking away" (20.56 %) plus "driving-related scanning" (14.57 %)
[V].  Physiologically, 40° of downgaze removes a third of the palpebral aperture in a fully awake
eye (9.7 → 6.4 mm) [V], i.e. **−0.75 to −0.93 % of baseline EAR per degree** [E], so a 0.75 ×
baseline threshold is crossed by **27–33° of gaze alone** [E].  Head pitch compounds it
multiplicatively (≈ −13 % at 30° of head pitch [E]).  Mitigations, in order of strength: the
head-pitch-change discriminator (±5°, Seeing Machines patent [V]); a minimum blink duration floor
("a minimum blink duration of **130 ms** was defined to neglect these looks" [V, Friedrichs & Yang]);
and the deep-closure requirement (≥ 50 % of frames ≥ 80 % closed) which we already have.

### 8.3 Head turns and the far eye

"the DFM specifically monitors for and depends on the driver's face being in a forward-oriented
position.  Violations of this assumption often resulted in an invalid alert" [V].  A production IR
system gates at **|head yaw| ≤ 15°** [V].  Ours gates closures at 45° and switches to the near eye
at a 0.85 corner-width ratio — measured necessary because "the mesh hallucinates the far eye's lids
(EAR 0.75 at 54° of head yaw)" (**D6**).  Given the 1/cos θ inflation of EAR with yaw [E], the
*direction* of the artefact is toward reading the eye as more open, i.e. missed closures rather than
false alarms — so 45° is the right trade for us.

### 8.4 Sunglasses — a physics problem, not a tuning problem

Euro NCAP: clear sunglasses > 70 % transmittance **Functional**; sunglasses < 15 % transmittance
**"Inform if not functional"** — with the decisive footnote "**Referred to light in the wavelength
operated by the camera** (Transmittance of sunglasses shall correlate to the light used by the
sensor)" [V].  A tinted spectacle lens dark enough to fail the visible test still passes NIR almost
freely: NIR (780–1100 nm) blocking rate **14.22 ± 4.03 %** at tint grade 0 and **13.12 ± 3.07 %** at
grade 3 — i.e. ~87 % transmittance regardless of visible darkness [V,
https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12158342/].  **An IR DMS sees through sunglasses; a
phone camera cannot, and gets the regulatory penalty without the relief.**  The correct behaviour is
to declare the system degraded and fall back to head-pose-only monitoring, notifying within 10 s
[V, Euro NCAP's definition of "Inform if not functional"].

### 8.5 Glasses, low light and night

Measured degradation of landmark-based drowsiness classifiers on NTHU-DDD (30 fps, 640×480) [V, two
independent papers, arXiv 1811.01627 Table 2 and arXiv 2002.03728 Table III]:

| Condition | Model A | Model B |
|---|---|---|
| Day, no glasses | 87.12 % | 88.89 % |
| Day, glasses | 84.85 % | 83.76 % |
| Day, **sunglasses** | **75.12 %** | **78.72 %** |
| Night, no glasses | 81.40 % | 85.82 % |
| Night, glasses | 76.15 % | 79.45 % |

Glasses cost 2.3–5.1 pp, sunglasses 10.2–12.0 pp, night 3.1–5.7 pp.  Euro NCAP requires
**Functional** across "Daytime (100,000 lux) – night-time (**1 lux**)" [V] — and I found **no
visible-light landmark study at 1 lux at all**; the nearest "night" dataset was captured at
"approximately 10–20 lux" [V, https://pmc.ncbi.nlm.nih.gov/articles/PMC6164007/].  Even a production
IR DMS reports "Varying light conditions during daytime driving pose problems for the eye signal
tracking" and 8.60 % of DDWS false alarms were "outside light level" [V].  **Night behaviour on a
phone is an unmeasured risk and should be flagged in the app copy, not asserted.**

### 8.6 Low frame rate

At 5 Hz, only ~50 % of 100-ms closures are sampled at all [E], and each caught blink can be charged
a full 200 ms frame period.  Worst-case PERCLOS inflation from **normal blinking alone**, if every
blink is caught and owns one frame period [E]:

| Blink rate | 5 fps | 15 fps | 30 fps |
|---|---|---|---|
| 17 /min (resting norm) | 5.7 % | 1.9 % | 0.9 % |
| 30 /min | 10.0 % | 3.3 % | 1.7 % |
| 45 /min (dry eye, cabin airflow) | **15.0 %** | 5.0 % | 2.5 % |

So **at 5 Hz a fast blinker can reach the 15 % drowsy threshold from ordinary blinking**, while at
15 fps the same driver reads 5 % [E].  Sampling noise compounds it: the binomial SD of a 60-s
PERCLOS estimate at a true 6 % is 1.37 pp at 5 Hz against 0.79 pp at 15 fps, so a +3σ excursion
from an alert baseline of 6.13 % [S, Lin et al. 2012] touches **10.1 % at 5 Hz** and 8.4 % at 15 fps
[E].  Three defences, all already in the design: the 180-s second window, the deep-closure
requirement, and the `closure_min_frames_low_rate` floor.  A fourth is recommended in §9: **exclude
sub-250 ms closures from PERCLOS**, which is standard practice in the source literature [V, Abe
2023] and which we currently do not do.

### 8.7 Talking, singing, laughing

Euro NCAP's Driver Behaviours table, verbatim [V]: Eating **N/A** · **Talking Functional** ·
Laughing **N/A** · Singing **N/A** · Smoking/Vaping **N/A** · Eye scratching/rubbing **N/A** ·
Sneezing **N/A**, with "the Vehicle Manufacturer shall describe whether and how that driving
behaviour affects the DSM performance".  **Only talking carries a hard requirement**; laughing and
singing must merely be characterised.  Our all-frames 1.5-s MAR gate produced zero yawn events in
7.55 h of LBW driving (**D6**), which is the right operating point.  Laughing also squints the eyes
and can register as a closure; the deep-closure requirement and the 0.5-s prolonged-closure floor
absorb it.

### 8.8 The open-eye baseline drifting with drowsiness

"We observed that drivers often do not completely open their eyes any more when they become sleepy"
[V, Friedrichs & Yang].  A 120-s running median open-eye baseline (**D6**) will follow that drift
down and progressively desensitise the closure detector over a long drowsy drive.  This is a *missed
detection* risk rather than a false-alarm risk, and it is the most significant unaddressed defect I
found in the current design.  See §9.

### 8.9 Stationary vehicle, mount motion, rolling shutter

Speed gating is required by both standards (§7.3) and practitioners gate higher still — Friedrichs &
Yang suppress "vehicle speed v ≤ 30 km/h and lane changes" [V] — because low-speed driving produces
unrepresentative eye behaviour.  **No study measures drowsiness-detection validity while stopped.**
Our rule (below 10 km/h only the closed-eye family and driver-absent are voiced) is a reasonable
reading: a driver asleep at a red light is still worth waking, a distracted one is not.

Vibration and rolling shutter are acknowledged but **nowhere quantified**: "Real vehicles also
introduce system-level disturbances that are easy to underestimate in offline experiments…
vibration-induced motion blur, rolling-shutter artifacts, and small viewpoint changes caused by
mounting geometry" [V, https://arxiv.org/html/2512.22298], with no ablation isolating any of them.
For a phone on a vent mount this is a genuine open risk and is directly measurable on our own rig
(landmark jitter variance, mount vs tripod).

---

## 9. Recommended thresholds for a phone at 15–30 fps

Values marked **CHANGE** differ from the current `deployment-stack` configuration.

| Parameter | Recommended | Current (T / D6) | Source / basis |
|---|---|---|---|
| Closure read | near-eye EAR in the **head frame**, or the `eyeBlinkL/R` blendshape; far eye dropped at a 0.85 corner-width ratio | near-eye EAR, image frame | EAR is viewpoint-dependent by construction [V]; a 3-D eyelid angle has "significantly lower variance across viewing angles" [V] |
| Openness normalisation | per-driver, `openness = (read − closed)/(open − closed)` | same | "eyes wide open represented zero percent" [V, Wierwille 1994]; ≈ 10 % of drivers fall below a fixed 0.23 threshold [E on [V] mean 0.2570 / SD 0.02109] |
| **Open-eye baseline** | **CHANGE: freeze an alert baseline.** Seed from the median openness over the first 60–120 s of tracking at speed, then hold it; let the running 120-s median only *raise* it, never lower it below 0.9 × the frozen value | 120-s running median, both directions | "drivers often do not completely open their eyes any more when they become sleepy" [V, Friedrichs & Yang] — a two-sided running baseline adapts the signal away. Production practice: "median of the EO values… at the beginning of a driving excursion, when the driver is assumed to not be drowsy" [V, US10740633B2]; feature baselining over "the first 15 minutes of a drive" [V, Friedrichs & Yang] |
| Closure hysteresis | openness < 0.3 enter, > 0.5 exit | same | 0.3 matches the patent eye-closure threshold [V, US11144756B2] |
| P80 / deep closure | openness < 0.2 | same | "the eyelid is less than 20 % open" [V, Abe 2023]; 0.20 threshold in production DMS [V, NSTSCE] |
| **PERCLOS blink exclusion** | **CHANGE: exclude closures shorter than 0.25 s from the PERCLOS numerator** (keep them in the blink statistics) | no exclusion | PERCLOS "reflects slow eyelid closures ('droops') rather than blinks" [V]; literature cut-offs < 250 / < 400 / < 500 ms [V, Abe 2023]; VTTI excludes ≤ 0.2 s [V]. Removes the low-frame-rate inflation in §8.6 at no cost to real droops |
| Blink band | 0.06–0.5 s | same | alert blinks 100–400 ms, half-amplitude 59–182 ms [V] |
| **Long blink** | **CHANGE: 0.5 s** (keep 0.4 s only as a secondary, and mark it [E]) | 0.4 s | ">500 msec" is the sourced drowsy-blink boundary [V, Johns 2003; Wilkinson 2013]. **No source uses 400 ms** |
| Prolonged closure | 0.5 s silent, 1.0 s audible pre-alarm | same | 0.5 s and 1 s microsleep-event definitions [V, Friedrichs & Yang]; "A warning takes place… if the duration of the critical state reaches 1 sec" [V, Bosch US10105104B2] |
| Microsleep | **1.5 s**, repeated every 2 s | same | Euro NCAP 1–2 s [V, v1.1 and v1.2]; SD 202 "ΔTmicrosleep shall be between 1 and 2s" [V]; Guardian 1.5 s [V]; Bosch patent 1.5 s [V]. Do not raise it: 34–39 % of EEG-scored microsleeps are < 3 s [V, Skorucak 2020] |
| Sleep | 3.0 s, urgent and acoustically distinct | same | "continued eye closure ≥3 seconds"; "shall be distinct from and deliver a higher perceived level of urgency" [V] |
| Unresponsive | 6.0 s | same | [V, Euro NCAP §1.3.5] |
| Deep-closure requirement | ≥ 50 % of the closure's frames ≥ 80 % closed | same | BERN: "eyes ≥80 % closed (visually estimated in face videography)", 1–15 s [V, Hertig-Godeschalk 2020 — now verified in the primary] |
| Closure head-turn gate | 45° | same | EAR inflates as 1/cos(yaw) [E], so the artefact direction is missed detections; a production IR system gates at 15° [V] but is far more sensitive |
| Look-down guard | no closure may start in LOOK_DOWN; closures < 0.5 s dropped when the head goes down | same | "a glance down is often associated with a change in head pose… whereas a fatigue event is typically not", ±5° (range ±1–10°) [V, US11144756B2]; downgaze removes 34 % of the aperture at 40° [V] |
| **Blink-duration floor** | **ADD: ignore closures shorter than 0.13 s when the head pitch is falling** | none | "a minimum blink duration of 130 ms was defined to neglect these [dashboard] looks" [V, Friedrichs & Yang] |
| PERCLOS windows | 60 s (valid after 30 s) **and** 180 s (valid after 90 s) | same | 1-min is definitional and least reliable, 20-min best [V, Dinges & Grace]; 3-min is the naturalistic standard [V]; 1-min vs 3-min flips 16.8–50 % of the drowsy calls [V, NSTSCE 24-UI-134] |
| PERCLOS DROWSY | 60-s ≥ 0.15 **AND** 180-s ≥ 0.10 | same | 15 % / 60 s is the modern DMS operating point (hit 80.05 %, FA 8.62 %, true sensitivity ≈ 45 % [E]) [V, NSTSCE 25-UI-177]; > 10 % is the "drowsy" band [V, NSTSCE 26-UI-182]; 12 % was the shipped US field-trial warning level [V, DOT HS 811 117] and the SHRP 2 crash-coding line [V] |
| PERCLOS SEVERE | 60-s ≥ 0.30 | same | 0.3 with EEG agreement 94.3 / 95.1 % on 927 episodes [V, PMC11055081]; > 0.32 in one system [V] |
| **PERCLOS advisory** | **ADD (display only): 60-s ≥ 0.08** as an early "take a break soon" hint | none | 8 % was the DDWS advisory tone on a 1-min window [V]; Wierwille's "questionable" band opens at 0.075 [V] |
| Blink statistics | **CHANGE: suppress entirely below 15 fps**; require ≥ 10 blinks; report mean duration, long-blink (> 0.5 s) share, and the **SD** of blink duration | computed at any rate; mean + count > 400 ms | blink detection 51 % at 10 Hz vs 95 % at 30 Hz [V, arXiv 2511.19519]; the SD of blink duration is the largest single JDS weight (β = 0.41) [V, Johns 2007] |
| `SLOW_BLINKS` info | mean blink duration ≥ **1.4 ×** the driver's own alert baseline over ≥ 10 blinks | mean > 0.4 s absolute | individual random-intercept SD is 1.7 × the per-KSS-level step [V, Ingre 2006] — an absolute threshold fires on some drivers and never on others |
| Yawn | MAR > 0.6 (or 1.4 × a personal calibration) on every frame for 1.5–12 s | same | yawn 3.5–6.3 s mean [V]; 1.4 × personal [V]; all-frames gate measured zero false yawns in 7.55 h (**D6**) |
| Frequent yawning | ≥ 3 in 10 min, corroboration only, voiced only above ALERT | same | no primary rate threshold exists; below the unvalidated "> 1/min" heuristic [S] and above the measured awake base rate |
| Head nod | ≥ 15° drop within 1 s with ≥ 0.3 s of closed eyes, recovered within 3 s | same | drowsy nods 12–20° vs 2–8° normal [V]; closed eyes required [V, Colic et al.]; nod is "the last fatigue effect to appear" and the weakest cue (72.5 %) [V, Bergasa] |
| **Head roll** | **do not add a rule**; log only | not used | one supporting primary, no drowsiness-specific threshold, and its mechanism (steering coupling) is unobservable to us [V, Vural 2007] |
| **Gaze concentration (drowsiness)** | **ADD (display/advisory only): SD of gaze direction over 60 s falling below 0.6 × the driver's own baseline** | exists as a *distraction* advisory (`prc_concentration` 0.92) | "fixed gaze" was the best of six visual cues (95.62 %, no false positives) and "takes place before the other sleepy measurements" [V, Bergasa] — **but validated on acted behaviour, and acute sleep deprivation produces the opposite sign** [V, PMC5797225]. Advisory only |
| Score weights | **CHANGE: raise the long-blink term** relative to the PERCLOS term (e.g. `score_long_blink_share` 20 → 30 when ≥ 10 blinks at ≥ 15 fps) | PERCLOS gain 250, long-blink 20 | mean closure duration AUC 0.816 vs %TEC 0.683 in the one head-to-head [V, Wilkinson et al. 2013] |
| Level recovery | one step down after 60 s below the exit thresholds | same | **no official recovery duration exists** — keep the [E] mark. The benefit of an alert does not extend "beyond the minute in which the alert occurred" [V, Dinges & Grace] |
| Speed gate | measure from 10 km/h; voice the closed-eye family at any speed; drowsiness level from 50 km/h where speed is known | 10 km/h gate | Euro NCAP: measurement after 1 min at ≥ 10 km/h, transient warnings from 20 km/h, impairment from 50 km/h [V] |
| Degraded modes | sunglasses / eyes unreadable → head-pose-only, notify within 10 s, never score PERCLOS | `EYES_UNREADABLE` at 10 s | "Inform if not functional… within ten seconds of the occlusion being present" [V]; sunglasses are opaque to a visible-light sensor by physics [V] |
| Unusable frames | count in neither PERCLOS numerator nor denominator | same | the DDWS lesson: "if no eyes were found, the driver was closing his or her eyes" → ~95 % false alarms [V] |

### 9.1 Where this differs from the current configuration, and why

1. **Open-eye baseline: freeze it, or make it one-sided (`CHANGE`).**  The strongest argument in the
   memo.  A two-sided 120-s running median tracks the very drift that signals drowsiness [V,
   Friedrichs & Yang], so the detector desensitises exactly as the driver deteriorates.  Cost:
   slightly worse adaptation to a genuine lighting or posture change — mitigate by allowing the
   baseline to rise freely and to fall only to 0.9 × the frozen alert value, and by re-seeding on
   `CAMERA_MOVED` / driver change, which the engine already detects.
2. **Exclude sub-250 ms closures from PERCLOS (`CHANGE`).**  PERCLOS is defined on slow droops, not
   blinks [V]; every reference implementation excludes fast blinks [V].  It also removes the
   low-frame-rate inflation quantified in §8.6, which is the mechanism behind the one LBW drowsiness
   false alarm (60-s PERCLOS 0.189 in one noisy minute, **T**).
3. **Long blink 0.4 s → 0.5 s (`CHANGE`).**  0.4 s has no source; 0.5 s is Johns' physiological
   boundary and Wilkinson's "slow eye closure" figure [V].  Keeping 0.4 s is defensible but must be
   marked [E] in `THRESHOLDS.md`.
4. **Suppress blink statistics below 15 fps (`CHANGE`).**  Measured blink detection is 51 % at 10 Hz
   [V]; the 10 fps thermal and stationary fallbacks therefore produce a blink rate and mean duration
   that are not merely noisy but biased.
5. **Weight the long-blink term up (`CHANGE`).**  Mean closure duration out-performed the PERCLOS
   analogue 0.816 vs 0.683 AUC in the only head-to-head [V, Wilkinson et al. 2013]; our score currently gives PERCLOS a
   37.5-point contribution at threshold and the long-blink share at most 20.
6. **Add a 130 ms floor for closures during a falling head pitch (`ADD`).**  The exact fix a
   production system adopted for dashboard glances [V].
7. **Add an 8 % PERCLOS advisory (`ADD`).**  The only shipped US government field trial used 8 % as
   an advisory tone before a 12 % warning [V]; a silent "consider a break" is a cheap early cue that
   costs no alarm budget.
8. **Add a drowsiness gaze-concentration advisory (`ADD`, display only).**  The best-performing cue
   in the one study that ranked six of them, and it appears *before* the ocular ones [V] — but its
   validation is on acted behaviour and acute sleep deprivation reverses the sign [V], so it must
   never alarm.
9. **Fix the citations in `THRESHOLDS.md` (`CHANGE`).**  "Meyer & Llaneras 2022: > 10 % over 150 s"
   should read **Llaneras & Meyer, NSTSCE #26-UI-182 (2026), > 10 % over a 60-s rolling window**; and
   "VTTI NSTSCE 25-UI-177" should read **Llaneras, Meyer & Barnes (2026)**, with the note that
   80.05 % is an *overall* hit rate, not sensitivity.
10. **Amend `DESIGN.md` §12's not-observable list (`CHANGE`).**  Blink *duration* at 15 fps is
    observable in the mean; blink *velocity* and per-blink duration are not.
11. **Not recommended:** a head-roll rule (§6.6), a head-movement-variance term (§6.5), any
    yawn-triggered alert (§5.7), any blink-rate-driven scoring (§4.1).

---

## 10. References

Standards and regulation

1. **[V]** Euro NCAP, *Safe Driving — Driver Engagement (Driver State Monitoring) Protocol v1.1*,
   Oct 2025. https://cdn.euroncap.com/cars/assets/euro_ncap_protocol_safe_driving_driver_engagement_v11_a30e874152.pdf
   — KSS > 7; microsleep 1–2 s; sleep ≥ 3 s; unresponsive ≥ 6 s; eyelid aperture 6.0–12.0 mm;
   occlusion and driver-behaviour tables; "yawn", "PERCLOS" and "blink" appear zero times.
2. **[V]** Euro NCAP, *Safe Driving — Driver Engagement Protocol v1.2*, Jul 2026.
   https://cdn.euroncap.com/cars/assets/Euro_NCAP_Protocol_Safe_Driving_Driver_Engagement_v1_2_ebce03a443.pdf
   — all drowsiness/microsleep/sleep/unresponsive numbers **unchanged**; microsleep gains "Assisted
   Mode" as an eligible intervention.
3. **[V]** Euro NCAP, *Technical Bulletin SD 202 — Driver Monitoring Test Procedure v1.2*, Jul 2026.
   https://cdn.euroncap.com/cars/assets/SD_202_Driver_Monitoring_Test_Procedure_v1_2_d3420cb629.pdf
   — ΔTsleep fixed at 3 s; ΔTmicrosleep 1–2 s; warning tolerance 0.2 s.
4. **[V via text proxy]** Commission Delegated Regulation (EU) 2021/1341 (DDAW).
   https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32021R1341 — warn at KSS ≥ 8;
   steering and lane-position indicators; "yawn" appears zero times.  (EUR-Lex refuses direct
   automated fetch; **SM §1** records the same wording as [V].)
5. **[V]** NHTSA, *Assessment of a Drowsy Driver Warning System for Heavy-Vehicle Drivers*,
   DOT HS 811 117, 2009. https://rosap.ntl.bts.gov/view/dot/9004/dot_9004_DS1.pdf — PERCLOS-1/3/5
   sensitivity settings (8/9/10 % advisory, 12 % warning); 721 valid of > 15,000 alerts; Table 108
   invalid-alert causes; glasses and 10-lux restrictions.

PERCLOS

6. **[V]** Wierwille, Wreggit, Kirn, Ellsworth & Fairbanks, *Research on Vehicle-Based Driver
   Status/Performance Monitoring*, DOT HS 808 247, 1994.
   https://rosap.ntl.bts.gov/view/dot/2578/dot_2578_DS1.pdf — the PERCLOS definition and the
   awake/questionable/drowsy bands 0.075 / 0.15 (p. 171), and their eyeballed provenance.
7. **[V]** Dinges & Grace, *PERCLOS: A Valid Psychophysiological Measure of Alertness*,
   FHWA-MCRT-98-006, 1998. https://rosap.ntl.bts.gov/view/dot/113/dot_113_DS1.pdf — P70/P80/EM;
   Table 1 coherences; 20-min > 1-min; alerting stimuli ineffective beyond the alert minute.
8. **[V]** Knipling & Wierwille, *Vehicle-Based Drowsy Driver Detection: Current Status and Future
   Prospects*, IVHS America 1994. https://rosap.ntl.bts.gov/view/dot/15347/dot_15347_DS1.pdf —
   "three regions: alert, questionable, and drowsy"; six-minute averages.  (The numeric band values
   are in Figure 4, an image — cite ref. 6 for the numbers.)
9. **[V]** Abe T., *PERCLOS-based technologies for detecting drowsiness: current evidence and future
   directions*, SLEEP Advances 4(1):zpad006, 2023.
   https://pmc.ncbi.nlm.nih.gov/articles/PMC10108649/ — definitions, sampling rates 2–120 Hz, blink
   exclusion 250/400/500 ms, the null results, the three technological limitations, PERCLOS↔crash
   conflicting vs PERCLOS↔lane-departure robust.
10. **[V]** Llaneras, Meyer & Barnes, *Assessment of Drowsiness Using the Johns Drowsiness Scale
    (JDS)*, NSTSCE Report #25-UI-177, 2026.
    https://vtechworks.lib.vt.edu/server/api/core/bitstreams/c6b0f28e-e23c-4724-bb43-18477dddb827/content
    — PERCLOS 15 % / 60 s rolling / 0.20 closure; hit 80.05 %, FA 8.62 %, miss 11.33 %; TTD 23/33/42
    min; KSS 8 ≈ JDS 6.26.
11. **[V]** Llaneras & Meyer, *Drowsiness Metrics and Thresholds: The Search for Valid and Reliable
    Standards*, NSTSCE Report #26-UI-182, 2026.
    https://vtechworks.lib.vt.edu/bitstreams/eb2441e0-5aa0-4528-9bdc-f3e87c3b7fe3/download
    — the < 5 / 6–8 / > 10 % bands; PERCLOS + SDLP → FA 0.81 %.  **This, not a 2022 report, is the
    source of the "> 10 %" figure; the window is 60 s.**
12. **[V]** Soccolich, Hammond, Camden & Walker, *Streamlining Drowsiness Assessment: ORD and
    PERCLOS Methods*, NSTSCE Report #24-UI-134, 2024.
    https://vtechworks.lib.vt.edu/bitstreams/f74df345-e779-45d6-bf3e-e6b58d671ae1/download
    — manual PERCLOS method, 12 % / 3-min fatigue threshold, blink exclusion ≤ 0.2 s, PERCLOS-1 vs
    PERCLOS-3 disagreement on drowsy cases.
13. **[V]** AAA Foundation, *Prevalence of Drowsy Driving Crashes: Estimates from a Large-Scale
    Naturalistic Driving Study* (SHRP 2).
    https://aaafoundation.org/wp-content/uploads/2026/01/FINAL_AAAFTS-Drowsy-Driving-Research-Brief-1.pdf
    — 12 % over 3 min at 15 fps; drowsiness in 8.8–9.5 % of crashes.
14. **[V abstract]** Jackson, Raj, Croft et al., *Traffic Injury Prevention*, 2016.
    https://pubmed.ncbi.nlm.nih.gov/26065627/ — PERCLOS r = 0.68 with vigilance, 0.61 with lane
    position.
15. **[V]** Association of visual-based signals with EEG in drivers with OSA.
    https://pmc.ncbi.nlm.nih.gov/articles/PMC11055081/ — "PERCLOS ≥ 0.3 || CLOSDUR ≥ 2 s"; 94.3 % /
    95.1 % EEG agreement on 927 episodes; 30 fps.
16. **[S]** Lin, Tan, Chua, Tey & Ang, *PERCLOS Threshold for Drowsiness Detection during Real
    Driving*, J Vision 2012 (VSS abstract). https://jov.arvojournals.org/article.aspx?articleid=2141193
    — baseline 6.13 %, 1-s microsleep 10.54 %, end point 12.22 %; suggested threshold 10 %.
    **ARVO blocks automated access; read only in a search-engine rendering of the abstract.**
17. **[S]** Trutschel, Sirois, Sommer, Golz & Edwards, *PERCLOS: An Alertness Measure of the Past*,
    6th Int. Driving Symposium, 2011, pp. 172–179, DOI 10.17077/drivingassessment.1394 — argues
    ETS and fused EEG/EOG carry more fatigue information than PERCLOS.  **Full text blocked
    (Anubis/TLS); abstract read only as quoted verbatim in MnDOT TRS 1501,
    https://mdl.mndot.gov/_flysystem/fedora/2023-01/trs1501.pdf.**

Blink and eyelid dynamics

18. **[V]** Ingre, Åkerstedt, Peters, Anund & Kecklund, *Subjective sleepiness, simulated driving
    performance and blink duration*, J Sleep Res 15(1):47–53, 2006.
    https://fatiguemanagersnetwork.org/wp-content/uploads/Ingre-et-al.2005_Subjective-Sleepiness-Simulated-Driving-Performance-and-Blink-Duration.pdf
    — blink duration by KSS (102 → 151 ms), +5.6 ms/level, ICC 0.30, individual SD 1.7× the step.
19. **[V]** Wilkinson VE, Jackson ML, Westlake J, Stevens B, Barnes M, Swann P, Rajaratnam SMW &
    Howard ME, *The Accuracy of Eyelid Movement Parameters for Drowsiness Detection*,
    JCSM 9(12):1315–1324, 2013.
    https://pmc.ncbi.nlm.nih.gov/articles/PMC3836343/ — "blink duration in rested conditions lasts
    for less than 200 ms"; IED AUC 0.816/0.834 vs %TEC 0.683; IED sens/spec 71/88 and 100/86.
20. **[V]** Shekari Soleimanloo, Wilkinson, Cori et al., *Eye-Blink Parameters Detect On-Road
    Track-Driving Impairment Following Severe Sleep Deprivation*, JCSM 15(9):1271–1284, 2019.
    https://pmc.ncbi.nlm.nih.gov/articles/PMC6760410/ — IED +18.6 ms, BTD +65.3 ms, LEC rate ×2.9;
    spec 70.12–84.15 % at sens 50 %; BTD > 426 ms predicts drive termination; JDS bands 4.5/5/10.
21. **[V]** Johns MW, *The amplitude–velocity ratio of blinks*, APSS poster, 2003.
    https://www.mwjohns.com/wp-content/uploads/2017/05/apss_2003_06_03_the_amplitude_velocity_ratio_of_blinks_a_new_method_of_monitoring_drowsiness_poster_69.pdf
    — alert blink 111 ± 51 ms (59–182 ms); drowsy blinks > 500 ms; AVR 4.1 → 6.4; **78 % of lapses
    occur with the eyes open**.
22. **[V]** Tucker & Johns, *The duration of eyelid movements during blinks*, APSS poster, 2005.
    https://www.mwjohns.com/wp-content/uploads/2017/05/apss_2005-06-18_the_duration_of_eyelid_movements_during_blinks.pdf
    — closing 103 → 165 ms, reopening 162 → 273 ms, closed 0.3 → 144 ms, total 265 → 586 ms.
23. **[V]** Johns, Tucker, Chapman, Crowley & Michael, *Monitoring eye and eyelid movements by
    infrared reflectance oculography to measure drowsiness in drivers*, Somnologie 11:234–242, 2007.
    https://www.mwjohns.com/wp-content/uploads/2017/05/johns_et_al_2007_monitoring_eye_and_eyelid_movements_by_ir_reflectance_oculography_to_measure_drowsiness_in_drivers.pdf
    — 500 Hz; the four JDS terms and weights; JDS alert 2.5 vs drowsy 6.8; **blink rate deliberately
    excluded as "too task-dependent and too subject-specific"**.
24. **[V]** Johns, Chapman, Crowley & Tucker, *A new method for assessing the risks of drowsiness
    while driving*, Somnologie 12:66–74, 2008.
    https://www.mwjohns.com/wp-content/uploads/2017/05/johns_et_al_2008_a_new_method_for_assessing_the_risks_of_drowsiness_while_driving.pdf
    — AUC 76.1 % for off-road events; sens/spec 91.0/51.3 at JDS 4.0 and 45.0/85.2 at 7.0; ~10× risk
    above JDS 7.
25. **[V]** Optalert, *What is the Optalert JDS*.
    https://www.optalert.com/what-is-the-optalert-jds-and-why-is-it-leading-the-drowsiness-monitoring-field/
    — 0–10 scale, bands 0–3 / 3–4.4 / 4.5–4.9 / 5–10, 64 parameters, 500 Hz wearable.
26. **[S abstract]** Caffier, Erdmann & Ullsperger, *Experimental evaluation of eye-blink parameters
    as a drowsiness measure*, Eur J Appl Physiol 89(3–4):319–325, 2003.
    https://pubmed.ncbi.nlm.nih.gov/12736840/ — 60 subjects; blink duration and reopening time most
    reliable; "proportion of long closure duration blinks" informative (threshold not stated in the
    abstract; full text paywalled).
27. **[S abstract]** Caffier, Erdmann & Ullsperger, Sleep Med 6(2):155–162, 2005 — blink frequency
    *increases* as sleepiness *decreases* in 21 OSA patients.
    https://pubmed.ncbi.nlm.nih.gov/15716219/
28. **[S abstract]** Schleicher, Galley, Briest & Galley, *Blinks and saccades as indicators of
    fatigue in sleepiness warnings: looking tired?*, Ergonomics 51(7):982–1010, 2008.
    https://pubmed.ncbi.nlm.nih.gov/18568959/ — 129 participants; blink duration, delay of lid
    reopening, blink interval and standardised lid closure speed identified as best indicators.
    **Fully paywalled with no repository copy (confirmed via Unpaywall/OpenAlex/DLR) — no numeric
    value from this paper is quoted anywhere in this memo.**
29. **[S abstract]** Cori, Anderson, Shekari Soleimanloo, Jackson & Howard, *Narrative review: Do
    spontaneous eye blink parameters provide a useful assessment of state drowsiness?*, Sleep Med
    Rev 45:95–104, 2019. https://pubmed.ncbi.nlm.nih.gov/30986615/ — "blink duration and percentage
    of eye closure the most robust… generally fair to good accuracy"; no pooled accuracy figure.
30. **[S abstract]** Häkkänen, Summala, Partinen, Tiihonen & Silvo, Sleep 22(6):798–802, 1999.
    https://pubmed.ncbi.nlm.nih.gov/10505826/ — blink duration separated OSA bus drivers from
    controls (82.3 vs 51.9 ms); **blink frequency did not**.
31. **[S abstract]** Stern, Boyer & Schroeder, Hum Factors 36(2):285–297, 1994.
    https://pubmed.ncbi.nlm.nih.gov/8070793/ — blink rate rises with time on task, but many other
    variables affect it.
32. **[S abstract]** Recarte, Pérez, Conchillo & Nunes, Span J Psychol 11(2):374–385, 2008.
    https://pubmed.ncbi.nlm.nih.gov/18988425/ — cognitive load raises blink rate, visual demand
    inhibits it.
33. **[S abstract]** Lee ML et al., *A pre-drive ocular assessment predicts alertness and driving
    impairment*, Accid Anal Prev 135:105386, 2020.
    https://research.monash.edu/en/publications/a-pre-drive-ocular-assessment-predicts-alertness-and-driving-impa/
    — "behavioural microsleeps (blinks > 500 ms)" as the outcome definition.
34. **[S abstract]** *Video frame rate influences the accuracy of blink dynamics measurement*,
    2026. https://www.sciencedirect.com/science/article/pii/S1542012426000091 — 500 fps downsampled
    to 250/100/50/25; amplitude and duration robust at all rates, velocities need ≥ 250 fps.

Microsleep

35. **[V]** Hertig-Godeschalk, Skorucak, Malafeev, Achermann, Mathis & Schreier, *Microsleep episodes
    in the borderland between wakefulness and sleep*, SLEEP 43(1):zsz163, 2020.  Publisher PDF via
    ETH Zurich Research Collection, https://www.research-collection.ethz.ch/handle/20.500.11850/391782
    — the **BERN criteria**: MSE 1–15 s, occipital theta, **eyes ≥ 80 % closed**; inter-scorer
    kappa 0.75; sleep followed the first MSE by ~6 min on average.
36. **[V]** Skorucak, Hertig-Godeschalk, Achermann, Mathis & Schreier, *Automatically Detected
    Microsleep Episodes in the Fitness-to-Drive Assessment*, Front Neurosci 14:8, 2020.
    https://www.frontiersin.org/journals/neuroscience/articles/10.3389/fnins.2020.00008/full
    — **34.4 % (MWT) / 38.5 % (driving simulator) of MSEs are shorter than 3 s**; median MSE 3.40 s;
    rate 0.74/min.
37. **[V]** Poudel, Innes, Bones, Watts & Jones, *Losing the struggle to stay awake*, Hum Brain Mapp
    35(1):257–269, 2014. https://pmc.ncbi.nlm.nih.gov/articles/PMC6869765/ — behavioural microsleeps
    0.5–15 s; mean 3.3 s, median 2.5 s; rate 79/h.
38. **[V]** Santschi, Schreier, Hertig-Godeschalk et al., Nat Sci Sleep 15:677–690, 2023.
    https://www.dovepress.com/article/download/86027 — most frequent eyelid-closure episode 2–4 s;
    ~90 % < 10 s; > 50 % of closures in the 5 min before the first MSE.
39. **[V]** *Prolonged Eyelid Closure Episodes during Sleep Deprivation in Professional Drivers*
    (authors not read; PMID 27306397), JCSM 2016. https://pmc.ncbi.nlm.nih.gov/articles/PMC4957187/
    — closures "80 % closure as per PERCLOS ≥ 1 s"; 0 s/h at 3 h awake → 34 s/h at 23 h; 7–18 s
    episodes after 20 h; crash r = 0.43, SDLP r = 0.60.
40. **[V]** Seeing Machines Guardian driver information.
    https://guardian.seeingmachines.com/driver-info-anz — fatigue event at eyes closed ≥ 1.5 s;
    distraction at 4 s.
41. **[V]** Patents stating closure thresholds: Bosch **US10748404B2** (microsleep 1.5 s);
    Bosch **US10105104B2** (1 s warning, 0.1–0.5 s hysteresis); **US7301465B2** (1–1.5 s);
    **US8063786B2** (3 s closure, 2–3 s head drop); Hyundai **US10262219B2** (6 s within 60 s);
    **US8570176B2** (microsleep 3–15 s); Circadian **US6511424B1** (1–30 s).  All via
    https://patents.google.com/.

Head pose, gaze and fusion

42. **[V]** Friedrichs & Yang, *Camera-based Drowsiness Reference for Driver State Classification
    under Real Driving Conditions*, IEEE IV 2010.
    https://www.iss.uni-stuttgart.de/forschung/publikationen/friedrichs_iv2010.pdf — 30 real-road
    drives, 23 drivers, Seeing Machines DSS 3.0 at 60 Hz; the KSS table; feature–KSS correlations
    (AVR +0.50, AECS −0.46, PERCLOS70BL +0.27, HEADNOD −0.25, BLINKFREQ −0.11, MICROSLEEP1S +0.01);
    130 ms blink floor; |yaw| ≤ 15° and v > 30 km/h gates; baselining over the first 15 min; "drivers
    often do not completely open their eyes any more when they become sleepy"; ANN recall
    88.0/81.2/62.6 %.
43. **[V]** Bergasa, Nuevo, Sotelo, Barea & Lopez, *Real-Time System for Monitoring Driver
    Vigilance*, IEEE T-ITS 7(1):63–77, 2006. https://invett.aut.uah.es/sotelo/IEEETITS2006.pdf
    — six visual cues ranked (fixed gaze 95.62 %, PERCLOS 93.12 %, face direction 87.5 %, closure
    duration 84.37 %, blink frequency ~80 %, nodding 72.5 %); fixed-gaze levels 0.05 / 0.15;
    "Nodding is the last fatigue effect to appear".  **Fatigue behaviours were acted.**
44. **[V]** Seeing Machines, **US11144756B2**, *Method and apparatus for distinguishing between a
    downward glance and an eye closure*. https://patents.google.com/patent/US11144756B2/en —
    head-pitch change ±5° (range ±1–10°), eye-closure threshold 0.3, 12-frame buffer, ±2 s window.
45. **[V]** Fotonation/Tobii, **US10740633B2**, *Human monitoring system incorporating calibration
    methodology*. https://patents.google.com/patent/US10740633B2/en — baseline eye opening = median
    over ~90 frames at journey start, driver assumed alert.
46. **[V]** Vural et al., *Drowsy driver detection through facial movement analysis*, ICCV-W 2007. https://mplab.ucsd.edu/46/media/vesra.pdf — head motion
    increases with drowsiness, roll couples to steering (0.33 → 0.71), head becomes still just
    before sleep.
47. **[V]** Van den Berg J., *Sleepiness and head movements*, Industrial Health 44:564–576, 2006.
    https://www.jstage.jst.go.jp/article/indhealth/44/4/44_4_564/_pdf/-char/en — head velocity
    2.7 → 3.5–4.0 deg/s with sleep deprivation; no pitch/roll directional preference; pupillography
    "impractical to use while driving".
48. **[V]** Joshi, Kyal, Banerjee & Mishra (Affectiva), *In-the-wild Drowsiness Detection from
    Facial Expressions*, arXiv:2010.11162. https://arxiv.org/pdf/2010.11162 — 223 night-shift drivers in their own vehicles, 30 fps; the
    4-level annotation rubric (yawning at *Slightly Drowsy*, fixation on single points at
    *Moderately Drowsy*); head pose among the most predictive features; macro ROC-AUC 0.78.
49. **[V]** *Sleep deprivation and driver gaze* (authors not read), Sci Rep 8:1704, 2018.
    https://pmc.ncbi.nlm.nih.gov/articles/PMC5797225/ — fixation rate 76.91 → 60.80/min, saccade
    amplitude 19.16 → 27.77°, blink rate 39.42 → 52.40/min, blink duration 179.88 → 200.75 ms, lane
    departure OR 3.20.
50. **[V]** Wang & Ma, *Driving fatigue and eye movement*, Archives of Civil Engineering 2018.
    https://www.czasopisma.pan.pl/Content/115590/PDF/11_ace-2018-0023.pdf — 36 commercial drivers,
    Smart Eye Pro at 200 Hz; fixation duration +58.80 %, search-angle deviation −26.94 % after 4 h.
51. **[V]** Andersson, Nyström & Holmqvist, *Sampling frequency and eye-tracking measures*, J Eye
    Mov Res 3(3):6. https://bop.unibe.ch/JEMR/article/download/2300/3496/8524 — > 300 Hz needed for
    saccadic peak velocity; 60 Hz only for saccades > 10°.
52. **[V]** NASA technical report on saccadic velocity under sleep deprivation (authors not read).
    https://ntrs.nasa.gov/api/citations/20190033423/downloads/20190033423.pdf — 5–10 % decline
    typical, 10–30 % for small catch-up saccades at 250 Hz.
53. **[V]** AMTech PSTxsIII pupillographic sleepiness test.
    https://www.amtech.de/en/products/pstxs3 — 25 Hz, 0.05 mm resolution, 11 min; and
    https://pmc.ncbi.nlm.nih.gov/articles/PMC7078331/ for the PUI computation (4 ms sampling,
    640 ms segments, 12.4 ± 4.5 mm/min normative).

Landmarks, EAR/MAR and sensing limits

54. **[V]** Soukupová & Čech, *Real-Time Eye Blink Detection using Facial Landmarks*, CMP TR-2016-05.
    https://cmp.felk.cvut.cz/ftp/articles/cech/Soukupova-TR-2016-05.pdf — the EAR formula; blink
    100–400 ms; awake < 400 / drowsy 400–800 / sleepy > 800 ms; "two or more seconds" for drowsiness.
55. **[V]** Wolter, Berrio Perez & Shan, *Blinking Beyond EAR: A Stable Eyelid Angle Metric*,
    arXiv:2511.19519. https://arxiv.org/html/2511.19519v1 — EAR "inherently viewpoint dependent";
    the 3-D eyelid angle; frame-rate table (blink detection 51 % at 10 Hz, 95 % at 30 Hz) and the
    32 % closing-duration shift between 30 and 50 Hz.
    **The "EAR fluctuates by 15 %" figure circulating on aggregator sites is not in this paper.**
56. **[V abstract]** Read, Collins, Carney & Iskander, *The morphology of the palpebral fissure in
    different directions of vertical gaze*, Optom Vis Sci 83(10):715–722, 2006.
    https://pubmed.ncbi.nlm.nih.gov/17041316/ — vertical aperture 9.7 ± 1.2 mm primary →
    6.4 ± 1.1 mm at 40° downgaze (n = 76).
57. **[V]** Palpebral fissure in vertical gaze, Brazilian cohort (n = 10).
    https://www.scielo.br/j/abo/a/jjLPyC8JqWQKW6PtzrC9sBz/ — 10.8 mm at 0° → 8.7 at −20° → 7.8 at
    −30°.
58. **[V abstract]** Palpebral fissure norms in 498 Asian adults.
    https://pubmed.ncbi.nlm.nih.gov/18349663/ — 8.0 ± 1.0 / 8.2 ± 1.1 mm.  Also
    https://pmc.ncbi.nlm.nih.gov/articles/PMC3730197/ (Hong Kong, 11.55–11.94 mm).
59. **[V]** MDPI *Sensors* DMS study, 27 participants, generic USB camera 640×480 at 30 fps.
    https://pmc.ncbi.nlm.nih.gov/articles/PMC12899127/ — open-eye EAR mean 0.2570, SD 0.02109;
    threshold 0.23 = 1.3 SD below the mean; yawn detection 85.19 %; "the MAR is inherently sensitive
    to… speech or laughter".
60. **[V]** *Adjusting eye aspect ratio for strong eye blink detection*, PeerJ CS-943.
    https://pmc.ncbi.nlm.nih.gov/articles/PMC9044337/ — per-video optimal EAR 0.2103–0.2923; 21.1 %
    vs 95 % accuracy from a 0.01 threshold change.
61. **[V]** *Improving Driver Drowsiness Detection via Personalized EAR/MAR Thresholds*,
    arXiv:2604.22479. https://arxiv.org/html/2604.22479 — 5-s calibration, 0.75 × EAR / 1.4 × MAR,
    open-eye accuracy 89.0 → 98.9 %.
62. **[V]** Mujtaba, Radchenko, Masana & Prodan, *YawDD+*, arXiv:2512.11446 — MediaPipe lip landmark
    sets; YawDD's video-level labels mean only 24–40 % of frames in a "yawning" video are yawns.
63. **[V]** MediaPipe Face Landmarker documentation.
    https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker — 478 landmarks,
    52 blendshapes, blendshape input `1 x 146 x 2`.
64. **[V]** NIR transmittance of tinted spectacle lenses.
    https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12158342/ — NIR blocking 14.22 ± 4.03 % (grade 0)
    to 13.12 ± 3.07 % (grade 3): a dark lens still passes ~87 % of 940 nm light.
65. **[V]** NTHU-DDD landmark-classifier degradation: arXiv:1811.01627 (Table 2) and arXiv:2002.03728
    (Table III) — glasses −2.3 to −5.1 pp, sunglasses −10.2 to −12.0 pp, night −3.1 to −5.7 pp.
66. **[V]** *Real-time eye tracking and PERCLOS measurement*, arXiv:1505.06162.
    https://arxiv.org/pdf/1505.06162 — "For accurate estimation of PERCLOS the frame rate should be
    greater than 4 fps"; > 90 % accuracy above 5 fps.
67. **[V]** Dasgupta, George, Happy & Routray, *A Vision Based System for Monitoring the Loss of
    Attention in Automotive Drivers*, arXiv:1505.03352 — a 3-minute 66.67 %-overlapping PERCLOS
    window with a 15 % threshold.

Yawning

68. **[V]** Provine RR, *Yawning*, American Scientist 93:532–539, 2005.
    https://www.americanscientist.org/sites/americanscientist.org/files/200510314450_646.pdf
    — "about six seconds on average… from about three and a half seconds to much longer";
    inter-yawn interval ~68 s; no rate/duration relation; boredom raises rate ~70 %; no half-yawns.
69. **[V]** Guggisberg, Mathis, Schnider & Hess, *Why do we yawn?*, Neurosci Biobehav Rev
    34(8):1267–1276, 2010. http://www.tutis.ca/Senses/L9Auditory/Guggisberg.pdf — drowsiness →
    yawning is well supported (EEG delta), the arousal hypothesis is rejected, thermoregulation is
    "inconclusive".
70. **[V]** Jie, Mahmoud, Stafford-Fraser, Robinson, Dias & Skrypchuk, *Analysis of yawning behaviour
    in spontaneous expressions of drowsy drivers*, IEEE FG 2018 (HBU).
    https://www.cl.cam.ac.uk/~mmam3/pub/FG2018-HBU-yawining.pdf — 123 spontaneous yawns, mean
    6.28 s; drowsy > alert yawn frequency p < 0.01; covered + uncovered yawns at 95 % using mouth
    **and eye** regions; hand-over-face gestures more frequent when drowsy.
71. **[V]** *YawnStim* stimulus-set paper, PeerJ 2025.
    https://pmc.ncbi.nlm.nih.gov/articles/PMC13308540/ — quoting Schino & Aureli 1989 (50.8 % of
    male, 67.4 % of female commuters cover their yawns) and Gallup & Church 2015 (44 % even when
    alone).  **The two underlying studies are [S] — not read directly.**
72. **[V]** *Neuromorphic Sensing for Yawn Detection in Driver Drowsiness*, arXiv:2305.02888 —
    yawn labels mean 4.03 s (SD 2.26, max 9.63); talking/laughing false positives; covered yawns.
73. **[V of the abstract page]** Kassem, Chowdhury, Abawajy & Al-Sudani, *Yawn Based Driver Fatigue
    Level Prediction*, EPiC Series in Computing, 2020, pp. 372–382, DOI 10.29007/67kk.
    https://easychair.org/publications/paper/NMPW — the only published yawn-rate bands: alert = no
    yawning, early fatigue = one yawn per minute, fatigued = more than one per minute.
    **Asserted, not validated against KSS/PVT/EEG; trained on the acted YawDD dataset.**
74. **[S abstract]** Watling CN et al., *Examining signs of driver sleepiness…*, Accid Anal Prev,
    2015. https://pubmed.ncbi.nlm.nih.gov/26364140/ — yawning and frequent blinks are *early*
    signs associated with continuing to drive while sleepy; advanced signs associate with close calls.
75. **[V]** Vendor pages checked for yawn detection and found not to mention it:
    Seeing Machines https://www.seeingmachines.com/technology/ ; Smart Eye
    https://smarteye.se/solutions/automotive/driver-monitoring-system/ ; Bosch
    https://www.bosch-mobility.com/en/solutions/interior/driver-drowsiness-detection/ .

Context

76. **[V]** Klauer, Dingus, Neale, Sudweeks & Ramsey, *The Impact of Driver Inattention on
    Near-Crash/Crash Risk* (100-Car), DOT HS 810 594, 2006.
    https://rosap.ntl.bts.gov/view/dot/62931/dot_62931_DS1.pdf — drowsiness OR 4–6; the Wierwille &
    Ellsworth ORD anchors (Very Drowsy 2–3 s closures, Extremely Drowsy 4 s or more) in Appendix C.
77. **[V]** Dingus et al., PNAS 113(10):2636–2641, 2016.
    https://pmc.ncbi.nlm.nih.gov/articles/PMC4790996/ — drowsiness/fatigue OR 3.4, present in 1.57 %
    of baselines.
78. **[V abstract]** Kaplan KA et al., *Awareness of sleepiness and ability to predict sleep
    onset*, Sleep Med, 2007. https://pubmed.ncbi.nlm.nih.gov/17644422/ — 41 sleep-deprived subjects
    predicted sleep at only 55 % likelihood before their *first* sleep event; "a scarcity of
    meaningful warning signs and a failure to acknowledge" them.
79. **SM** — `deployment-stack/docs/research/dms_standards_and_thresholds.md` (2026-09-12), the
    companion memo this document extends.
80. **T / D6 / D12** — `deployment-stack/docs/THRESHOLDS.md` and `deployment-stack/docs/DESIGN.md`
    §6 and §12, the shipped configuration and its measured false-alarm rates.

### Claims I could not source, stated plainly

* **No study tabulates yawns per hour against KSS levels.**  The "> 1 yawn per minute = fatigued"
  rule has one unvalidated conference source (ref. 73).
* **No published threshold exists for a "% of blinks > 400 ms" long-blink share.**  The sourced
  boundaries are > 500 ms (physiological) and > 10 ms fully closed (device-specific).
* **No standard or primary defines a drowsy head nod in degrees**, and published values span 12–45°.
* **No study validates head-nod detection against polysomnographic microsleep.**
* **No official drowsiness recovery duration exists** in any standard.
* **No peer-reviewed study shows that a personalised PERCLOS baseline improves accuracy** — it is
  industrial practice (ref. 45) plus EAR-level evidence (ref. 61).
* **No published quantification of EAR error per degree of head yaw/pitch**, of rolling-shutter or
  mount-vibration effects on landmark stability, of visible-light landmark accuracy at 1 lux, or of
  the yawn false-alarm rate caused by talking or singing.  All four are directly measurable on our
  own rig and would be original contributions.
* **Sommer & Golz's widely quoted "EEG/EOG 13 % error vs PERCLOS 26–42 %"** could not be verified in
  any primary or government source.  Do not cite it.
