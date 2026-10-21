/**
 * The problem-spot recompute job (spots.md §3.4): it rebuilds the phone's spots from its drives,
 * off the render path and never during a drive.
 *
 * - **When.** After any data change (2 s after the last one), on a return to the app with a
 *   recompute pending, and once a day; only with the app in front and no drive recording or
 *   finalizing. The first foreground after this build computes from the existing history.
 * - **How.** Read the inputs, decode the routes 25 at a time with a yield between, detect, then
 *   replace the table whole in one transaction that writes nothing if a wipe got there first.
 *   A drive that starts mid-run, or a wipe, abandons the run with the recompute still pending.
 * - **Names.** Then up to 5 active spots without a place name get one from the phone's reverse
 *   geocoder, one at a time 1.2 s apart, never inside a privacy zone; a failed one is retried after
 *   a day.
 * - Each write announces a `spots` change, which refreshes only the spots (and never re-triggers
 *   this job). Errors are reported by name only, never with a coordinate.
 */
import { detectSpots } from '@/core/spots/detect';
import { spotLabel, streetGeocoder, type Geocoder } from '@/core/spots/label';
import type { DetectedSpot, SpotDrive } from '@/core/spots/types';
import {
  DECODE_CHUNK,
  GEOCODE_GAP_MS,
  LABEL_RETRY_MS,
  MAX_GEOCODES_PER_RUN,
  RECOMPUTE_DAILY_MS,
  RECOMPUTE_DEBOUNCE_MS,
} from '@/core/spots/constants';
import { parseZones, PRIVACY_ZONES_KEY, zoneAt } from '@/core/engine/privacy';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { createSpotsRepo } from '@/data/db/spots';
import type { NewProblemSpot } from '@/data/db/types';
import { emitDataChanged, onDataChanged } from '@/data/events';
import { runWhenForeground, type AppStateLike } from '@/data/foreground';
import { readSpotInputs } from '@/data/queries/spots';
import { decodeRoute } from '@/features/drives/route';
import { encodePolyline } from '@/lib/polyline';

export interface SpotJobDeps {
  db: Db;
  /** React Native's AppState (narrowed). */
  appState: AppStateLike;
  /** A drive is recording or finalizing (`runtime.drive.isBusy()`). */
  isBusy(): boolean;
  now(): number;
  /** The reverse geocoder for place names; null makes none (tests). Default: the street geocoder. */
  geocode?: Geocoder | null;
  /** Told about a failure, by name only (never a coordinate). */
  onError?(e: unknown, ctx: string): void;
}

export interface SpotJobs {
  stop(): void;
  /** Recompute now (and name the spots), unless a drive is under way or the app is behind. */
  runNow(): Promise<void>;
}

const round5 = (v: number): number => Math.round(v * 1e5) / 1e5;
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** A detected spot as its table row: the pin to 5 dp, the road as an encoded polyline. */
export function toSpotRow(s: DetectedSpot): NewProblemSpot {
  return {
    id: s.id,
    kind: s.kind,
    state: s.state,
    lat: round5(s.pin.lat),
    lng: round5(s.pin.lng),
    heading_deg: round1(s.headingDeg),
    segment: encodePolyline(s.segment),
    limit_mph: s.limitMph,
    hits: s.hits,
    passes: s.passes,
    recent_hits: s.recentHits,
    recent_passes: s.recentPasses,
    rate: s.rate,
    clean_streak: s.cleanStreak,
    clean_needed: s.cleanNeeded,
    last_hit_at: s.lastHitAt,
    last_hit_trip: s.lastHitTrip,
    last_pass_at: s.lastPassAt,
    cleared_at: s.clearedAt,
    rank: s.rank,
  };
}

