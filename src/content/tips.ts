// Coaching tip library (§7.D D6) and the selection rule behind the trip summary's one tip card.
//
// The score explains, the tip coaches (§9.10): every line here describes the behaviour and the
// fix, never the person. Copy targets a US driver aged 16-25 at roughly a grade 6-8 reading
// level, makes no medical or legal claim, and never cites an effect size — each tip paraphrases
// recognised driver-education guidance, named in the comment above it and in its `source` field.
//
// This module is pure data plus two deterministic pickers: no React, no network, no I/O. The
// strings live here rather than in `src/i18n/en.ts` because a tip is a record of eight related
// fields keyed by category, severity and stage, not a flat UI string; a translation pass would
// swap this catalogue for a localised one.
import { CATEGORY, severity } from '@scoring';
import type { EventCategory, ScorableEvent, ScoredTrip } from '@scoring';

/**
 * Where the driver is in their first miles. `new` is a driver still inside the learning period
 * (fewer than `CONSTANTS.LEARNING_PERIOD_TRIPS` scored trips); `experienced` is at or past it.
 * The distinction is about habits, not skill: a new driver is told the mechanism, an experienced
 * one is given the situation where the habit actually shows up.
 */
export type TipStage = 'new' | 'experienced';

export const TIP_STAGES: readonly TipStage[] = ['new', 'experienced'];

/** Tips that are not tied to one scoring category carry `general` — the Home card's fallbacks. */
export type TipCategory = EventCategory | 'general';

export interface Tip {
  /** Stable id: `<category>-<band>-<stage>`. Referenced by weekly focus (§10.4), so it never changes. */
  id: string;
  category: TipCategory;
  /**
   * Lowest event severity `s` (§9.3, `severity()` in `@scoring`) this tip speaks to. `0` means it
   * applies anywhere in the category; `HIGH_SEVERITY[category]` means it speaks to the top bands.
   */
  minSeverity: number;
  /** Stages this tip reads correctly for. Listed once for both where the copy does not change. */
  stages: readonly TipStage[];
  title: string;
  /** 2-3 sentences: what to do and how. */
  body: string;
  /** One sentence on why it matters. */
  why: string;
  /** The "Practice this week" action (§7.D D6, §10.4). */
  practice: string;
  /** The driver-education guidance this tip paraphrases; repeated in the comment above the tip. */
  source: string;
}

/**
 * The severity `s` at which a category's events enter its top bands (§9.3). Each value is the
 * lower edge of the second-highest band, so both of a category's worst outcomes reach the
 * high-severity tip: phone handling at 10 mph and above, 15 mph or 40 % over the limit, braking
 * past 0.40 g, acceleration past 0.38 g, cornering past 0.45 g, and a glance of 3 s or longer
 * (a drowsiness episode scores 2 and lands here too).
 */
export const HIGH_SEVERITY: Record<EventCategory, number> = {
  phone: 0.7,
  speeding: 3.5,
  braking: 1.75,
  accel: 1.75,
  cornering: 1.75,
  focus: 2,
};

const NEW: readonly TipStage[] = ['new'];
const EXPERIENCED: readonly TipStage[] = ['experienced'];
const BOTH: readonly TipStage[] = TIP_STAGES;

/**
 * The category tip library: four per category, one for each (severity band × stage) pair. The
 * order below is the tie-break order — the first matching tip wins — so it is meaningful.
 */
