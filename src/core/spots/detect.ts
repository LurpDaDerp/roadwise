/**
 * Problem-spot detection (spots.md §2, §4.1): the places where the same thing keeps happening on
 * this driver's drives, in the same direction of travel, judged per drive through the place.
 *
 * 1. Each located event is snapped to its own drive's (privacy-trimmed) route for a direction of
 *    travel; one more than 30 m off has none and is dropped.
 * 2. Events cluster per kind in time order (a leader pass: an event joins the nearest cluster of its
 *    kind within the kind's distance heading the same way, else starts one), then near clusters merge.
 * 3. Clusters from at least 3 drives go on: every drive whose route passes the centre the same way
 *    is a pass, a drive with an event in the cluster is a hit, and the passes replay through a small
 *    state machine (a recency-weighted rate from a 1-in-10 prior; in at 3 hits and a quarter of the
 *    passes; out after an unlikely clean run or under 1 in 10).
 * 4. The active ones (passed in the last 60 days) rank by rate, at most 5; the ones cleared in the
 *    last 30 days come along for the card's footnote.
 *
 * Deterministic and pure: inputs are sorted, `now` is passed in, no randomness, no clock, and no
 * dependence on map iteration order.
 */
import { angleDiffDeg } from '@/core/speedLimits/geometry';
import { bearingDeg, haversineMeters, type LatLng } from '@/lib/geo';
import { cumulative, exitAt, headingAt, pointAt, project, slice } from '@/lib/runs';

import {
  ASSUMED_MPS,
  CLEAN_K_CHANCE,
  CLEAN_K_MAX,
  CLEAN_K_MIN,
  CLEARED_SHOWN_DAYS,
  CLUSTER_EPS_M,
  CLUSTER_MERGE_SHARE,
  DORMANT_DAYS,
  EVENT_SNAP_M,
  HALF_LIFE_DAYS,
  HEADING_TOL_DEG,
  MAX_SPOTS,
  MIN_HITS,
  MPH_TO_MPS,
  P_ENTER,
  P_EXIT,
  PASS_RADIUS_M,
  POINT_SEGMENT_M,
  PRIOR_HITS,
  PRIOR_PASSES,
  RECENT_PASSES,
  SPEED_SEGMENT_MIN_M,
  SPEED_STRETCH_MAX_M,
  SPOT_KINDS,
  SPOT_MAX_CANDIDATES,
  SPOT_MAX_DRIVES,
  SPOT_MAX_EVENTS,
  SPOT_WINDOW_MS,
} from './constants';
import type { DetectedSpot, SpotDrive, SpotEvent, SpotKind } from './types';

// Local bindings: the pass loop runs millions of times on a heavy history, and a global `Math`
// lookup per call is slow in some engines (Jest's VM context most of all).
const { atan2, cos, floor, max, min, PI, sin } = Math;

const DAY_MS = 86_400_000;
const HALF_LIFE_MS = HALF_LIFE_DAYS * DAY_MS;
/** Metres per degree of latitude (the sphere `haversineMeters` uses). */
const M_PER_DEG = (PI / 180) * 6371008.8;
/** The clustering grid's cell, wider than the widest join distance so 3 × 3 cells hold every candidate. */
const GRID_M = 200;
/** A speed spot's heading is read over this much of its segment. */
const SPEED_HEADING_M = 40;

/** Ordinal string order, the same in every locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

// ── The state machine (spots.md §2.5) ───────────────────────────────────────────────────

/** One drive through a spot, its way: when (its start) and whether the event happened. */
export interface PassMark {
  t: number;
  hit: boolean;
}

export interface Replay {
  state: 'none' | 'active';
  hits: number;
  passes: number;
  recentHits: number;
  recentPasses: number;
  /** The rate after the last pass, 3 dp (the prior's 0.1 before any). */
  rate: number;
  cleanStreak: number;
  cleanNeeded: number;
  /** The pass that last cleared it, or null when it never cleared. */
  clearedAt: number | null;
}

/** One step of a replay, for tests: the pass, the rate it gave and the state after it. */
export interface ReplayStep {
  index: number;
  p: number;
  state: 'none' | 'active';
  clean: number;
  cleanNeeded: number;
}

