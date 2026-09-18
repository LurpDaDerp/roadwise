# How long may a driver look away, and at what angle? — the evidence

Research memo, 2026-09-18.  Written to answer one question directly: *given a gaze
direction expressed as an angle away from the driver's straight-ahead road view, after how
many seconds does holding that direction become unsafe?*

Verification marks, same convention as `dms_standards_and_thresholds.md`:
**[V]** read directly in the primary text (PDF/HTML fetched and grepped, or a publisher's
own abstract page); **[V abs]** read in the publisher's abstract only, full text paywalled;
**[S]** taken from a secondary page or a search summary of a primary I could not open;
**[E]** my own estimate or arithmetic, clearly not a measurement.  Where I could not find a
source at all, the text says so.

---

## 0. The short answers

1. **No standard anywhere defines the forward road view, or any other zone, by an angle.**
   Euro NCAP and the EU ADDW regulation both define zones by *target* — "rear-view mirror",
   "passenger face", "in-vehicle infotainment" — and leave the angular geometry to the
   manufacturer's dossier [V].  The one exception is ADDW, which defines three *areas* with
   real angles (±55° laterally, a 30°-down plane) but uses them to say what is **excluded**
   from the road, not to set a per-angle timer [V].
2. **There is no published formula `t_max = f(angle)`.**  The closest published attempt —
   Liang, Lee & Yekhshatyan (2012), who compared 24 crash-risk algorithms built from glance
   duration, glance history and **glance location** on 100-Car data — found that weighting
   duration by glance location performed *the same* as duration alone [V abs].  Angle buys
   you the target class; it does not buy you a smoother time limit.
3. **Angle does change one thing, and it is measurable:** how much warning you get from the
   part of the scene you are *not* looking at.  Lamble et al. (1999) measured the
   time-to-collision at which a driver notices a decelerating lead car while fixating an
   in-car display: **TTC 6–8 s at 0° eccentricity, falling to 4 s at 90°** [V abs].  Morando
   et al. (2022) measured detection probability across the field while driving a real
   highway: **flat through the near periphery, declining rapidly beyond 20°–30°, with a
   useful field extending to about 70°** [V abs].  So the practical rule is: up to ~20° of
   eccentricity the driver still sees the road; past ~30° they progressively stop seeing it.
4. **Therefore the deployable rule is a two-step one**: use the angle to decide *which class
   of thing* the driver is looking at, then apply that class's published time limit, and use
   the angle only as a *severity/escalation* weight on top.  §2.6 gives the synthesised
   relation, marked [E].

---

## 1. Angle-versus-time table

### 1.1 Where the angles come from

Nobody publishes a measured table of driver gaze yaw/pitch per in-cabin target.  I searched
for one and did not find it; the nearest published measurement is the IVGaze dataset, which
reports only the **overall** range across its nine zones — "horizontal gaze is from −50° to
90°, and the vertical gaze is from −40° to 40°" [V].  So the angles below are **[E]
geometric estimates** computed from an explicit cabin model, and every one of them can be
re-derived or replaced per vehicle.

Model (left-hand-drive mid-size sedan, driver's eye point at the origin, +x right, +y up,
+z forward, metres; yaw = atan2(x, z), pitch = atan2(y, √(x²+z²)), eccentricity = the 3-D
angle from straight ahead):

| target | offset (x, y, z) m | yaw | pitch | 3-D eccentricity |
|---|---|---|---|---|
| lane ahead, 60 m | (0, −0.9, 60) | 0° | −0.9° | 0.9° |
| adjacent lane, 40 m ahead | (3.3, −0.8, 40) | +4.7° | −1.1° | 4.9° |
| kerb / road edge, 20 m ahead | (2.5, −1.0, 20) | +7.1° | −2.8° | 7.7° |
| overhead traffic light, 8 m | (0, 2.6, 8) | 0° | +18.0° | 18.0° |
| head-up display | (0.05, −0.12, 2.20) | +1.3° | −3.1° | 3.4° |
| instrument cluster centre | (0.05, −0.35, 0.75) | +3.8° | −25.0° | 25.2° |
| phone held at top of wheel | (0.05, −0.25, 0.55) | +5.2° | −24.4° | 24.9° |
| phone on dash mount | (0.30, −0.18, 0.72) | +22.6° | −13.0° | 25.9° |
| interior rear-view mirror | (0.42, 0.25, 0.75) | +29.2° | +16.2° | 33.1° |
| sun visor (lowered) | (0.05, 0.35, 0.55) | +5.2° | +32.4° | 32.7° |
| centre-stack display | (0.45, −0.30, 0.70) | +32.7° | −19.8° | 37.7° |
| driver (left) door mirror | (−0.78, −0.25, 0.95) | −39.4° | −11.5° | 40.8° |
| passenger (right) door mirror | (1.62, −0.25, 1.55) | +46.3° | −6.4° | 46.6° |
| overhead console / roof | (0.15, 0.55, 0.45) | +18.4° | +49.2° | 51.7° |
| phone in lap | (0.10, −0.55, 0.45) | +12.5° | −50.0° | 51.2° |
| glovebox | (0.85, −0.45, 0.65) | +52.6° | −22.8° | 55.9° |
| low centre console / shifter | (0.35, −0.60, 0.45) | +37.9° | −46.5° | 57.1° |
| passenger footwell | (0.80, −0.85, 0.60) | +53.1° | −40.4° | 62.8° |
| driver side glass, road to the left | (−0.70, 0, 0.35) | −63.4° | 0° | 63.4° |
| driver side window (level) | (−0.55, 0, 0.10) | −79.7° | 0° | 79.7° |
| phone at inboard knee | (0.20, −0.70, 0.35) | +29.7° | −60.1° | 64.3° |
| passenger face | (0.75, 0.05, 0.10) | +82.4° | +3.8° | 82.4° |

