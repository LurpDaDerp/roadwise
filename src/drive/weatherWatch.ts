// The drive's dangerous-weather watch (modes plan §10 A2; the alert of `src/features/weather`).
// While a drive records, in any app state (iOS keeps RoadWise running on location during a drive),
// the weather at the car is checked once as the drive opens, then every 15 min, and again after
// each 20 km of the trip's own odometer, never faster than those. The position is the drive's own
// latest fix, else the phone's last known one (with neither, the first fix makes the check).
// Everything fails silently: no network, a slow answer or a malformed body all mean "no alert". The
// host shows the answer on the driving screen and the iOS Live Activity.
//
// The same reading tags the drive's weather (`driveWeatherOf`: its current conditions only): each
// check that got a reading tells `onTag` its word, so one request feeds both the alert and the tag.
// A check with no reading tags nothing.
import { dangerFrom, type DangerAlert } from '@/features/weather/danger';
import { driveWeatherOf, type DriveWeather } from '@/features/weather/driveWeather';
import { fetchWeather, type WeatherReading } from '@/features/weather/openMeteo';

/** A check every 15 min while the drive records. */
export const WEATHER_REFRESH_MS = 15 * 60_000;
/** …and after each 20 km driven. */
export const WEATHER_REFETCH_DISTANCE_M = 20_000;

/** The alert at a place, or null; never throws. */
export type WeatherLookup = (lat: number, lng: number) => Promise<DangerAlert | null>;

/** The weather reading at a place, or null; never throws. */
export type WeatherReadingLookup = (lat: number, lng: number) => Promise<WeatherReading | null>;

export interface WeatherWatchDeps {
  now(): number;
  /**
   * The reading at a place (default Open-Meteo, `fetchWeather`): the alert (`dangerFrom`) and the
   * tag (`driveWeatherOf`) both come from it.
   */
  read?: WeatherReadingLookup;
  /** An alert-only lookup in place of `read` (no tag then); `read` wins when both are given. */
  lookup?: WeatherLookup;
  /** The phone's cached position, when the drive has no fix of its own yet. */
  lastPosition?: () => Promise<{ lat: number; lng: number } | null>;
  /** Each answer (null: no alert), in order; a stopped watch reports nothing more. */
  onAlert(alert: DangerAlert | null): void;
  /** Each reading's word for the drive's weather (never for a check with no reading), before its alert. */
  onTag?(tag: DriveWeather): void;
}

export interface WeatherWatch {
  /** A drive row: its fix is the position, and the odometer and the clock may make a check due. */
  onRow(row: { gnssValid: boolean; lat: number; lng: number }, distanceM: number): void;
  /** No more checks or answers (the drive ended). */
  stop(): void;
}

/** One watch per drive; the first check goes at once. */
export function createWeatherWatch(deps: WeatherWatchDeps): WeatherWatch {
  const read: WeatherReadingLookup | null = deps.read ?? (deps.lookup === undefined ? fetchWeather : null);
  /** The alert, and the tag when the answer was a reading. */
  async function ask(lat: number, lng: number): Promise<{ alert: DangerAlert | null; tag: DriveWeather | null }> {
    if (read === null) return { alert: await (deps.lookup as WeatherLookup)(lat, lng), tag: null };
    const reading = await read(lat, lng);
    return { alert: dangerFrom(reading), tag: driveWeatherOf(reading) };
  }
  let stopped = false;
  let inFlight = false;
  let lastCheckAt: number | null = null;
  let lastLeg = 0;
  let fix: { lat: number; lng: number } | null = null;

  async function position(): Promise<{ lat: number; lng: number } | null> {
    if (fix !== null) return fix;
    try {
      return (await deps.lastPosition?.()) ?? null;
    } catch {
      return null;
    }
  }

  function check(): void {
    if (stopped || inFlight) return;
    inFlight = true;
    lastCheckAt = deps.now();
    void (async () => {
      let alert: DangerAlert | null = null;
      let tag: DriveWeather | null = null;
      let at: { lat: number; lng: number } | null = null;
      try {
        at = await position();
        if (at !== null) ({ alert, tag } = await ask(at.lat, at.lng));
      } catch {
        alert = null;
        tag = null;
      } finally {
        inFlight = false;
      }
      // With no position yet the check waits for the drive's first fix.
      if (at === null) {
        lastCheckAt = null;
        return;
      }
      if (stopped) return;
      if (tag !== null) {
        try {
          deps.onTag?.(tag);
        } catch {
          // The tag is a nicety: the alert still goes out.
        }
      }
      deps.onAlert(alert);
    })();
  }

  check();

  return {
    onRow(row, distanceM) {
      if (stopped) return;
      if (row.gnssValid && Number.isFinite(row.lat) && Number.isFinite(row.lng)) fix = { lat: row.lat, lng: row.lng };
      const leg = Math.floor(Math.max(0, distanceM) / WEATHER_REFETCH_DISTANCE_M);
      const now = deps.now();
      const dueByTime = lastCheckAt === null || now - lastCheckAt >= WEATHER_REFRESH_MS;
      const dueByDistance = leg > lastLeg;
      if (!dueByTime && !dueByDistance) return;
      if (inFlight) return;
      lastLeg = leg;
      check();
    },
    stop() {
      stopped = true;
    },
  };
}