/** The clean run that clears a spot hit at rate `p`: unlikely (≤ 10 %) if nothing changed, held to 4..10. */
export function cleanNeededFor(p: number | null): number {
  if (p === null || !(p > 0)) return CLEAN_K_MAX;
  if (p >= 1) return CLEAN_K_MIN;
  const k = Math.ceil(Math.log(CLEAN_K_CHANCE) / Math.log(1 - p));
  return min(CLEAN_K_MAX, max(CLEAN_K_MIN, k));
}

/**
 * Replay a spot's passes in time order. The weights are causal (each pass's age is measured from
 * the next one), so the result depends only on the pass sequence. A clearing starts the spot over:
 * only later passes count.
 */
export function replay(passes: readonly PassMark[], trace?: (step: ReplayStep) => void): Replay {
  let state: 'none' | 'active' = 'none';
  let sh = 0;
  let sw = 0;
  let hits = 0;
  let count = 0;
  let clean = 0;
  let pLastHit: number | null = null;
  let prevT: number | null = null;
  let clearedAt: number | null = null;
  let p = PRIOR_HITS / PRIOR_PASSES;
  let recent: boolean[] = [];
  passes.forEach((pass, index) => {
    const decay = prevT === null ? 1 : 0.5 ** ((pass.t - prevT) / HALF_LIFE_MS);
    prevT = pass.t;
    const hit = pass.hit ? 1 : 0;
    sh = sh * decay + hit;
    sw = sw * decay + 1;
    count += 1;
    hits += hit;
    recent.push(pass.hit);
    p = (sh + PRIOR_HITS) / (sw + PRIOR_PASSES);
    if (state === 'none') {
      if (pass.hit && hits >= MIN_HITS && p >= P_ENTER) {
        state = 'active';
        clean = 0;
        pLastHit = p;
      }
    } else if (pass.hit) {
      clean = 0;
      pLastHit = p;
    } else {
      clean += 1;
      if (clean >= cleanNeededFor(pLastHit) || p < P_EXIT) {
        state = 'none';
        clearedAt = pass.t;
        sh = 0;
        sw = 0;
        hits = 0;
        count = 0;
        clean = 0;
        prevT = null;
        recent = [];
      }
    }
    trace?.({ index, p, state, clean, cleanNeeded: cleanNeededFor(pLastHit) });
  });
  const last = recent.slice(-RECENT_PASSES);
  return {
    state,
    hits,
    passes: count,
    recentHits: last.filter(Boolean).length,
    recentPasses: last.length,
    rate: round3(p),
    cleanStreak: clean,
    cleanNeeded: cleanNeededFor(pLastHit),
    clearedAt,
  };
}

// ── Inputs ──────────────────────────────────────────────────────────────────────────────

interface Run {
  points: readonly LatLng[];
  cum: number[];
  total: number;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

interface Drive {
  id: string;
  startedAt: number;
  runs: Run[];
}

/** An event placed on its own drive's route. */
interface Located {
  /** Its place in time order (the events sorted by (startedAt, id)). */
  order: number;
  ev: SpotEvent;
  drive: number;
  /** The point it clusters on: its own place, or a speeding stretch's middle. */
  point: LatLng;
  heading: number;
  /** A turn's exit direction; null for other kinds. */
  exit: number | null;
  run: number;
  /** Speeding: where the stretch began on its route, and how long it was. */
  entry: LatLng | null;
  len: number;
}

function toRun(points: readonly LatLng[]): Run | null {
  const clean = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (clean.length < 2) return null;
  const cum = cumulative(clean);
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of clean) {
    minLat = min(minLat, p.lat);
    maxLat = max(maxLat, p.lat);
    minLng = min(minLng, p.lng);
    maxLng = max(maxLng, p.lng);
  }
  return { points: clean, cum, total: cum[cum.length - 1]!, minLat, maxLat, minLng, maxLng };
}