Two conversions that make the horizontal table readable: lateral offset on the road surface
is `d·tan θ`, so 5° is 1.8 m at 20 m and 5.3 m at 60 m; 10° is 3.5 m at 20 m (one lane) and
10.6 m at 60 m; 20° is 7.3 m at 20 m and 21.8 m at 60 m [E].  Downward, with the eye 1.2 m
above the road, a gaze θ below the horizon meets the road at `1.2/tan θ`: 5° → 13.7 m,
10° → 6.8 m, 15° → 4.5 m, 20° → 3.3 m, and the bonnet edge (~2.5–3 m ahead) is already at
about 22° [E].  **A downward gaze steeper than roughly 22–25° cannot be the road at all**,
which is exactly where the instrument cluster sits and just above the ADDW 30° plane.

### 1.2 Horizontal eccentricity (LHD car; "left" = driver side)

"Limit" = the time after which a single continuous glance should be treated as unsafe.
Nothing in this column is an angle-derived number: it is the limit for the *target class*
that the angle band most often contains.

| eccentricity | most likely target (LHD) | class under Euro NCAP / ADDW | single-glance limit | source of the limit |
|---|---|---|---|---|
| 0–5° | windshield centre, own lane, lead vehicle, HUD | forward road view; ADDW Area 2 | none | not a glance away from the road [V] |
| 5–10° | own and adjacent lane, road edge, near kerb | forward road view; Area 2 | none | inside every published road-centre AOI (radius 6°, 8° or 10°) [V] |
| 10–15° | windshield: adjacent lanes at 25–60 m, roadside signs, oncoming lane | still forward road view (windshield); Area 2 | none | Euro NCAP's forward road view is the windshield, not the road centre [V]; 100-Car: brief scanning glances *reduce* risk [V abs] |
| 15–20° | outer windshield, A-pillar edge, far kerb, mirror housings | forward road view / boundary | none, but count toward the cumulative rule | drivers in near-crashes sampled peripheral road regions *more* than drivers in crashes (Seppelt et al. 2017) [V abs] |
| 20–25° | interior rear-view mirror (≈ +29° right, +16° up); left A-pillar; upper centre stack | driving-related (mirror) or non-driving (stack) | **4 s** mirror/cluster, first **1 s** not counted; **3 s** if it is the stack | Euro NCAP long distraction 3–4 s [V]; AttenD 1-s allowance [S]; Volvo long-glance warning at 4 s [V] |
| 25–30° | rear-view mirror, centre-stack display (≈ +33°), phone on a dash mount | mirror = driving-related; stack/phone = non-driving | 4 s / **3 s** | as above; ADDW 3.5 s at ≥ 50 km/h [V] |
| 30–45° | centre stack, driver's door mirror (≈ −39°), glovebox edge | mirror = driving-related; rest non-driving | 4 s (1 s free) / **3 s** | as above |
| 45–60° | passenger door mirror (≈ +46°), glovebox (≈ +53°), passenger footwell, shoulder check | mirror = driving-related; glovebox/footwell non-driving; beyond ±55° = ADDW **Area 1** | 4 s (1 s free) / **3 s**; **relax to 4 s at an intersection or during a turn** | ADDW Area 1 = outside ±55° [V]; FHWA: drivers spend **2.40 s** on the far left and **1.82 s** on the far right inside the last 98 ft of a rural intersection approach [V] |
| > 60° | driver side window / side glass (−63° to −90°), passenger face (≈ +82°), rear passenger | never the forward road; Area 1; Euro NCAP "Owl" non-driving targets | **3 s**, and **2 s** once speed is known ≥ 50 km/h | Euro NCAP long distraction 3–4 s, driver/passenger side window and passenger face are explicit non-driving targets [V]; no source supports going below 2 s, see §7 |

### 1.3 Vertical, upward

| pitch up | most likely target | class | limit | source |
|---|---|---|---|---|
| 0–10° | upper windshield, distant signs, high traffic lights, gantries | forward road view; Area 2 | none | [V] |
| 10–20° | interior rear-view mirror (+16°), overhead traffic light at 8 m (+18°), sign gantry | driving-related | **4 s**, first 1 s free | Euro NCAP mirror = driving-task target [V]; AttenD [S] |
| 20–30° | sun visor (+32° when lowered), top of the header rail, overhead console | non-driving | **3 s** | Euro NCAP long distraction [V] |
| > 30° | headliner, roof, overhead console (+49°), sunroof | **ADDW Area 1 explicitly includes the roof** — cannot be the road | **2 s** | Area 1 definition [V]; 2 s is my own floor [E], see §5 |

I found **no** study and no standard that sets a time limit on upward gaze specifically.  The
2 s above is an engineering choice, not a measurement.

### 1.4 Vertical, downward

| pitch down | most likely target | class | limit | source |
|---|---|---|---|---|
| 0–10° | road surface 7–14 m ahead, bonnet, lead vehicle in slow traffic | forward road view | none | geometry [E]; Area 2 [V] |
| 10–20° | instrument cluster upper edge, HUD, stop-and-go lead bumper, phone on a dash mount (−13°) | driving-related, or a *phone* | **4 s** cluster; **3 s** and phone-pattern logic if it is a phone | Euro NCAP "advanced" phone-use targets are exactly these: dash-mounted, held in the windscreen field of view, held in the cluster view [V] |
| 20–30° | instrument cluster centre (−25°), phone at the top of the wheel (−24°), centre stack (−20°) | driving-related (cluster) / non-driving | 4 s / **3 s** | Euro NCAP [V].  **NHTSA's ceiling for any compliant display sits here**: 2-D Maximum Downward Angle **30.00°** for an eye point ≤ 1700 mm, 3-D Maximum **28.16°** for an eye point ≤ 1146.2 mm [V] |
| > 30° | lap, hand-held phone (−50°), knee (−60°), footwell, low console (−47°), floor | **ADDW Area 3** — below any compliant display location; 100 % off-road | **3.5 s** at ≥ 50 km/h, **6 s** at 20–50 km/h (regulatory), **3.0 s** recommended | ADDW §3.3.2.1/2 [V]; Euro NCAP 3–4 s [V] |

### 1.5 The cumulative rule, which is angle-free

