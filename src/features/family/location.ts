/**
 * Posting this phone's location to the family (0012 `post_my_location`), battery-first:
 *
 * - **No new tracking.** Nothing here starts GPS, a sensor or a timer. It listens to what the drive
 *   already produces (drive-sense `row`s while a drive records), to the OS wakes drive-sense already
 *   receives (`wake`: significant change on iOS, activity transitions on Android), and to the app
 *   coming to the front; for a wake or the front it reads the OS's last known fix, which costs no GPS.
 * - **At most once a minute** (`MIN_POST_INTERVAL_MS`), from any of the three.
 * - **Nothing while stationary:** a drive row under walking pace, or a wake/front fix within
 *   `MIN_MOVE_M` of the last posted one, posts nothing.
 * - **Nothing while sharing is off**, or signed out, or for another account: every attempt first
 *   reads the local sharing record (`family.sharing`, written by the Family screen from the server's
 *   answer) and the session's uid (`session.uid`), both from the phone's own database.
 * - **Nothing without pd-2:** every post needs this account's affirmation of the background-location
 *   disclosure that names family sharing (`familyDisclosureAccepted`). The server checks the same
 *   consent and refuses the post without it.
 *
 * The server rate-limits too (20 s), and refuses a post while sharing is off; that refusal turns the
 * local record off so the phone stops trying.
 */
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';
import { SESSION_UID_KEY } from '@/data/sync/queue';
import { haversineMeters } from '@/lib/geo';

import { defaultFamilyApi, FamilyError, type FamilyApi, type LocationInput } from './api';
import { familyDisclosureAccepted } from './disclosure';

export const MIN_POST_INTERVAL_MS = 60_000;
/** A wake or front fix this close to the last posted one is "still here": nothing is posted. */
export const MIN_MOVE_M = 100;
/** Under this a drive row is stationary (m/s, walking pace). */
export const MOVING_MPS = 1;
/** A fix looser than this says too little to share (metres). */
export const MAX_ACCURACY_M = 200;
/** The OS's last known fix is used only while it is this fresh. */
export const LAST_KNOWN_MAX_AGE_MS = 10 * 60_000;

export const FAMILY_SHARING_KEY = 'family.sharing';

interface SharingRecord {
  uid: string;
  on: boolean;
}

/** The Family screen's record of whether this account shares, from the server's latest answer. */
export async function writeSharingRecord(db: Db, uid: string, on: boolean): Promise<void> {
  await createSettingsRepo(db).set(FAMILY_SHARING_KEY, { uid, on });
}

/** Sharing is on for the signed-in account, and it has accepted pd-2. */
async function mayPost(db: Db): Promise<boolean> {
  const settings = createSettingsRepo(db);
  const [record, uid] = await Promise.all([
    settings.get<SharingRecord>(FAMILY_SHARING_KEY),
    settings.get<string>(SESSION_UID_KEY),
  ]);
  const on =
    typeof uid === 'string' &&
    record !== null &&
    typeof record === 'object' &&
    record.on === true &&
    record.uid === uid;
  return on && (await familyDisclosureAccepted(db, uid));
}

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number;
}

/** The subset of drive-sense this listens to. */
export interface LocationSource {
  addListener(event: 'row' | 'wake', fn: (payload: unknown) => void): { remove(): void };
}

export interface FamilyLocationDeps {
  db: Db;
  source: LocationSource;
  /** Whether a drive is recording right now (`DriveHost.snapshot().status`). */
  recording: () => boolean;
  appState: AppStateLike;
  now: () => number;
  /** The OS's last known fix, no GPS (expo-location `getLastKnownPositionAsync`). */
  lastKnown: () => Promise<Fix | null>;
  api?: Pick<FamilyApi, 'postLocation'>;
  onError?: (error: unknown, context: string) => void;
}

/** A usable fix out of a drive-sense row (the native row's fields; an invalid fix posts nothing). */
function rowFix(raw: unknown): (Fix & { speed: number }) | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { lat, lng, hAcc, speed } = raw as Record<string, unknown>;
  if (typeof lat !== 'number' || typeof lng !== 'number' || typeof hAcc !== 'number' || typeof speed !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng, accuracyM: hAcc, speed };
}

export interface FamilyLocationPoster {
  detach(): void;
  /** Resolves once any post in flight has finished (tests, orderly shutdown). */
  settled(): Promise<void>;
}

export function attachFamilyLocation(deps: FamilyLocationDeps): FamilyLocationPoster {
  const api = deps.api ?? defaultFamilyApi;
  let lastPostAt = Number.NEGATIVE_INFINITY;
  let lastPosted: Fix | null = null;
  let inflight: Promise<void> | null = null;
  let live = true;

  const post = (fix: Fix, driving: boolean, context: string) => {
    if (!live || inflight !== null) return;
    if (fix.accuracyM < 0 || fix.accuracyM > MAX_ACCURACY_M) return;
    const now = deps.now();
    if (now - lastPostAt < MIN_POST_INTERVAL_MS && now >= lastPostAt) return;
    // Claimed before the reads, so two events in the same tick make one post.
    lastPostAt = now;
    inflight = (async () => {
      try {
        if (!(await mayPost(deps.db))) return;
        const input: LocationInput = { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, driving };
        await api.postLocation(input);
        lastPosted = fix;
      } catch (error) {
        if (error instanceof FamilyError && error.code === 'sharing_off') {
          const uid = await createSettingsRepo(deps.db).get<string>(SESSION_UID_KEY);
          if (typeof uid === 'string') await writeSharingRecord(deps.db, uid, false).catch(() => undefined);
          return;
        }
        // The server has no pd-2 consent yet (recorded offline, still owed): not an error to report.
        if (error instanceof FamilyError && error.code === 'disclosure_required') return;
        deps.onError?.(error, `family location (${context})`);
      } finally {
        inflight = null;
      }
    })();
  };

  /** A wake or the front: the OS's last fix, only when it has moved since the last post. */
  const fromLastKnown = (context: string) => {
    if (!live || inflight !== null) return;
    if (deps.now() - lastPostAt < MIN_POST_INTERVAL_MS && deps.now() >= lastPostAt) return;
    void deps
      .lastKnown()
      .then((fix) => {
        if (fix === null) return;
        if (lastPosted !== null && haversineMeters(lastPosted, fix) < MIN_MOVE_M) return;
        post(fix, false, context);
      })
      .catch((error: unknown) => deps.onError?.(error, `family location (${context})`));
  };

  const rows = deps.source.addListener('row', (raw) => {
    if (!deps.recording()) return;
    const fix = rowFix(raw);
    if (fix === null || fix.speed < MOVING_MPS) return;
    post(fix, true, 'drive');
  });
  const wakes = deps.source.addListener('wake', () => fromLastKnown('wake'));
  const front = deps.appState.addEventListener('change', (state) => {
    if (state === 'active') fromLastKnown('front');
  });

  return {
    detach() {
      live = false;
      rows.remove();
      wakes.remove();
      front.remove();
    },
    settled: async () => {
      await inflight;
    },
  };
}

/** The OS's last known fix through expo-location (no GPS is started). */
export async function expoLastKnown(): Promise<Fix | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a native module, only when used
  const Location = require('expo-location') as typeof import('expo-location');
  const pos = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS });
  if (pos === null) return null;
  return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? MAX_ACCURACY_M + 1 };
}