/** The kept drives, oldest first: started in the window, the newest `SPOT_MAX_DRIVES`, one per id. */
function keptDrives(drives: readonly SpotDrive[], since: number): Drive[] {
  const sorted = drives
    .filter((d) => Number.isFinite(d.startedAt) && d.startedAt >= since)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt || cmp(a.clientTripId, b.clientTripId));
  const seen = new Set<string>();
  const unique = sorted.filter((d) => (seen.has(d.clientTripId) ? false : (seen.add(d.clientTripId), true)));
  return unique.slice(-SPOT_MAX_DRIVES).map((d) => ({
    id: d.clientTripId,
    startedAt: d.startedAt,
    runs: d.runs.map(toRun).filter((r): r is Run => r !== null),
  }));
}

/** The kept events on their routes, in time order; any with no heading are dropped. */
function locate(events: readonly SpotEvent[], drives: readonly Drive[], since: number): Located[] {
  const byId = new Map<string, number>();
  drives.forEach((d, i) => byId.set(d.id, i));
  const kinds = new Set<string>(SPOT_KINDS);
  const kept = events
    .filter((e) => kinds.has(e.type) && byId.has(e.clientTripId) && e.startedAt >= since && Number.isFinite(e.lat) && Number.isFinite(e.lng))
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt || cmp(a.id, b.id))
    .slice(-SPOT_MAX_EVENTS);
  const out: Located[] = [];
  for (const ev of kept) {
    const drive = byId.get(ev.clientTripId)!;
    const runs = drives[drive]!.runs;
    if (runs.length === 0) continue;
    const snap = project(
      runs.map((r) => r.points),
      runs.map((r) => r.cum),
      { lat: ev.lat, lng: ev.lng }
    );
    if (!(snap.distM <= EVENT_SNAP_M)) continue;
    const run = runs[snap.run]!;
    let point: LatLng = { lat: ev.lat, lng: ev.lng };
    let heading: number | null;
    let exit: number | null = null;
    let entry: LatLng | null = null;
    let len = 0;
    if (ev.type === 'speeding') {
      const mps = ev.speedMph !== null && ev.speedMph > 0 ? ev.speedMph * MPH_TO_MPS : ASSUMED_MPS;
      len = min(SPEED_STRETCH_MAX_M, mps * max(0, Number.isFinite(ev.durationS) ? ev.durationS : 0));
      const d1 = min(run.total, snap.d + len);
      const d0 = max(0, d1 - len);
      const mid = (d0 + d1) / 2;
      point = pointAt(run.points, run.cum, mid);
      heading = headingAt(run.points, run.cum, mid);
      entry = pointAt(run.points, run.cum, d0);
    } else {
      heading = headingAt(run.points, run.cum, snap.d);
      if (ev.type === 'hard_corner') {
        exit = exitAt(run.points, run.cum, snap.d);
        if (exit === null) continue;
      }
    }
    if (heading === null) continue;
    out.push({ order: out.length, ev, drive, point, heading, exit, run: snap.run, entry, len });
  }
  return out;
}

// ── Clustering ──────────────────────────────────────────────────────────────────────────

interface Cluster {
  index: number;
  kind: SpotKind;
  members: number[];
  sumLat: number;
  sumLng: number;
  sinH: number;
  cosH: number;
  sinE: number;
  cosE: number;
  centre: LatLng;
  heading: number;
  exit: number | null;
  alive: boolean;
  cell: string;
}

const toDeg = (r: number) => (r * 180) / PI;
const toRad = (d: number) => (d * PI) / 180;
const meanDeg = (s: number, c: number): number => (s === 0 && c === 0 ? 0 : (toDeg(atan2(s, c)) + 360) % 360);

function cellOf(kind: SpotKind, p: LatLng, dx = 0, dy = 0): string {
  const y = floor((p.lat * M_PER_DEG) / GRID_M) + dy;
  const x = floor((p.lng * M_PER_DEG * cos(toRad(p.lat))) / GRID_M) + dx;
  return `${kind}|${y}|${x}`;
}