- **Euro NCAP VATS / short distraction**: "a cumulative 10 seconds within a 30 second time
  period" away from the forward road view [V].  Seeing Machines' operationalisation adds
  "where a driver does not return their gaze to the road for a minimum of 2 seconds", and
  restricts VATS to non-driving-related regions [S].
- **NHTSA 2013**: total eyes-off-road time for one task ≤ **12.0 s**, mean glance ≤ **2.0 s**,
  and no more than 15 % of glances longer than 2.0 s [V].
- **AttenD**: a 2-second buffer that drains at 1 s/s off-road and refills on-road; empty =
  distracted [S].

None of these three weights a second by the angle at which it was spent.

---

## 2. Is there a formula?

### 2.1 What the standards actually do

Euro NCAP's Driver Engagement protocol lists gaze **locations** and tags each as
driving-task (rear-view mirror, both door mirrors, instrument cluster) or non-driving
(driver side window, passenger side window, passenger footwell, passenger face, IVI,
glovebox, rear passenger) [V].  The only angular cone in the whole protocol is the "direct
driver's line of sight" used for *control placement*: bounded laterally by planes at +30°
and −30° through the ocular reference point and vertically by a plane 30° downward [V].
ADDW is the only instrument with real angles: Area 1 = the roof plus everything outside two
vertical planes at ±55° about the ocular reference point; Area 2 = the windscreen and windows
plus a 10° margin; Area 3 = everything below a plane 30° down, excluding Areas 1 and 2 [V].
Only **Area 3** starts a timer.  Nothing in either document makes the timer a function of the
angle inside an area.

### 2.2 The eccentricity literature — what angle really costs you

- **Lamble, Laakso & Summala (1999), *Ergonomics* 42(6).**  Twelve drivers followed a car
  decelerating at ~0.7 m/s² from 50 km/h at 20 m and 40 m headway while attending an LED
  display at nine positions.  "A strong inverse relationship was found between
  time-to-collision (TTC) and eccentricity of the task to the normal line of sight, with TTC
  decreasing from 6 to 8 s at 0° eccentricity to 4 s at 90°", and there were "some
  differences in detection thresholds for similar eccentricities in the vertical and
  horizontal peripheries of the eye" [V abs].  The intermediate points are in the paywalled
  full text; I could not read them, so any curve between 0° and 90° is interpolation [E].
  The magnitude that matters: **eccentricity costs you at most about 3 s of detection
  margin**, and it is a smooth cost, not a cliff.
- **Morando, Gershon, Mehler & Reimer (2022), *AAP* 170:106670.**  24 drivers, real highway,
  peripheral detection task with LEDs while driving a Tesla Model S.  A Bayesian model of
  detection probability against eccentricity, speed, driving mode, cognitive load and age:
  "LED detection probability was high and stable through near-peripheral vision but it
  declined rapidly beyond 20°–30° eccentricity, showing a narrower useful field over a
  broader visual field (maximum 70°)"; reduced speed while car-following, cognitive load and
  older age degraded performance in the 20°–50° band [V abs].  **This is the single most
  useful empirical shape for a DMS**: flat to 20°, falling 20–30°, largely gone by 70°.
- **Morando et al. (2020), *AAP* 145:105853.**  83 drivers, high-fidelity simulator,
  self-paced visual-manual task at 12°, 40° and 60° horizontal eccentricity, unexpected lead
  vehicle deceleration.  "Contrary to expectations, the driver glance response time was found
  to be independent of the eccentricity angle of the secondary task.  However, the brake
  response time increased with increasing task eccentricity… High secondary task eccentricity
  was also associated with a low threat detection rate" [V abs].  Read carefully: the driver
  looks back just as fast from 60° as from 12°, but *acts* later and *misses* more.  An
  eccentricity term therefore belongs on the severity of an event, not on the moment you
  decide a glance has started.
- **Markkula et al. (2021), *AAP* 106433.**  Fitting a computational braking model to real
  SHRP2 crashes and near-crashes: "drivers have partial visual looming perception during
  off-road glances; that is, evidence for braking is collected, albeit at a slower pace,
  while the driver is looking away from the forward roadway" [V abs].  This is the mechanism
  behind Lamble's numbers and the reason a hard on/off road binary is wrong in principle
  even though it is what every standard uses.
- **Useful Field of View.**  The classical UFOV is "30° around the fovea"; later work extends
  it to 70° in diameter, and reaction times and miss rates for target detection increase with
  eccentricity [V, Kotseruba & Tsotsos review].  Wolfe, Dobres, Rosenholtz & Reimer (2017)
  argue the useful-field dichotomy understates peripheral vision and should be replaced by a
  graded account [V abs].  Wolfe et al. (2019) measured how quickly a *fixated* road scene is
  understood: hazards detected in 220 ms (ages 20–25) / 403 ms (55–69) and correctly
  responded to in 388 ms / 605 ms [V abs] — which is why a 1 s return to the road is enough
  to re-establish the scene (§7).
- **Summala, Nieminen & Punto (1996), *Human Factors* 38(3).**  Drivers kept the lane using
  peripheral vision only while performing a foveal task; novices' lane keeping broke down
  with the task at speedometer level (near periphery), experienced drivers' only when the
  task was down in the centre console [V abs].  Position, i.e. eccentricity, mattered — and
  it mattered *more for novices*.
- **Crundall, Underwood & Chapman (2002).**  No support for simple "tunnel vision" narrowing
  with load; instead a difference in the *time course* of peripheral attention between
  learners and experienced drivers [V abs].  Do not model distraction as a shrinking circle.

### 2.3 Risk against duration — where the seconds actually come from

- **100-Car (Klauer et al. 2006, DOT HS 810 594).**  Odds ratios by total eyes-off-forward-
  roadway time in the window 5 s before to 1 s after the precipitating event: ≤ 0.5 s 1.31
  (n.s.); 0.5–1.0 s 0.82; 1.0–1.5 s 0.92; 1.5–2.0 s 1.26 (n.s.); **> 2.0 s 2.19 (95 % CI
  1.72–2.78)** [V].  And the other half of the finding, which matters more for a DMS that
  must not nag: "Short, brief glances away from the forward roadway for the purpose of
  scanning the driving environment are safe and actually decrease near-crash/crash risk"
  [V abs]; driving-related glances under 2 s carried OR 0.45 [V].