export const tips: readonly Tip[] = [
  // --- Phone use (cap 30) ------------------------------------------------------------------
  // Source: NHTSA distracted-driving guidance for young drivers, and the California DMV Driver
  // Handbook, both of which tell a driver to finish every phone task before the car moves.
  {
    id: 'phone-low-new',
    category: 'phone',
    minSeverity: 0,
    stages: NEW,
    title: 'Set it before you roll',
    body: 'Pick your music, start navigation and send your last message while the car is still parked. Then put the phone in its mount and leave it there until you are parked again. A drive that starts settled stays settled.',
    why: 'Every touch while the car is moving takes your eyes and your attention off the road.',
    practice: 'This week, do all your phone setup before you shift out of park.',
    source: 'NHTSA distracted-driving guidance; California DMV Driver Handbook',
  },
  // Source: UK Highway Code rule 149 (a driver must stay in proper control and not use a
  // hand-held phone) and NHTSA distracted-driving guidance.
  {
    id: 'phone-low-experienced',
    category: 'phone',
    minSeverity: 0,
    stages: EXPERIENCED,
    title: 'Let the phone wait at the light',
    body: 'A red light feels like a free moment, but the pickup often lasts past the green. Leave the phone alone from the moment you start the engine, so there is no habit to break when traffic moves again. If something truly cannot wait, park first.',
    why: 'Picking the phone up at a stop is where handling it on the move usually begins.',
    practice: 'This week, keep your hands off the phone at every red light.',
    source: 'UK Highway Code rule 149; NHTSA distracted-driving guidance',
  },
  // Source: UK Highway Code rule 149 and IIHS guidance for teen drivers, which both put the
  // remedy at "stop somewhere safe first" rather than "be quick about it".
  {
    id: 'phone-high-new',
    category: 'phone',
    minSeverity: HIGH_SEVERITY.phone,
    stages: NEW,
    title: 'Park before you reply',
    body: 'If a message cannot wait, find a safe place to stop and put the car in park before you look. Pulling into a space takes a minute and gives the message your full attention. A message read at a stop is the same message.',
    why: 'Handling a phone in moving traffic means steering and looking at two things at once.',
    practice: 'This week, pull over once instead of replying on the move.',
    source: 'UK Highway Code rule 149; IIHS guidance for teen drivers',
  },
  // Source: NHTSA distracted-driving guidance and AAA Foundation for Traffic Safety
  // driver-education materials, which recommend putting the phone out of reach before setting off.
  {
    id: 'phone-high-experienced',
    category: 'phone',
    minSeverity: HIGH_SEVERITY.phone,
    stages: EXPERIENCED,
    title: 'Make the phone hard to reach',
    body: 'Put the phone in its mount or in a bag on the back seat before you drive, so reaching for it is awkward. Turn on your driving focus mode and let messages wait quietly. A habit you cannot act on fades on its own.',
    why: 'Phone use carries the largest deduction in RoadWise, because it takes your hands and your eyes at once.',
    practice: 'This week, start every drive with driving focus mode on.',
    source: 'NHTSA distracted-driving guidance; AAA Foundation for Traffic Safety',
  },

  // --- Speeding (cap 25) -------------------------------------------------------------------
  // Source: UK Highway Code rule 125 (the limit is an absolute maximum, not a target) and the
  // California DMV Driver Handbook on checking the posted limit on every new road.
  {
    id: 'speeding-low-new',
    category: 'speeding',
    minSeverity: 0,
    stages: NEW,
    title: 'Read the limit, then set it',
    body: 'Check the posted limit each time you turn onto a new road, and settle a little under it. On a long stretch, cruise control holds the number so your speed does not drift up. Speed creep is easier to prevent than to correct.',
    why: 'The posted limit is the maximum for good conditions, not a target.',
    practice: 'This week, say the speed limit out loud after every turn.',
    source: 'UK Highway Code rule 125; California DMV Driver Handbook',
  },
  // Source: UK Highway Code rule 125 and the New York State Driver's Manual on holding a steady
  // speed and a steady gap rather than matching surrounding traffic.
  {
    id: 'speeding-low-experienced',
    category: 'speeding',
    minSeverity: 0,
    stages: EXPERIENCED,
    title: 'Let the gap set your speed',
    body: 'When traffic pulls you along, pick the car ahead and hold a steady gap instead of matching the pack. Glance at the speedometer at every landmark, such as a light or a sign. Small drifts are easy to trim before they turn into episodes.',
    why: 'Moving with traffic still counts against the posted limit, and the limit is what RoadWise measures.',
    practice: 'This week, check your speedometer at every traffic light.',
    source: "UK Highway Code rule 125; New York State Driver's Manual",
  },
  // Source: UK Highway Code rule 126 (stopping distances grow with speed) and NHTSA teen-driving
  // guidance on planning enough time for the trip.
  {
    id: 'speeding-high-new',
    category: 'speeding',
    minSeverity: HIGH_SEVERITY.speeding,
    stages: NEW,
    title: 'Leave five minutes earlier',
    body: 'Fifteen miles per hour over saves less time than it feels like, and it shortens how long you have to react. Leaving a few minutes earlier takes away the reason to push. Plan the trip around the limit, not around the clock.',
    why: 'The faster you go, the longer the car needs to stop and the less time you have to see what is ahead.',
    practice: 'This week, set your alarm five minutes earlier on school or work mornings.',
    source: 'UK Highway Code rule 126; NHTSA teen-driving guidance',
  },
  // Source: California DMV Driver Handbook on speed management downhill and on ramps, with UK
  // Highway Code rule 125 on the limit applying everywhere.
  {
    id: 'speeding-high-experienced',
    category: 'speeding',
    minSeverity: HIGH_SEVERITY.speeding,
    stages: EXPERIENCED,
    title: 'Ease off before the ramp',
    body: 'Highway exits, downhill stretches and wide empty roads are where the big overages build without feeling fast. Start easing off before the gradient or the ramp, not partway down it. Let the speedometer, not the feel of the road, tell you how fast you are going.',
    why: 'Speed that feels normal on an open road is often well over the posted limit.',
    practice: 'This week, lift off early on the two roads where your speed usually climbs.',
    source: 'California DMV Driver Handbook; UK Highway Code rule 125',
  },

  // --- Hard braking (cap 12) ---------------------------------------------------------------
  // Source: UK Highway Code rule 126 (leave a two-second gap, more in the wet) and the
  // California DMV Driver Handbook, which teaches the same count with a larger margin.
  {
    id: 'braking-low-new',
    category: 'braking',
    minSeverity: 0,
    stages: NEW,
    title: 'Leave a three-second gap',
    body: 'Pick a fixed object ahead, such as a sign, and count three seconds between the car in front passing it and you passing it. Add a second in rain or at night. The gap is what turns a hard stop into a gentle one.',
    why: 'A short following gap is what turns an ordinary slowdown into a heavy stop.',
    practice: 'This week, count your gap out loud once on every drive.',
    source: 'UK Highway Code rule 126; California DMV Driver Handbook',
  },
  // Source: New York State Driver's Manual and AAA Foundation for Traffic Safety
  // driver-education materials on looking well beyond the vehicle directly ahead.
  {
    id: 'braking-low-experienced',
    category: 'braking',
    minSeverity: 0,
    stages: EXPERIENCED,
    title: 'Look further down the road',
    body: 'Lift your eyes past the car in front to the traffic two or three vehicles ahead. Brake lights further up give you several seconds of warning. Early information turns into light braking instead of heavy braking.',
    why: 'You can only brake as smoothly as you can see far.',
    practice: 'This week, name what is happening two cars ahead at every light.',
    source: "New York State Driver's Manual; AAA Foundation for Traffic Safety",
  },
  // Source: California DMV Driver Handbook on space management and covering the brake, with UK
  // Highway Code rule 126 on stopping distances.
  {
    id: 'braking-high-new',
    category: 'braking',
    minSeverity: HIGH_SEVERITY.braking,
    stages: NEW,
    title: 'Cover the brake on approach',
    body: 'Coming up to a light, a crosswalk or a line of stopped traffic, lift off the gas early and rest your foot over the brake. The car sheds speed before you press anything. What is left is a light squeeze instead of a stomp.',
    why: 'A heavy stop usually means the slowdown started later than it needed to.',
    practice: 'This week, lift off the gas one block before every red light.',
    source: 'California DMV Driver Handbook; UK Highway Code rule 126',
  },
  // Source: New York State Driver's Manual on approaching intersections with a decision already
  // made, and UK Highway Code rule 126 on stopping within the distance you can see to be clear.
  {
    id: 'braking-high-experienced',
    category: 'braking',
    minSeverity: HIGH_SEVERITY.braking,
    stages: EXPERIENCED,
    title: 'Decide early at every light',
    body: 'As you come up to a light, decide while you still have room whether you expect to stop. Take your foot off the gas as soon as you think you will, rather than waiting to be sure. Late decisions are where the heaviest braking comes from.',
    why: 'Hard braking at intersections is usually a late decision rather than a surprise.',
    practice: 'This week, choose stop or go a block before each light.',
    source: "New York State Driver's Manual; UK Highway Code rule 126",
  },

  // --- Rapid acceleration (cap 8) ----------------------------------------------------------
  // Source: California DMV Driver Handbook on smooth vehicle control, with AAA Foundation for
  // Traffic Safety driver-education materials on progressive throttle.
  {
    id: 'accel-low-new',
    category: 'accel',
    minSeverity: 0,
    stages: NEW,
    title: 'Roll onto the gas',
    body: 'Press the pedal as if you were sliding a full cup across the dashboard without spilling it. Build speed over a few seconds instead of in one push. The car reaches the same speed, just more smoothly.',
    why: 'Smooth starts keep the car settled and leave more grip for steering.',
    practice: 'This week, count to three as you pull away from each stop.',
    source: 'California DMV Driver Handbook; AAA Foundation for Traffic Safety',
  },
  // Source: UK Highway Code guidance on driving economically and reading the road ahead, with
  // AAA Foundation for Traffic Safety driver-education materials.
  {
    id: 'accel-low-experienced',
    category: 'accel',
    minSeverity: 0,
    stages: EXPERIENCED,
    title: 'Stop racing to the next light',
    body: 'On a street with signals, a hard launch usually ends at the next red anyway. Ease away and let the timing do the work. You arrive at the same moment with less fuel used and a calmer car.',
    why: 'Quick starts between lights rarely change when you get there.',
    practice: 'This week, pull away gently at one light per drive and see where you end up.',
    source: 'UK Highway Code guidance on driving economically; AAA Foundation for Traffic Safety',
  },
  // Source: California DMV Driver Handbook and New York State Driver's Manual on choosing a gap
  // early and matching traffic speed along the ramp rather than at the end of it.
  {
    id: 'accel-high-new',
    category: 'accel',
    minSeverity: HIGH_SEVERITY.accel,
    stages: NEW,
    title: 'Merge with space, not throttle',
    body: 'On a ramp, pick your gap early and match the speed of traffic as you travel down the lane. A long steady build is easier to judge than a burst at the end. If the gap closes, take the next one rather than forcing it.',
    why: 'Merging on a plan asks less of the car and leaves room to change your mind.',
    practice: 'This week, choose your merge gap before you reach the end of the ramp.',
    source: "California DMV Driver Handbook; New York State Driver's Manual",
  },
  // Source: California DMV Driver Handbook on traction and adverse conditions, with UK Highway
  // Code guidance on driving in wet and icy weather.
  {
    id: 'accel-high-experienced',
    category: 'accel',
    minSeverity: HIGH_SEVERITY.accel,
    stages: EXPERIENCED,
    title: 'Keep the tires within their grip',
    body: 'A very quick launch asks the tires for grip you may want for steering a moment later. In rain, on gravel or on a cold morning that margin is smaller. Leave some of it unused.',
    why: 'Grip is shared between accelerating and steering, and you cannot spend it twice.',
    practice: 'This week, treat wet mornings as a half-throttle rule.',
    source: 'California DMV Driver Handbook; UK Highway Code adverse-weather guidance',
  },

  // --- Sharp cornering (cap 10) ------------------------------------------------------------
  // Source: California DMV Driver Handbook on turns and steering, with AAA Foundation for
  // Traffic Safety driver-education materials on separating braking from steering.
  {
    id: 'cornering-low-new',
    category: 'cornering',
    minSeverity: 0,
    stages: NEW,
    title: 'Slow in, steady out',
    body: 'Do your braking before you start to turn, then hold a steady speed through the bend. Straighten the wheel as the road opens up, and add gas after that. Braking and turning together unsettles the car.',
    why: 'A car turns best when it is settled and its weight is not moving around.',
    practice: 'This week, finish your braking before the wheel starts to turn.',
    source: 'California DMV Driver Handbook; AAA Foundation for Traffic Safety',
  },
  // Source: New York State Driver's Manual on visual search through a turn, with AAA Foundation
  // for Traffic Safety driver-education materials on looking to the exit of a bend.
  {
    id: 'cornering-low-experienced',
    category: 'cornering',
    minSeverity: 0,
    stages: EXPERIENCED,
    title: 'Look where you want to go',
    body: 'Turn your eyes to the exit of the bend rather than the curb in front of you. Your hands follow your eyes, so a smooth look gives a smooth line. It also shows you anything waiting around the corner sooner.',
    why: 'Where you look sets how early and how gently you steer.',
    practice: 'This week, find the exit of each turn with your eyes before you steer.',
    source: "New York State Driver's Manual; AAA Foundation for Traffic Safety",
  },
  // Source: California DMV Driver Handbook on slowing before a curve or ramp, with UK Highway
  // Code guidance on approaching bends at a speed you can hold through them.
  {
    id: 'cornering-high-new',
    category: 'cornering',
    minSeverity: HIGH_SEVERITY.cornering,
    stages: NEW,
    title: 'Set your speed before the curve',
    body: 'Choose your speed while the road is still straight, before the bend begins. A ramp that tightens halfway is far easier when you enter a little slower than you think you need. You can always add speed once you can see the exit.',
    why: 'Sharp cornering usually comes from entering a bend faster than it turned out to need.',
    practice: 'This week, set your speed before the curve, not in it.',
    source: 'California DMV Driver Handbook; UK Highway Code guidance on bends',
  },
  // Source: UK Highway Code adverse-weather guidance and the California DMV Driver Handbook on
  // reduced traction, both of which ask for lower entry speed and gentler steering when wet.
  {
    id: 'cornering-high-experienced',
    category: 'cornering',
    minSeverity: HIGH_SEVERITY.cornering,
    stages: EXPERIENCED,
    title: 'Carry less speed onto wet corners',
    body: 'Wet leaves, painted lines and cold surfaces all give the tires less to hold on to. Slow down earlier than usual and keep your steering gradual. Let the car settle before you add power on the way out.',
    why: 'A bend asks more of your grip than a straight road, and a wet surface has less to give.',
    practice: 'This week, take your two regular turns a little slower when the road is wet.',
    source: 'UK Highway Code adverse-weather guidance; California DMV Driver Handbook',
  },

  // --- Focus and alertness (cap 15, camera drives only) ------------------------------------
  // Source: NHTSA distracted-driving guidance and AAA Foundation for Traffic Safety
  // driver-education materials on keeping in-car tasks short and doing them while parked.
  {
    id: 'focus-low-new',
    category: 'focus',
    minSeverity: 0,
    stages: NEW,
    title: 'Two seconds is the limit',
    body: 'If a glance away from the road would take longer than about two seconds, it belongs to a moment when you are parked. Set the climate, the music and the mirrors before you move. Everything else can wait for the next stop.',
    why: 'A glance longer than a couple of seconds means driving blind for all of it.',
    practice: 'This week, set everything you need before you shift out of park.',
    source: 'NHTSA distracted-driving guidance; AAA Foundation for Traffic Safety',
  },
  // Source: New York State Driver's Manual and California DMV Driver Handbook on scanning: keep
  // the eyes moving between the road far ahead and the mirrors instead of fixing on one point.
  {
    id: 'focus-low-experienced',
    category: 'focus',
    minSeverity: 0,
    stages: EXPERIENCED,
    title: 'Keep your eyes moving',
    body: 'Scan far down the road, then your mirrors, then back to the road, every few seconds. A moving scan keeps you from settling into a stare at the bumper ahead. You will see brake lights, doors and cyclists earlier.',
    why: 'Seeing something early is what turns a surprise into an ordinary adjustment.',
    practice: 'This week, check a mirror at every block on your regular route.',
    source: "New York State Driver's Manual; California DMV Driver Handbook",
  },
  // Source: UK Highway Code rule 91 (do not start a drive tired; plan breaks on a long one) and
  // NHTSA drowsy-driving guidance, which both treat stopping as the only real remedy.
  {
    id: 'focus-high-new',
    category: 'focus',
    minSeverity: HIGH_SEVERITY.focus,
    stages: NEW,
    title: 'Pull over when you are tired',
    body: 'Heavy eyes, a missed exit or drifting within your lane all mean the drive should pause. Stop somewhere safe, get out and walk for a few minutes before you decide to carry on. If the feeling comes back, the driving is done for now.',
    why: 'When you are tired you notice things later than you think you do.',
    practice: 'This week, plan a stop on any drive longer than two hours.',
    source: 'UK Highway Code rule 91; NHTSA drowsy-driving guidance',
  },
  // Source: IIHS guidance for teen drivers on the role of passengers, with NHTSA
  // distracted-driving guidance on handing in-car tasks to someone who is not driving.
  {
    id: 'focus-high-experienced',
    category: 'focus',
    minSeverity: HIGH_SEVERITY.focus,
    stages: EXPERIENCED,
    title: 'Hand the passenger the job',
    body: 'If someone is with you, let them take the messages, the music and the directions so your eyes stay forward. Say it at the start of the drive, so it is not a negotiation later. Driving alone, let the mount and voice guidance do the same job.',
    why: 'A long glance inside the car is time the road spends unwatched.',
    practice: 'This week, ask your passenger to take the phone at the start of each drive.',
    source: 'IIHS guidance for teen drivers; NHTSA distracted-driving guidance',
  },
];