class Grid {
  private cells = new Map<string, number[]>();
  add(cell: string, index: number) {
    const list = this.cells.get(cell);
    if (list) list.push(index);
    else this.cells.set(cell, [index]);
  }
  remove(cell: string, index: number) {
    const list = this.cells.get(cell);
    if (!list) return;
    const i = list.indexOf(index);
    if (i >= 0) list.splice(i, 1);
  }
  /** Every index in the 3 × 3 cells around `p`, ascending. */
  near(kind: SpotKind, p: LatLng): number[] {
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(...(this.cells.get(cellOf(kind, p, dx, dy)) ?? []));
    return out.sort((a, b) => a - b);
  }
}

function sameWay(c: { heading: number; exit: number | null }, heading: number, exit: number | null, kind: SpotKind): boolean {
  if (angleDiffDeg(c.heading, heading) > HEADING_TOL_DEG) return false;
  if (kind !== 'hard_corner') return true;
  return c.exit !== null && exit !== null && angleDiffDeg(c.exit, exit) <= HEADING_TOL_DEG;
}

function refresh(c: Cluster, grid: Grid) {
  const n = c.members.length;
  c.centre = { lat: c.sumLat / n, lng: c.sumLng / n };
  c.heading = meanDeg(c.sinH, c.cosH);
  c.exit = c.kind === 'hard_corner' ? meanDeg(c.sinE, c.cosE) : null;
  const cell = cellOf(c.kind, c.centre);
  if (cell !== c.cell) {
    grid.remove(c.cell, c.index);
    grid.add(cell, c.index);
    c.cell = cell;
  }
}

function addMember(c: Cluster, l: Located) {
  c.members.push(l.order);
  c.sumLat += l.point.lat;
  c.sumLng += l.point.lng;
  c.sinH += sin(toRad(l.heading));
  c.cosH += cos(toRad(l.heading));
  if (l.exit !== null) {
    c.sinE += sin(toRad(l.exit));
    c.cosE += cos(toRad(l.exit));
  }
}

/** The leader pass in time order, then merges until stable. Every cluster still alive, by index. */
function cluster(located: readonly Located[]): Cluster[] {
  const grid = new Grid();
  const all: Cluster[] = [];
  for (const l of located) {
    const kind = l.ev.type;
    const eps = CLUSTER_EPS_M[kind];
    let best: Cluster | null = null;
    let bestD = Infinity;
    for (const i of grid.near(kind, l.point)) {
      const c = all[i]!;
      if (!c.alive || c.kind !== kind) continue;
      const d = haversineMeters(c.centre, l.point);
      if (d > eps || !sameWay(c, l.heading, l.exit, kind)) continue;
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    if (best === null) {
      const c: Cluster = { index: all.length, kind, members: [], sumLat: 0, sumLng: 0, sinH: 0, cosH: 0, sinE: 0, cosE: 0, centre: l.point, heading: l.heading, exit: l.exit, alive: true, cell: cellOf(kind, l.point) };
      grid.add(c.cell, c.index);
      all.push(c);
      best = c;
    }
    addMember(best, l);
    refresh(best, grid);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const a of all) {
      if (!a.alive) continue;
      for (;;) {
        const eps = CLUSTER_EPS_M[a.kind] * CLUSTER_MERGE_SHARE;
        const b = grid
          .near(a.kind, a.centre)
          .map((i) => all[i]!)
          .find((c) => c.alive && c.index > a.index && c.kind === a.kind && haversineMeters(a.centre, c.centre) <= eps && sameWay(a, c.heading, c.exit, a.kind));
        if (b === undefined) break;
        a.members.push(...b.members);
        a.sumLat += b.sumLat;
        a.sumLng += b.sumLng;
        a.sinH += b.sinH;
        a.cosH += b.cosH;
        a.sinE += b.sinE;
        a.cosE += b.cosE;
        b.alive = false;
        grid.remove(b.cell, b.index);
        refresh(a, grid);
        changed = true;
      }
    }
  }
  for (const c of all) c.members.sort((x, y) => x - y);
  return all.filter((c) => c.alive);
}

// ── Passes ──────────────────────────────────────────────────────────────────────────────