- **NHTSA 2013 (78 FR 24818).**  "When drivers glance away from the forward roadway for
  greater than 2.0 seconds out of a 6-second period, their risk of an unsafe event
  substantially increases"; glances ≤ 2.0 s "have no statistically significant effect" [V].
  The acceptance criteria are the 2.0 s mean, the 15 %-over-2.0 s rule and the 12.0 s total
  [V].  Note that NHTSA's 2.0 s is a **design threshold for a device**, measured in a
  simulator during a task; it is not the point at which a warning should fire.
- **SHRP2 "Safer Glances" (Victor et al. 2015, SHRP 2 Report S2-S08A-RW-1).**  The three
  metrics with the largest predictive power were the proportion of time the eyes were off
  path in the window 3 s to 1 s before the crash / minimum-TTC, the mean off-path glance
  duration, and a composite driver-uncertainty measure, best combined in one model [V, TRID
  abstract].  The mechanism the report identifies is a "perfect mismatch" between the last
  glance duration and the lead vehicle's closing rate; the report's own recommendation,
  quoted verbatim in Bärgman's Chalmers thesis, is "Risk can most effectively be reduced by
  removing the timing mismatch of eyes off road and lead-vehicle closure rates" [S].  Search
  summaries give total-eyes-off-road odds ratios of 2.1 (CI 1.2–3.6) case-crossover and 2.0
  (CI 1.2–3.2) case-control; I could not open the report to verify them [S].  A widely
  reported corollary is that in rear-end crashes specifically, *short* glances accounted for
  most incidents [V, in Kotseruba & Tsotsos' review of the SHRP2 result] — i.e. long glances
  are dangerous, but stopping only long glances would not stop most crashes.
- **Liang, Lee & Yekhshatyan (2012), *Human Factors* 54(6).**  This is the direct answer to
  "is there a formula".  They built 24 algorithms varying in how they combine glance
  duration, glance history and **glance location**, and scored them against 100-Car crash
  risk.  "The algorithms incorporating ongoing off-road glance duration predicted crash risk
  better than did the algorithms incorporating glance history.  Augmenting glance duration
  with other elements of glance behavior — 1.5th power of duration and duration weighted by
  glance location — produced similar prediction performance as glance duration alone" [V
  abs].  **The ongoing glance's duration is the signal.  Location weighting added nothing
  measurable.**
- **Seppelt et al. (2017), *AAP* 107.**  In the 25 s before a precipitating event, drivers in
  near-crashes had significantly *longer on-road glances* and switched less between on- and
  off-road than drivers in crashes; during on-road glances the near-crash drivers "more
  frequently sample[d] peripheral regions of the roadway" [V abs].  Sampling wide *on the
  road* is protective.

### 2.4 AttenD as a de-facto piecewise formula

AttenD (Kircher & Ahlström, VTI rapport 638A, 2009) is the only widely used model that is
genuinely a function rather than a threshold: "a 2-second time buffer which is decremented
when the driver looks away from the road and incremented when the driver looks back at the
road.  If the buffer runs empty, the driver's state is classified as distracted" [S].
Glances to targets inside the "field relevant for driving" do not decrement the buffer for
their first second — the 1-second allowance is justified by typical mirror and speedometer
glance durations of 0.8–1.2 s [S].  I could not open the VTI report (diva-portal times out on
every attempt), and I could not find any angular definition of the "field relevant for
driving" in any accessible source; it is defined by target, like everything else.

The field study is verifiable: seven drivers, 4351 ± 2181 km, warnings shortened visual
time-sharing bouts from 9.94 s to 9.20 s, time from fully attentive to warning 3.20 → 3.03 s,
and time from warning to full attentiveness 6.02 → 5.46 s, with more rear-view-mirror and
fewer centre-console glances [V abs].  AttenD2.0 replaces the single buffer with several,
driven by "static requirements (e.g. the presence of an on-ramp increases the need to monitor
the sides and the mirrors) as well as dynamic requirements (e.g., reduced speed lowers the
need to monitor the speedometer)" [V abs] — still no angles.

Written as a formula, AttenD is
`b(t) = clamp(b(t−dt) + dt·(+1 if on-road else −1·[t_in_zone > a(zone)]), 0, 2 s)`,
with `a(zone)` = 1 s for mirrors and the speedometer and 0 for everything else.  That is the
entire published state of the art on continuous attention modelling, and the angle enters
only through `zone`.

### 2.5 The synthesised relation for the app [E]

Let `ε` be the 3-D angle between the gaze and the calibrated forward reference, `class` the
target class the gaze falls in, and `v` the speed.

```
if ε ≤ 22°  and the gaze is inside the windshield ellipse:   forward road view — no timer
else:
    T_limit = T_class(class) · k_v(v)                       # the standards' number
    severity(t) = (t / T_limit) · w(ε)                      # angle enters only here
    w(ε) = 1.0                       for ε ≤ 20°
         = 1.0 + 0.025·(ε − 20°)     for 20° < ε ≤ 60°      # 1.0 → 2.0
         = 2.0                       for ε > 60°
```

with `T_class` = 4.0 s for driving-task targets (mirrors, cluster), of which the first 1.0 s
is not counted; 3.0 s for cabin / non-driving targets; 4.0 s for outside-world lateral gaze
when `v ≥ 30 km/h`, 12 s otherwise; and `k_v(v)` = 1.0 at `v ≥ 50 km/h`, 1.7 at
`20 ≤ v < 50 km/h` (the ADDW 6 s ÷ 3.5 s ratio [V]), warnings off below 20 km/h (Euro NCAP
[V]).

`w(ε)` is shaped on Morando et al. 2022 (flat to 20°, degrading 20–50°, gone by ~70°) and
scaled so that the worst case doubles the severity, matching Lamble's ~3 s of lost detection
margin against a ~3 s base limit.  **I deliberately do not let `w(ε)` shorten `T_limit`.**
Shortening it would put the app below every published warning point (3.0–3.5 s) and, on our
own measurements, below the 99th percentile of a normal mirror glance.  Use `w(ε)` to pick
the escalation rate, the voice-vs-display decision and the exposure score, exactly as the
existing `exposure weights` row in `THRESHOLDS.md` already does.