const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Start the job; `stop()` ends it (a run in flight writes nothing more). */
export function startSpotJobs(deps: SpotJobDeps): SpotJobs {
  const repo = createSpotsRepo(deps.db);
  const settings = createSettingsRepo(deps.db);
  const geocode = deps.geocode === undefined ? streetGeocoder : deps.geocode;
  const report = (e: unknown, ctx: string) => deps.onError?.(e, ctx);

  let state = deps.appState.currentState;
  let pending = true;
  /** Bumped by every request: a run clears `pending` only when nothing asked again meanwhile. */
  let asked = 0;
  /** Bumped by a wipe (and by stop): a run that began before one writes nothing. */
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  const ready = () => !stopped && state === 'active' && !deps.isBusy();

  function cancelTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function request() {
    pending = true;
    asked += 1;
    if (!ready()) return;
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      if (pending) void runNow();
    }, RECOMPUTE_DEBOUNCE_MS);
  }

  async function nameSpots(gen: number): Promise<void> {
    if (geocode === null) return;
    const zones = parseZones(await settings.get<unknown>(PRIVACY_ZONES_KEY));
    const now = deps.now();
    const todo = (await repo.list())
      .filter((r) => r.state === 'active' && (r.label_at === null || (r.label === null && r.label_at < now - LABEL_RETRY_MS)))
      .filter((r) => zoneAt({ lat: r.lat, lng: r.lng }, zones) === null)
      .slice(0, MAX_GEOCODES_PER_RUN);
    let wrote = false;
    for (let i = 0; i < todo.length; i++) {
      if (i > 0) await later(GEOCODE_GAP_MS);
      if (stopped || gen !== generation) break;
      const r = todo[i]!;
      const label = await spotLabel({ lat: r.lat, lng: r.lng }, zones, geocode);
      if (stopped || gen !== generation) break;
      await repo.setLabel(r.id, label, deps.now());
      wrote = true;
    }
    if (wrote) emitDataChanged({ source: 'spots' }, (e) => report(e, 'spots change'));
  }

  async function run(): Promise<void> {
    if (!ready()) {
      pending = true;
      return;
    }
    const gen = generation;
    const round = asked;
    const now = deps.now();
    const inputs = await readSpotInputs(deps.db, now);
    const drives: SpotDrive[] = [];
    for (let i = 0; i < inputs.drives.length; i += DECODE_CHUNK) {
      if (i > 0) await later(0);
      if (gen !== generation || !ready()) {
        pending = true;
        return;
      }
      for (const d of inputs.drives.slice(i, i + DECODE_CHUNK)) drives.push({ clientTripId: d.clientTripId, startedAt: d.startedAt, runs: decodeRoute(d.polyline) });
    }
    if (gen !== generation || !ready()) {
      pending = true;
      return;
    }
    const rows = detectSpots(drives, inputs.events, now).map(toSpotRow);
    const guard = [...new Set(rows.map((r) => r.last_hit_trip))];
    const ok = await repo.replaceAll(rows, { computedAt: now, drives: inputs.drives.length }, guard);
    if (!ok || gen !== generation) {
      pending = true;
      return;
    }
    if (asked === round) pending = false;
    emitDataChanged({ source: 'spots' }, (e) => report(e, 'spots change'));
    await nameSpots(gen);
  }

  function runNow(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight !== null) {
      again = true;
      return inFlight;
    }
    const p = run()
      .catch((e: unknown) => {
        pending = true;
        report(e, 'spots recompute');
      })
      .finally(() => {
        inFlight = null;
        if (again) {
          again = false;
          if (pending) request();
        }
      });
    inFlight = p;
    return p;
  }

  const offData = onDataChanged((e) => {
    if (e.source === 'spots') return;
    if (e.source === 'wipe') {
      generation += 1;
      cancelTimer();
      pending = true;
      return;
    }
    request();
  });
  const sub = deps.appState.addEventListener('change', (next) => {
    state = next;
    if (next === 'active') {
      if (pending) request();
    } else {
      cancelTimer();
    }
  });
  const offDaily = runWhenForeground('spots', RECOMPUTE_DAILY_MS, () => runNow(), {
    appState: deps.appState,
    now: deps.now,
    db: deps.db,
    onError: (e, ctx) => report(e, ctx),
  });
  request();

  return {
    stop() {
      stopped = true;
      generation += 1;
      cancelTimer();
      offData();
      sub.remove();
      offDaily();
    },
    runNow,
  };
}
