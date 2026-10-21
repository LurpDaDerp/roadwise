/**
 * Problem spots: every number the detection, the recompute job and the driving-screen nudge use
 * (spots.md §2.2 and §7.2; the plan's 3.15 sets `SPOT_NUDGE_MS` to 4 s). Pure data.
 *
 * The data layer keeps its own copy of the read limits (`SPOT_READ`, `SPOT_LABEL_CARRY_M` in
 * `src/data/db/spots.ts` / `src/data/queries/spots.ts`) so it needs nothing from here at run time;
 * `__tests__/constants.test.ts` pins the two copies together.
 */
import { MAX_H_ACC_M } from '@scoring';

import { EXIT_BASE_M, HEADING_BASE_M as RUNS_HEADING_BASE_M } from '@/lib/runs';

import type { SpotKind } from './types';

const DAY_MS = 86_400_000;

/** The event types that make spots; a spot's kind is its event type. */
export const SPOT_KINDS: readonly SpotKind[] = ['speeding', 'hard_brake', 'hard_corner', 'hard_accel'];

// ── Detection (spots.md §2.2) ───────────────────────────────────────────────────────────

/** Drives and events older than this are ignored. */
export const SPOT_WINDOW_DAYS = 120;
export const SPOT_WINDOW_MS = SPOT_WINDOW_DAYS * DAY_MS;
/** The newest drives kept in the window. */
export const SPOT_MAX_DRIVES = 400;
/** The newest qualifying events kept in the window. */
export const SPOT_MAX_EVENTS = 3000;
/** Clusters that go on to pass counting. */
export const SPOT_MAX_CANDIDATES = 60;
/** An event farther than this from its own drive's route has no heading and is dropped. */
export const EVENT_SNAP_M = 30;
/** The direction of travel is read over this much road before a point. */
export const HEADING_BASE_M = RUNS_HEADING_BASE_M;
/** A turn's exit direction is read over this much road after the point. */
export const TURN_EXIT_M = EXIT_BASE_M;
/** Same direction of travel (clustering, passes). */
export const HEADING_TOL_DEG = 45;
/** How near a cluster's centre an event must be to join it. */
export const CLUSTER_EPS_M: Readonly<Record<SpotKind, number>> = { speeding: 150, hard_brake: 50, hard_corner: 50, hard_accel: 50 };
/** Two clusters merge when their centres are within eps times this. */
export const CLUSTER_MERGE_SHARE = 0.5;
/** Stretch speed when a speeding event has no measured speed (≈ 30 mph, as the summary map). */
export const ASSUMED_MPS = 13.4;
export const MPH_TO_MPS = 0.44704;
/** One speeding stretch, and one speed segment, at most. */
export const SPEED_STRETCH_MAX_M = 600;
/** A speed segment is grown to at least this. */
export const SPEED_SEGMENT_MIN_M = 120;
/** The coloured road around a point spot, before and after it along the direction of travel. */
export const POINT_SEGMENT_M: Readonly<Record<Exclude<SpotKind, 'speeding'>, { before: number; after: number }>> = {
  hard_brake: { before: 60, after: 20 },
  hard_corner: { before: 40, after: 40 },
  hard_accel: { before: 20, after: 60 },
};
/** A drive whose route comes within this of a spot's centre, heading the same way, passed it. */
export const PASS_RADIUS_M = 35;
/** Hits (distinct drives) since a spot's (re)start before it can become one. */
export const MIN_HITS = 3;
/** A pass this many days older weighs half. */
export const HALF_LIFE_DAYS = 30;
/** The Beta(0.5, 4.5) prior: a new place starts from 1 in 10, worth 5 passes. */
export const PRIOR_HITS = 0.5;
export const PRIOR_PASSES = 5;
/** The recency-weighted rate at or above which a place becomes a spot. */
export const P_ENTER = 0.25;
/** Below this rate an active spot clears. */
export const P_EXIT = 0.1;
/** The clean run that clears a spot: ⌈ln 0.1 / ln(1 − p)⌉, held between 4 and 10. */
export const CLEAN_K_MIN = 4;
export const CLEAN_K_MAX = 10;
export const CLEAN_K_CHANCE = 0.1;
/** An active spot no drive passed for this long is not shown and never nudges. */
export const DORMANT_DAYS = 60;
/** Cleared spots are counted in the card's footnote this long. */
export const CLEARED_SHOWN_DAYS = 30;
/** Active spots kept, best ranked first. */
export const MAX_SPOTS = 5;
/** "4 of your last 6 drives here" looks at up to this many passes. */
export const RECENT_PASSES = 10;

// ── Labels and the recompute job (spots.md §2.2, §3.4, §5) ──────────────────────────────

/** A new spot keeps an old spot's label when the same kind's pin is within this. */
export const LABEL_CARRY_M = 60;
/** A failed label is tried again after a day. */
export const LABEL_RETRY_MS = DAY_MS;
/** Reverse geocodes per recompute, one at a time this far apart. */
export const MAX_GEOCODES_PER_RUN = 5;
export const GEOCODE_GAP_MS = 1200;
/** Scored drives in the window before the card shows. */
export const MIN_DRIVES_FOR_CARD = 10;
export const RECOMPUTE_DEBOUNCE_MS = 2000;
export const RECOMPUTE_DAILY_MS = DAY_MS;
/** Routes decoded between yields to the event loop. */
export const DECODE_CHUNK = 25;

// ── The driving-screen nudge (spots.md §7.2) ────────────────────────────────────────────

/** No nudge below this speed. */
export const NUDGE_MIN_MPH = 10;
/** No nudge from a fix less accurate than this. */
export const NUDGE_MAX_H_ACC_M = MAX_H_ACC_M;
/** The car heads the spot's way within this. */
export const NUDGE_HEADING_TOL_DEG = 45;
/** The spot lies ahead within this of the car's course. */
export const NUDGE_AHEAD_TOL_DEG = 30;
/** And at most this far to the side of the course line (keeps a parallel road off). */
export const NUDGE_LATERAL_M = 50;
/** The nudge shows this many seconds ahead of the spot, held between the two distances below. */
export const NUDGE_LEAD_S = 12;
export const NUDGE_LEAD_MIN_M = 120;
export const NUDGE_LEAD_MAX_M = 400;
/** Never once already this close (inside the spot). */
export const NUDGE_INSIDE_M = 40;
/** Spots farther than this are not looked at. */
export const NUDGE_PREFILTER_M = 1000;
/** Nudges per drive at most. */
export const NUDGE_MAX_PER_DRIVE = 3;
/** Row-clock time between two nudges. */
export const NUDGE_GAP_MS = 60_000;
/** No nudge this long after an alert's glow ends (on top of `ALERT_GLOW_MS`). */
export const NUDGE_AFTER_ALERT_MS = 1000;
/** How long the driving screen shows a nudge. */
export const SPOT_NUDGE_MS = 4000;