If you want a single number to quote to a user — "how long can I look 25° to the side?" — the
honest answer is **3–4 s, the same as at 45°, because the standards do not resolve angle, and
the extra ~1 s of detection margin you lose between 25° and 45° is inside the noise of every
published risk estimate**.

---

## 3. Mirrors and the instrument cluster

Three independent sources say mirror and gauge glances are a different category, not a
shorter timer:

- **NHTSA 2013, Table 3** lists "Looking at inside and outside rearview mirrors" and
  "Checking the speedometer, fuel gauge, engine temperature gauge and any other gauges or
  digital displays presenting information that is necessary for the safe operation of the
  vehicle" under **"Guidelines applicable? — No"** [V].  The 2 s / 12 s criteria formally do
  not apply to them.
- **Euro NCAP** splits long distraction into non-driving (3 points) and driving-task (2
  points) and puts the rear-view mirror, both door mirrors and the instrument cluster in the
  driving-task list — but the **3–4 s window applies to both** [V].  A 5 s stare at the left
  mirror is still a long distraction.
- **100-Car**: driving-related glances shorter than 2 s carried OR 0.45, i.e. *protective*
  [V].

**Typical durations.**  Taoka (1990), reproduced in Green's UMTRI report and the best
statistical summary I could reach: mean glance duration / SD, log-normal — left mirror
**1.10 / 0.30 s**, right mirror **0.75 / 0.36 s**, speedometer **0.62 / 0.48 s**, radio
**1.44 / 0.50 s**, road-name sign 1.63 / 0.80 s [V].  Rockwell (1988), same report: analog
speedometer 0.4–0.7 s in normal driving, 0.8 s for a check reading, 1.2 s to read an exact
value; left outside mirror 0.5–1.0 s; inside mirror 0.5–0.7 s; mirror glances that require
discrimination ("specify the adjacent car's colour") mean 1.27 s versus 1.10 s for a plain
traffic check [V].  Fitting Taoka's own log-normal parameters gives 95th / 99th percentiles
of 1.65 / 1.98 s (left mirror), 1.43 / 1.95 s (right mirror) and 1.51 / 2.41 s (speedometer)
[E — my arithmetic, validated against the report's own worked example, which gives 2.35 s for
the 95th-percentile radio glance against my 2.37 s].

**Recommendation**: a 1.0 s free allowance and a 4.0 s limit for mirror and cluster zones.
The allowance covers the mean and the 4.0 s limit sits above the 99th percentile by a factor
of two, so a genuine mirror check can never fire the rule.

**The overtaking paradox.**  A 2024 simulator study of a Euro-NCAP-style algorithm found that
"in 50 % of the overtaking maneuvers driving-related distraction was recorded" and that "side
mirror glances, prior to overtaking, paradoxically prompted warnings", with drivers unable to
understand why [V abs].  This is the dominant false-alarm mode for a mirror-blind DMS.  Two
mitigations, both cheap on a phone: (a) never voice an alert on a *mirror-class* glance below
4 s even when several occur in a row, and (b) suppress the lateral rule when the turn
indicator is on, if the app can see it, or when the head yaw is oscillating between the
mirror zone and the road at ≥ 2 crossings in 4 s [E].

---

## 4. Vertical (pitch) glances

**The 30°-down plane is the one real regulatory angle.**  ADDW Area 3 is "any area below a
plane, 30° downward from the driver's ocular reference point", excluding Areas 1 and 2 — the
lap, the centre console, the footwells [V].  It is the only area that starts the distraction
timer, and the timers are 3.5 s at ≥ 50 km/h and 6 s at 20–50 km/h, with up to 1.5 s more
allowed in non-nominal situations [V].  Euro NCAP's control-placement cone ends at the same
place: a plane "angled 30° downward from the ocular reference point" [V].

**NHTSA independently puts a ceiling in the same place, from the other side.**  A device's
display "should be mounted in a position where the downward viewing angle, measured at the
geometric center of each active display area, is less than at least one of" the 2-D Maximum
Downward Angle — **30.00°** for a nominal driver eye point ≤ 1700 mm above the ground, and
`θ = 0.01303·h_eye + 15.07` above that — or the 3-D Maximum Downward Angle, **28.16°** for an
eye point ≤ 1146.2 mm, and `θ = 57.2958·atan[0.829722·tan(0.263021 + 0.000227416·h_eye)]`
above that [V].  So: **every legally-placed in-car display is above −30°, and nothing a
driver is supposed to look at is below it.**  A sustained gaze below −30° is, with very few
exceptions, a hand-held device, the lap, or the floor.