/**
 * General tips for the Home card and for a drive that lost no points at all. None of these is
 * keyed to a category, and every one reads the same whatever the stage, so each lists both
 * stages rather than appearing twice. Typed as a non-empty tuple so `pickDailyTip` always has a
 * tip to return.
 */
export const dayFallback: readonly [Tip, ...Tip[]] = [
  // Source: California DMV Driver Handbook and UK Highway Code guidance on preparing the vehicle
  // before setting off (seat, mirrors, and anything you would otherwise reach for).
  {
    id: 'general-set-up-first',
    category: 'general',
    minSeverity: 0,
    stages: BOTH,
    title: 'Set the car up before you move',
    body: 'Seat, mirrors, climate, music and phone mount all belong to the time before you shift out of park. Thirty seconds parked removes most of the reasons to reach for something later. Make it the same order every time and it becomes automatic.',
    why: 'Anything you set while parked is something you will not reach for while moving.',
    practice: 'This week, run the same parked setup before every drive.',
    source: 'California DMV Driver Handbook; UK Highway Code guidance on setting off',
  },
  // Source: NHTSA teen-driving guidance and AAA Foundation for Traffic Safety driver-education
  // materials on planning the route before departure rather than en route.
  {
    id: 'general-know-the-route',
    category: 'general',
    minSeverity: 0,
    stages: BOTH,
    title: 'Know the route before you go',
    body: 'Look at the route once while parked, so you know the turns and roughly how long it takes. Start voice guidance before you move and leave the screen alone. A driver who knows what is coming makes earlier, gentler decisions.',
    why: 'In-drive phone handling often starts as a navigation question.',
    practice: 'This week, start navigation before you leave the parking space.',
    source: 'NHTSA teen-driving guidance; AAA Foundation for Traffic Safety',
  },
  // Source: California DMV Driver Handbook on night driving and UK Highway Code guidance on
  // driving at night: slow down, increase the gap, and give your eyes more time.
  {
    id: 'general-night-margin',
    category: 'general',
    minSeverity: 0,
    stages: BOTH,
    title: 'Give night drives more room',
    body: 'After dark you can only plan as far as your headlights reach, so slow down and add a second to your following gap. Dip the dashboard brightness and look to the edge of the lane rather than into oncoming lights. Give yourself more time for every decision.',
    why: 'At night you see less of the road ahead, so the same speed leaves you less time.',
    practice: 'This week, add a second to your gap on every drive after dark.',
    source: 'California DMV Driver Handbook; UK Highway Code guidance on driving at night',
  },
  // Source: UK Highway Code adverse-weather guidance and the New York State Driver's Manual on
  // wet roads: longer stopping distances and gentler inputs.
  {
    id: 'general-wet-roads',
    category: 'general',
    minSeverity: 0,
    stages: BOTH,
    title: 'Ease everything off in the wet',
    body: 'On a wet road the car needs longer to stop and the tires have less to hold on to. Slow down, double your following gap, and make your braking, steering and throttle gentler than usual. The first rain after a dry spell is the slipperiest.',
    why: 'A wet surface gives the tires less grip for every single thing you ask of them.',
    practice: 'This week, double your following gap whenever the road is wet.',
    source: "UK Highway Code adverse-weather guidance; New York State Driver's Manual",
  },
  // Source: IIHS and NHTSA teen-driving guidance, which build confidence through supervised
  // practice across a widening range of conditions rather than through a single fix.
  {
    id: 'general-keep-it-up',
    category: 'general',
    minSeverity: 0,
    stages: BOTH,
    title: 'Keep the run going',
    body: 'Your recent drives came in clean, so there is nothing to fix today. What keeps a score steady is practice in new places: at night, in rain, on the highway. Pick one of those and do it on purpose this week.',
    why: 'Drivers get steadier by widening the range of conditions they have already practiced in.',
    practice: 'This week, drive one route you have not driven before.',
    source: 'IIHS guidance for teen drivers; NHTSA teen-driving guidance',
  },
];

