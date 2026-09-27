// The trip's "Camera coaching" card data: a few numbers taken from the local DMS trip summary at the drive's end and
// kept on this phone only (the `settings` table, per trip, the newest KEEP_TRIPS). Nothing here is uploaded: the
// beta's consent says the camera's data stays on the phone, so the trip payload's camera fields stay unset
// (`cameraFocus` null, `camera_session` false). The handover wipe removes these with every other setting.
import type { AlertKind, DmsHostSummary } from '@/core/dms';
import type { SettingsRepo } from '@/data/db/settings';

export const COACHING_KEY_PREFIX = 'camera.coaching.';
export const COACHING_INDEX_KEY = 'camera.coaching.index';
export const KEEP_TRIPS = 30;

export interface CameraCoaching {
  v: 1;
  /** 0–100: the share of the monitored drive the camera tracked the face */
  seenPct: number | null;
  cameraSession: 'good' | 'limited' | 'none';
  glancesOver2s: number;
  longestGlanceS: number | null;
  distractionAlerts: number;
  sleepAlerts: number;
}

const DISTRACTION_KINDS: readonly AlertKind[] = ['distraction', 'cumulative', 'eyes_on_road', 'phone_pattern', 'repeated_glances'];
const SLEEP_KINDS: readonly AlertKind[] = ['microsleep', 'microsleep_nod', 'sleep', 'unresponsive'];

/** Alerts the driver heard (`delivered`: not muted, merged, dropped or suppressed). */
function delivered(summary: DmsHostSummary, kind: AlertKind): number {
  const n = summary.alerts[kind]?.delivered ?? 0;
  return Number.isFinite(n) ? n : 0;
}

/** The card's numbers from the controller's end-of-drive summary; null when the camera never ran. */
export function coachingFrom(summary: DmsHostSummary | null): CameraCoaching | null {
  if (summary === null) return null;
  const s = summary;
  if (s.cameraSession === 'none') return null;
  return {
    v: 1,
    seenPct: s.trackingCoverage === null ? null : Math.round(Math.max(0, Math.min(1, s.trackingCoverage)) * 100),
    cameraSession: s.cameraSession,
    glancesOver2s: s.tier0.nonDrivingGlancesOver2s,
    longestGlanceS: s.longestNonDrivingGlance?.durS ?? null,
    distractionAlerts: DISTRACTION_KINDS.reduce((n, k) => n + delivered(s, k), 0),
    sleepAlerts: SLEEP_KINDS.reduce((n, k) => n + delivered(s, k), 0),
  };
}

export async function saveCoaching(settings: Pick<SettingsRepo, 'get' | 'set' | 'remove'>, tripId: string, c: CameraCoaching): Promise<void> {
  await settings.set(COACHING_KEY_PREFIX + tripId, c);
  const index = (await settings.get<unknown>(COACHING_INDEX_KEY)) as unknown;
  const ids = Array.isArray(index) ? index.filter((x): x is string => typeof x === 'string' && x !== tripId) : [];
  ids.push(tripId);
  while (ids.length > KEEP_TRIPS) {
    const old = ids.shift() as string;
    await settings.remove(COACHING_KEY_PREFIX + old);
  }
  await settings.set(COACHING_INDEX_KEY, ids);
}

/** The trip's card, or null (no camera on that drive, or a malformed record). Never rejects. */
export async function readCoaching(settings: Pick<SettingsRepo, 'get'>, tripId: string): Promise<CameraCoaching | null> {
  try {
    const v = await settings.get<unknown>(COACHING_KEY_PREFIX + tripId);
    if (typeof v !== 'object' || v === null || (v as { v?: unknown }).v !== 1) return null;
    return v as CameraCoaching;
  } catch {
    return null;
  }
}