**What the cluster and centre display actually occupy.**  On the geometry of §1.1, the
cluster centre is at −25° and the centre stack at −20° (with a 3-D downward angle of 19.8°,
comfortably inside NHTSA's 28.16°).  So the whole band **−12° to −30° is legitimate
driving-related territory** and should carry the 4 s driving-task limit, not the 3 s cabin
limit.

**The phone problem, and a gap in the current thresholds.**  Euro NCAP's *basic* phone-use
targets are the driver's knee (outboard and inboard), the lap, a dashboard mount, the OEM
charge port and the phone held at the centre of the wheel below the cluster; its *advanced*
(Lizard-only) targets are a dashboard mount, the phone held at 9–11 or 13–15 o'clock on the
wheel, the phone held inside the windscreen field of view and the phone held in the cluster
view [V].  On the §1.1 geometry the lap phone is at −50° and the knee at −60° — well inside
Area 3 — but **a phone at the top of the wheel is only −24° and a dash-mounted phone only
−13°**.  A `hard_down_deg` of −30° therefore catches the lap and knee cases and **misses
every one of Euro NCAP's "advanced" phone positions**.  Those have to be caught by the
*pattern* (repeated 0.6–2 s dwells in the cluster/stack band with no steering or speed
correlate), not by the angle.  This is the clearest actionable gap I found against
`THRESHOLDS.md`.

**Upward.**  There is no standard and no study.  ADDW's Area 1 includes the roof [V], which
makes any sustained upward gaze non-road by definition; my geometry puts a lowered sun visor
at +32° and the overhead console at +49°.  But an overhead traffic light 8 m ahead is at
**+18°** [E], so the band 10–20° up must stay unalerted at low speed and at intersections.
The existing `look_up_deg` of 20° (head pitch) is well placed for that reason.

**One caveat that is specific to our sensor, and it is severe.**  The deployed pipeline reads
*relative* gaze pitch at a gain of about 0.10 — a true 11° downward glance reads as 0.3°
(`DESIGN.md` §5, measured).  Every vertical rule in this document is therefore, in our
system, a **head-pitch** rule, not a gaze rule.  The angles above are still the right targets
for the *policy*; they are simply not observable from the gaze vector on this camera.

---

## 5. "100 % off-road" bounds

The angular limits beyond which a gaze cannot plausibly be the road, with justification:

| bound | what is beyond it | source |
|---|---|---|
| **pitch < −30°** | ADDW Area 3: lap, console, footwell, hand-held phone.  Below every NHTSA-compliant display (2-D max 30.00°, 3-D max 28.16°).  Below the bonnet edge (~−22° [E]). | ADDW [V]; NHTSA [V]; geometry [E] |
| **pitch > +30°** | headliner, roof, sunroof, overhead console — **ADDW Area 1 explicitly includes the roof**.  Above the windshield header for a normal seating position. | ADDW [V] |
| **\|yaw\| > 55°** | ADDW Area 1 (outside two vertical planes at ±55° about the ocular reference point).  Formally not the forward road. | ADDW [V] |
| **yaw beyond ~−63°, driver side** | the driver's side glass; the road visible through it is behind the A-pillar.  The window plane itself is at ≈ −80°. | geometry [E]; Euro NCAP "driver side window" is a non-driving Owl target [V] |
| **yaw beyond ~+70°, passenger side** | the passenger's face (≈ +82°), the passenger seat, the rear cabin. | geometry [E]; Euro NCAP "passenger face", "rear passenger (body lean)" [V] |

**Recommended hard limits** for this app, and the one change I would make:

- `hard_down_deg = −30°` — **keep**.  It is the single best-sourced angle in the whole
  document (ADDW and NHTSA agree from opposite directions).
- `hard_up_deg = +30°` — **keep**.  ADDW Area 1 includes the roof.
- `hard_lateral_deg` — **make it asymmetric**.  A symmetric ±60° is not symmetric in target
  terms in a left-hand-drive car: the driver's door mirror sits at about −39° and the
  *passenger's* door mirror at about **+46°**, with the glovebox at +53°.  Suggested [E]:
  **−65°** on the driver side (beyond the side glass edge) and **+75°** on the passenger side
  (beyond the passenger mirror and the glovebox, short of the passenger's face).  Mirror the
  values for RHD.  The current symmetric 60° will classify a legitimate right-mirror check at
  60–70° as a cabin glance with a 3 s limit; since the 99th-percentile right-mirror glance is
  ~1.95 s [E] this will rarely fire, but it is the wrong class and it will show in the logs.

Note what a hard limit is *for*: it lets the far-off rules run before the forward reference is
confirmed, and it bounds the damage from a bad reference.  It is not a claim that 61° is
dangerous and 59° is safe.

---

## 6. Speed dependence

| speed | what the standards do | source |
|---|---|---|
| stationary / < 10 km/h | nothing.  Euro NCAP allows "a total of 1 minute of driving at forward speed of at least 10 km/h" before the system must be measuring at all. | [V] |
| ≥ 20 km/h | Euro NCAP requires distraction, microsleep, sleep and unresponsive states to warn/intervene.  ADDW's low-speed band starts here: Area 3 for **6 s** triggers a warning at 20–50 km/h. | [V] |
| ≥ 50 km/h | ADDW tightens to **3.5 s** in Area 3.  Euro NCAP's impairment states become functional, with "a learning period at a speed of at least 50 km/h of up to 10 minutes". | [V] |
| > 70 km/h | DDAW (Reg. (EU) 2021/1341) drowsiness warning is active only above 70 km/h. | [V] |

The 6 s ÷ 3.5 s ratio, **1.7**, is the only speed scaling any regulator has published, and it
is what `k_v(v)` in §2.5 uses.  A useful sanity check in metres: a 3.5 s glance is 48.6 m at
50 km/h and 97.2 m at 100 km/h; a 6 s glance is 83.3 m at 50 km/h [E].

**Intersections, turns and parking.**  Side looks are not only normal here, they are the
task.  FHWA's SHRP2 analysis of rural high-speed intersection approaches: between 492 ft and
98 ft out, drivers spend almost nothing on the sides (far left 0.24 s, near left 0.19 s, near
right 0.30 s, far right 0.08 s in total), but **inside the last 98 ft the far left takes
2.40 s and the far right 1.82 s**, with 86.5 % of all scanning happening in those last 98 ft;
forward glances are 56.3 % of total glance time overall but 83 % of it if you exclude the
last 197 ft [V].  A single 2.4 s glance 60–80° to the left at an intersection is textbook
behaviour, and a 3 s cabin limit applied to it would be a false alarm roughly every junction.

Naturalistic driving also shows that drivers *self-regulate*: Tivesten & Dozza (2014) found
drivers "spend more time looking at the road and have a lower proportion of long off-road
glances in complex driving contexts such as when turning and when lead or oncoming vehicles
are present", and — importantly for a speed-gated rule — "driving speed influenced off-road
glance durations during the phone tasks, but not during normal driving" [V abs].  So speed
gating mostly buys you protection against *task* glances, which is exactly what you want.

**Practical recommendation** [E]: with no speed signal, run the lateral rule at 12 s (the
NHTSA whole-task budget) and require head support; with a speed signal, 4 s above 30 km/h.
If the app ever gets GPS-derived heading rate or map context, suppress the lateral rule
entirely while |heading rate| > 5 °/s or within 50 m of a junction.

---

## 7. False alarms on a phone-mounted camera

**What the standards allow you to do about nuisance.**

- **No reset on flicker.**  ADDW §3.3.2.4: the Area-3 timer "shall not be reset due to
  possible image processing artefact or a short change of gaze direction 'in, out and back
  in' of the area 3", with the tolerance left to the manufacturer [V].  Our 0.3 s
  `glance_gap_tolerance_s` implements exactly this.
- **One second of road ends it.**  Euro NCAP terminates an intervention "1 s after continuous
  gaze towards forward road view" (2 s after the end of a transient state) [V].  Wolfe et
  al.'s 220–403 ms detection and 388–605 ms response times say 1 s is genuinely enough to
  re-acquire the scene [V abs].
- **Acknowledgement suppression.**  Euro NCAP: "a warning suppression strategy may be
  implemented for all transient states upon driver acknowledgment of the first instance of a
  warning… reinstated at the start of a new journey" [V].
- **Settle before you judge.**  ADDW spot checks require the system to have judged the driver
  "not distracted for at least 60 seconds" before the clock starts [V]; Euro NCAP allows 1
  minute at ≥ 10 km/h before measurement must begin [V].
- **Base rate.**  Euro-NCAP-defined long distraction occurs about once per 1.1 h of
  naturalistic driving and VATS about once per 4.8 h [S].  An alert rate materially above
  ~1/h in ordinary driving is almost certainly false.

**What our own sensor forces on top of that.**

1. **The forward region must absorb the estimator's error.**  The gaze model's mean absolute
   angular error on Look Both Ways is 6.26° in research configuration and 6.4–6.7° in the
   deployed single-pass configuration [measured, project].  A 6–10° road-centre AOI — the
   radius used throughout the literature [V] — is *the same size as the error*.  That is why
   the shipped forward view is a 22° × 14° ellipse and not a road-centre circle, and the
   measurement behind it is decisive: with a 15° × 10° "road" the rules voiced 63 alerts/h on
   attentive LBW drivers, 38.6/h of them with the true gaze inside the windshield
   [measured, project].  **Do not shrink the forward ellipse toward the literature's
   road-centre radius.**  The literature's radius is for *measuring* percent-road-centre with
   a lab eye tracker, not for *deciding* with a 6.4° estimator.
2. **Yaw reads at gain ~0.74 and pitch at ~0.10** [measured, project].  A true 20° glance
   reads as 15°; a true 11° downward glance reads as 0.3°.  Any angle threshold in this
   document has to be divided by the gain before it becomes a config value, or the pitch
   rules have to come from the head, which is what `LOOK_DOWN` / `LOOK_UP` already do.
3. **Require the head for eccentric glances.**  A sustained look beyond ~30° is carried by
   the head; the comfortable eye-in-head range is far smaller than the gaze range.  Our own
   measurement agrees: every true LBW side look averaged ≥ 24° of head deviation, while
   reference-error "glances" averaged 3.3–8.4°, and a 10° head-deviation gate removed every
   head-at-rest false alarm without losing a true side look [measured, project].  Keep
   `lateral_head_min_deg`.
4. **Mirror scanning and overtaking** — §3.  **Turning and parking** — §6.  **Passenger
   conversation**: a passenger's face is at ~+82° [E] and Euro NCAP treats a long look at it
   as a genuine non-driving distraction [V], so the right behaviour is not to suppress it but
   to keep the 3 s limit and never escalate below 3 s.
5. **Recommended debounce set** (all sourced or measured above): 0.3 s in-out-in tolerance;
   0.4 s to open a glance; 1.0 s of continuous forward gaze to close it; 2 s stream-gap
   restart; 30 s acknowledgement suppression; alert rate budget ≤ 1/h in attentive driving.

---

## 8. References

Primary standards and regulations
- Euro NCAP, *Assessment Protocol — Safe Driving, Driver Engagement*, v1.1, Oct 2025 — [V] https://cdn.euroncap.com/cars/assets/euro_ncap_protocol_safe_driving_driver_engagement_v11_a30e874152.pdf
- Euro NCAP, *SD 202 Driver Monitoring Test Procedure*, v1.1 — [V] https://cdn.euroncap.com/cars/assets/sd_202_driver_monitoring_test_procedure_v11_58ce3b3a54.pdf
- Commission Delegated Regulation (EU) 2023/2590 (ADDW) — [V] https://eur-lex.europa.eu/legal-content/en/TXT/PDF/?uri=OJ%3AL_202302590 (verified 2026-09-12; EUR-Lex refused automated fetches on 2026-09-18)
- Commission Delegated Regulation (EU) 2021/1341 (DDAW) — [V] https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32021R1341
- NHTSA, *Visual-Manual Driver Distraction Guidelines for In-Vehicle Electronic Devices*, 78 FR 24818, 26 Apr 2013 — [V] https://www.govinfo.gov/content/pkg/FR-2013-04-26/pdf/2013-09883.pdf (Table 3 exemptions, and the 2-D / 3-D Maximum Downward Angle definitions, verified directly on 2026-09-18)

Naturalistic crash-risk studies
- Klauer et al., *The Impact of Driver Inattention on Near-Crash/Crash Risk: 100-Car NDS*, DOT HS 810 594, 2006 — [V] https://rosap.ntl.bts.gov/view/dot/62931/dot_62931_DS1.pdf ; abstract also [V abs] https://doi.org/10.1037/e729262011-001
- Victor et al., *Analysis of Naturalistic Driving Study Data: Safer Glances, Driver Inattention, and Crash Risk*, SHRP 2 Report S2-S08A-RW-1, 2015 — [V abs] https://trid.trb.org/View/1323585 ; report page https://nap.nationalacademies.org/catalog/22297 (full text not machine-readable); odds ratios 2.1 / 2.0 [S] from search summaries
- Bärgman, *Methods for Analysis of Naturalistic Driving Data in Driver Behavior Research*, Chalmers, 2016 — [V] https://publications.lib.chalmers.se/records/fulltext/244575/244575.pdf (source of the verbatim Victor et al. 2015 p. 106 quotation, therefore [S] for the original)
- Liang, Lee & Yekhshatyan, "How Dangerous Is Looking Away From the Road?", *Human Factors* 54(6), 2012 — [V abs] https://doi.org/10.1177/0018720812446965
- Seppelt et al., "Glass half-full: On-road glance metrics differentiate crashes from near-crashes in the 100-Car data", *AAP* 107, 2017 — [V abs] https://doi.org/10.1016/j.aap.2017.07.021
- Tivesten & Dozza, "Driving context and visual-manual phone tasks influence glance behavior in naturalistic driving", *TRF* 26, 2014 — [V abs] https://doi.org/10.1016/j.trf.2014.08.004
- FHWA, *Leveraging SHRP2 NDS: Examining Driver Behavior When Entering Rural High-Speed Intersections*, FHWA-HRT-17-016, 2017 — [V] https://www.fhwa.dot.gov/publications/research/safety/17016/004.cfm

Eccentricity and peripheral vision
- Lamble, Laakso & Summala, "Detection thresholds in car following situations and peripheral vision", *Ergonomics* 42(6), 1999 — [V abs] https://doi.org/10.1080/001401399185306
- Summala, Nieminen & Punto, "Maintaining Lane Position with Peripheral Vision during In-Vehicle Tasks", *Human Factors* 38(3), 1996 — [V abs] https://doi.org/10.1518/001872096778701944
- Morando et al., "Detection and response to critical lead vehicle deceleration events with peripheral vision: Glance response times are independent of visual eccentricity", *AAP* 145, 2020 — [V abs] https://doi.org/10.1016/j.aap.2020.105853
- Morando, Gershon, Mehler & Reimer, "Beyond gaze fixation: Modeling peripheral vision…", *AAP* 170, 2022 — [V abs] https://pubmed.ncbi.nlm.nih.gov/35429654/
- Markkula et al., "Computational modeling of driver pre-crash brake response, with and without off-road glances", *AAP* 163, 2021 — [V abs] https://doi.org/10.1016/j.aap.2021.106433
- Wolfe, Dobres, Rosenholtz & Reimer, "More than the Useful Field: Considering peripheral vision in driving", *Applied Ergonomics* 65, 2017 — [V abs] https://doi.org/10.1016/j.apergo.2017.07.009
- Wolfe et al., "Rapid holistic perception and evasion of road hazards", *JEP: General*, 2019 — [V abs] https://doi.org/10.1037/xge0000665
- Crundall, Underwood & Chapman, "Attending to the peripheral world while driving", *Applied Cognitive Psychology* 16, 2002 — [V abs] https://doi.org/10.1002/acp.806 ; and "Driving Experience and the Functional Field of View", *Perception* 28(9), 1999 — [S] https://doi.org/10.1068/p281075 (abstract not retrievable)
- Kotseruba & Tsotsos, *Behavioral Research and Practical Models of Drivers' Attention*, arXiv:2104.05677 — [V] https://arxiv.org/abs/2104.05677 (UFOV 30° / extended 70°; road-centre radii 6°, 8°, 10°; the 2 s / 12 s rule; the SHRP2 "shorter glances" result)

Algorithms and products
- Kircher & Ahlström, *Issues related to the driver distraction detection algorithm AttenD*, VTI rapport 638A, 2009 — [S] (diva-portal.org timed out on every attempt on 2026-09-18) https://www.diva-portal.org/smash/get/diva2:675373/FULLTEXT02.pdf
- Ahlström, Kircher & Kircher, "A Gaze-Based Driver Distraction Warning System and Its Effect on Visual Behavior", *IEEE TITS* 14(2), 2013 — [V abs] https://doi.org/10.1109/TITS.2013.2247759
- Ahlström, Georgoulas & Kircher, "Towards a Context-Dependent Multi-Buffer Driver Distraction Detection Algorithm" (AttenD2.0), *IEEE TITS*, 2021 — [V abs] https://doi.org/10.1109/TITS.2021.3060168
- Kircher & Ahlström, "Minimum Required Attention: A Human-Centered Approach to Driver Inattention", *Human Factors* 59(3), 2017 — [V abs] https://doi.org/10.1177/0018720816672756
- "The Paradox of Driving-Related Distraction: Driver Monitoring Systems Trigger Warnings During Overtaking Maneuvers", AutomotiveUI '24 — [V abs] https://doi.org/10.1145/3641308.3685049
- Victor et al., Volvo road-centre patent US 7,460,940 B2 — [V] https://patents.google.com/patent/US7460940B2/en (8° road-centre radius, 20°×40° oval, 4 s long-glance warning, PRC > 92 %)
- Seeing Machines, "Prevalence of Euro NCAP-defined distraction in naturalistic driving" — [S] https://seeingmachines.com/prevalence-of-euro-ncap-defined-distraction-in-naturalistic-driving/

Glance-duration norms and gaze-zone geometry
- Green, *Visual and Task Demands of Driver Information Systems*, UMTRI-98-16, 1999 — [V] https://deepblue.lib.umich.edu/handle/2027.42/1269 (reproduces Taoka 1990 Table 31 and Rockwell 1988 Table 27)
- Taoka, "Duration of drivers' glances at mirrors and displays", *ITE Journal* 60(10), 1990 — [S] https://trid.trb.org/view/348664 (numbers read via Green 1999)
- IVGaze, arXiv:2403.15664 — [V] https://arxiv.org/html/2403.15664 (nine zones; horizontal −50° to 90°, vertical −40° to 40°)

Project measurements (this repo, not literature)
- `deployment-stack/docs/THRESHOLDS.md`, `deployment-stack/docs/DESIGN.md` §5 and §12 —
  forward-ellipse sizing, the 63.2 → 0.13 alerts/h rework, the 0.74 yaw / 0.10 pitch relative
  gains, the 10° head-deviation gate.
- `gaze-direct` §44/§46 — 6.2649° and 6.26° LBW mean absolute angular error (research),
  6.42–6.65° deployed single-pass.