/** Whether a drive's route passes `c`'s centre within the pass radius, heading its way. */
function passesThrough(drive: Drive, c: Cluster): boolean {
  const p = c.centre;
  const k = cos(toRad(p.lat));
  const rLat = PASS_RADIUS_M / M_PER_DEG;
  const rLng = k > 0 ? rLat / k : rLat;
  const r2 = rLat * rLat;
  for (const run of drive.runs) {
    if (p.lat < run.minLat - rLat || p.lat > run.maxLat + rLat || p.lng < run.minLng - rLng || p.lng > run.maxLng + rLng) continue;
    const pts = run.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if ((a.lat < p.lat - rLat && b.lat < p.lat - rLat) || (a.lat > p.lat + rLat && b.lat > p.lat + rLat)) continue;
      if ((a.lng < p.lng - rLng && b.lng < p.lng - rLng) || (a.lng > p.lng + rLng && b.lng > p.lng + rLng)) continue;
      const bx = (b.lng - a.lng) * k;
      const by = b.lat - a.lat;
      const px = (p.lng - a.lng) * k;
      const py = p.lat - a.lat;
      const len2 = bx * bx + by * by;
      const t = len2 > 0 ? min(1, max(0, (px * bx + py * by) / len2)) : 0;
      if ((px - t * bx) ** 2 + (py - t * by) ** 2 > r2) continue;
      const d = run.cum[i - 1]! + t * (run.cum[i]! - run.cum[i - 1]!);
      const h = headingAt(pts, run.cum, d);
      if (h === null || angleDiffDeg(h, c.heading) > HEADING_TOL_DEG) continue;
      if (c.kind === 'hard_corner') {
        const e = exitAt(pts, run.cum, d);
        if (e === null || c.exit === null || angleDiffDeg(e, c.exit) > HEADING_TOL_DEG) continue;
      }
      return true;
    }
  }
  return false;
}

// ── Geometry (spots.md §4.1) ────────────────────────────────────────────────────────────

function speedGeometry(c: Cluster, located: readonly Located[], run: Run, rep: Located): { pin: LatLng; headingDeg: number; segment: LatLng[] } {
  let segStart = Infinity;
  let segEnd = -Infinity;
  for (const m of c.members) {
    const l = located[m]!;
    if (l.entry === null) continue;
    const at = project([run.points], [run.cum], l.entry);
    if (!(at.distM <= PASS_RADIUS_M)) continue;
    segStart = min(segStart, at.d);
    segEnd = max(segEnd, at.d + l.len);
  }
  if (!Number.isFinite(segStart)) {
    const at = project([run.points], [run.cum], rep.entry ?? rep.point);
    segStart = at.d;
    segEnd = at.d + rep.len;
  }
  segEnd = min(segEnd, segStart + SPEED_STRETCH_MAX_M, run.total);
  if (segEnd - segStart < SPEED_SEGMENT_MIN_M) {
    segEnd = min(run.total, segStart + SPEED_SEGMENT_MIN_M);
    segStart = max(0, segEnd - SPEED_SEGMENT_MIN_M);
  }
  const pin = pointAt(run.points, run.cum, segStart);
  const ahead = min(segEnd, segStart + SPEED_HEADING_M);
  const headingDeg = ahead - segStart >= 5 ? bearingDeg(pin, pointAt(run.points, run.cum, ahead)) : c.heading;
  return { pin, headingDeg, segment: slice(run.points, run.cum, segStart, segEnd) };
}

function pointGeometry(c: Cluster, run: Run): { pin: LatLng; headingDeg: number; segment: LatLng[] } {
  const span = POINT_SEGMENT_M[c.kind as Exclude<SpotKind, 'speeding'>];
  const { d } = project([run.points], [run.cum], c.centre);
  return {
    pin: pointAt(run.points, run.cum, d),
    headingDeg: c.heading,
    segment: slice(run.points, run.cum, max(0, d - span.before), min(run.total, d + span.after)),
  };
}