/** Every tip in the module, for id-uniqueness and copy checks. */
export const allTips: readonly Tip[] = [...tips, ...dayFallback];

/**
 * Categories in the order a tie is broken: largest per-trip cap first, then alphabetically, so
 * the order is fixed by `CONSTANTS.CATEGORY` rather than by object key order. Two categories that
 * cost exactly the same are rare outside tests; when it happens, coach the one that can cost the
 * most — phone use before speeding before focus.
 */
export const CATEGORY_PRIORITY: readonly EventCategory[] = (
  Object.keys(CATEGORY) as EventCategory[]
).sort((a, b) => CATEGORY[b].cap - CATEGORY[a].cap || (a < b ? -1 : 1));

/**
 * The category that cost this trip the most, or `null` when nothing did. Only a deduction above
 * zero counts, so a category the driver was clean in can never be coached.
 */
function worstCategory(scored: ScoredTrip): EventCategory | null {
  let worst: EventCategory | null = null;
  let most = 0;
  for (const category of CATEGORY_PRIORITY) {
    const deduction = scored.categoryDeductions[category];
    // Strictly greater, walking a fixed priority order: the first of two equal deductions wins.
    if (Number.isFinite(deduction) && deduction > most) {
      worst = category;
      most = deduction;
    }
  }
  return worst;
}

/**
 * The worst severity the driver actually paid for in this category. Only events that appear in
 * `eventDeductions` are considered — a `possible`, disputed or low-confidence event costs nothing
 * and so has nothing to coach. With no matching event (an empty list from the caller) the answer
 * is 0, which still matches every category's low-severity tip.
 */
function worstSeverity(
  scored: ScoredTrip,
  events: readonly ScorableEvent[],
  category: EventCategory
): number {
  let worst = 0;
  for (const event of events) {
    if (event.category !== category) continue;
    const deduction = scored.eventDeductions[event.id];
    if (deduction === undefined || !(deduction > 0)) continue;
    const s = severity(event);
    if (Number.isFinite(s) && s > worst) worst = s;
  }
  return worst;
}

/**
 * The one coaching tip for a scored trip (§7.D D1 → D6).
 *
 * Deterministic: it reads the trip's own numbers and the fixed catalogue order, never a clock or
 * a random source, so the same trip always produces the same tip. It returns `null` for a trip
 * that was not scored and for a trip that lost no points — the Home card falls back to
 * `pickDailyTip` in that case — and it never returns a tip for a category with a zero deduction.
 *
 * @param stage where the driver is in the learning period; defaults to `new`, the more explanatory
 * copy, because an unknown stage is more likely to be an early driver.
 */