/** The most common posted limit among a speed spot's events, a tie to the lower; null when none. */
export function modeLimit(limits: readonly (number | null)[]): number | null {
  const n = new Map<number, number>();
  for (const v of limits) if (v !== null && Number.isFinite(v) && v > 0) n.set(v, (n.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestN = 0;
  for (const [v, k] of [...n].sort((a, b) => a[0] - b[0])) {
    if (k > bestN) {
      best = v;
      bestN = k;
    }
  }
  return best;
}

// ── The whole detection ────────────────────────────────────────────────────────────────

/**
 * The spots of a driver at `now` from their scored drives and located events: the active ones
 * (rank 1..5, best first) then the ones cleared in the last 30 days (rank 0), each group by id.
 */
export function detectSpots(drives: readonly SpotDrive[], events: readonly SpotEvent[], now: number): DetectedSpot[] {
  const since = now - SPOT_WINDOW_MS;
  const kept = keptDrives(drives, since);
  const located = locate(events, kept, since);
  const clusters = cluster(located);

  const driveSets = new Map<number, Set<number>>();
  for (const c of clusters) driveSets.set(c.index, new Set(c.members.map((m) => located[m]!.drive)));
  const candidates = clusters
    .filter((c) => driveSets.get(c.index)!.size >= MIN_HITS)
    .sort((a, b) => {
      const n = driveSets.get(b.index)!.size - driveSets.get(a.index)!.size;
      if (n !== 0) return n;
      const newest = b.members[b.members.length - 1]! - a.members[a.members.length - 1]!;
      if (newest !== 0) return newest;
      return cmp(located[a.members[0]!]!.ev.id, located[b.members[0]!]!.ev.id);
    })
    .slice(0, SPOT_MAX_CANDIDATES);

  const found: (Omit<DetectedSpot, 'rank'> & { state: 'active' | 'cleared' })[] = [];
  for (const c of candidates) {
    const hitDrives = driveSets.get(c.index)!;
    const passes: PassMark[] = [];
    kept.forEach((drive, i) => {
      const hit = hitDrives.has(i);
      if (hit || passesThrough(drive, c)) passes.push({ t: drive.startedAt, hit });
    });
    const r = replay(passes);
    const lastPassAt = passes[passes.length - 1]!.t;
    const active = r.state === 'active' && lastPassAt >= now - DORMANT_DAYS * DAY_MS;
    const cleared = r.state === 'none' && r.clearedAt !== null && r.clearedAt >= now - CLEARED_SHOWN_DAYS * DAY_MS;
    if (!active && !cleared) continue;

    // The newest hit drive and its newest event here give the road the spot is drawn on.
    const repDrive = max(...hitDrives);
    const rep = located[c.members.filter((m) => located[m]!.drive === repDrive).pop()!]!;
    const run = kept[repDrive]!.runs[rep.run]!;
    const geometry = c.kind === 'speeding' ? speedGeometry(c, located, run, rep) : pointGeometry(c, run);
    const anchor = located[c.members[0]!]!.ev;
    found.push({
      id: `${c.kind}:${anchor.id}`,
      kind: c.kind,
      state: active ? 'active' : 'cleared',
      pin: geometry.pin,
      headingDeg: geometry.headingDeg,
      segment: geometry.segment,
      limitMph: c.kind === 'speeding' ? modeLimit(c.members.map((m) => located[m]!.ev.limitMph)) : null,
      hits: r.hits,
      passes: r.passes,
      recentHits: r.recentHits,
      recentPasses: r.recentPasses,
      rate: r.rate,
      cleanStreak: r.cleanStreak,
      cleanNeeded: r.cleanNeeded,
      lastHitAt: rep.ev.startedAt,
      lastHitTrip: kept[repDrive]!.id,
      lastPassAt,
      clearedAt: active ? null : r.clearedAt,
    });
  }

  const actives = found
    .filter((s) => s.state === 'active')
    .sort((a, b) => b.rate - a.rate || b.lastHitAt - a.lastHitAt || cmp(a.id, b.id))
    .slice(0, MAX_SPOTS)
    .map((s, i) => ({ ...s, rank: i + 1 }));
  const cleared = found
    .filter((s) => s.state === 'cleared')
    .sort((a, b) => cmp(a.id, b.id))
    .map((s) => ({ ...s, rank: 0 }));
  return [...actives, ...cleared];
}