export function pickTopTip(
  scored: ScoredTrip,
  events: readonly ScorableEvent[],
  stage: TipStage = 'new'
): Tip | null {
  if (scored.status !== 'final' || scored.score === null) return null;

  const category = worstCategory(scored);
  if (category === null) return null;

  const worst = worstSeverity(scored, events, category);

  // The most specific tip that still applies: the highest `minSeverity` at or below what the
  // driver actually did, ties broken by catalogue order (`>` keeps the earlier tip).
  let best: Tip | null = null;
  for (const tip of tips) {
    if (tip.category !== category) continue;
    if (!tip.stages.includes(stage)) continue;
    if (tip.minSeverity > worst) continue;
    if (best === null || tip.minSeverity > best.minSeverity) best = tip;
  }
  return best;
}

/**
 * FNV-1a, 32-bit. A few lines rather than a dependency, and synchronous — `src/lib/hash.ts` is an
 * async expo-crypto digest, which a render-time picker cannot await.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A general tip for the Home card, chosen deterministically from `dayFallback`. The same seed
 * always gives the same tip, so the card does not change under the reader's hands on a re-render;
 * pass something that changes once a day, such as `${userId}:${isoDate}`.
 */
export function pickDailyTip(seed: string): Tip {
  const index = fnv1a(seed) % dayFallback.length;
  // `dayFallback` is a non-empty tuple and the index is a modulus of its length, so the lookup
  // always hits; the fallback is here only to satisfy `noUncheckedIndexedAccess`.
  return dayFallback[index] ?? dayFallback[0];
}
