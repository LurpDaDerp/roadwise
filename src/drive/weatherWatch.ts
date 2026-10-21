// The drive's dangerous-weather watch (modes plan §10 A2; the alert of `src/features/weather`).
// While a drive records, in any app state (iOS keeps RoadWise running on location during a drive),
// the weather at the car is checked once as the drive opens, then every 15 min, and again after
// each 20 km of the trip's own odometer, never faster than those. The position is the drive's own
// latest fix, else the phone's last known one. Everything fails silently: no position, no network,
// a slow answer or a malformed body all mean "no alert". The host shows the answer on the driving
// screen and the iOS Live Activity.
import { dangerFrom, type DangerAlert } from '@/features/weather/danger';
import { fetchWeather } from '@/features/weather/openMeteo';

/** A check every 15 min while the drive records. */
export const WEATHER_REFRESH_MS = 15 * 60_000;
/** …and after each 20 km driven. */
export const WEATHER_REFETCH_DISTANCE_M = 20_000;

/** The alert at a place, or null; never throws. */
export type WeatherLookup = (lat: number, lng: number) => Promise<DangerAlert | null>;

/** Open-Meteo at the place (rounded to about 10 km there), judged by `dangerFrom`. */
export const openMeteoLookup: WeatherLookup = async (lat, lng) => {
  try {
    return dangerFrom(await fetchWeather(lat, lng));
  } catch {
    return null;
  }
};

export interface WeatherWatchDeps {
  now(): number;
  lookup?: WeatherLookup;
  /** The phone's cached position, when the drive has no fix of its own yet. */
  lastPosition?: () => Promise<{ lat: number; lng: number } | null>;
  /** Each answer (null: no alert), in order; a stopped watch reports nothing more. */
  onAlert(alert: DangerAlert | null): void;
}

export interface WeatherWatch {
  /** A drive row: its fix is the position, and the odometer and the clock may make a check due. */
  onRow(row: { gnssValid: boolean; lat: number; lng: number }, distanceM: number): void;
  /** No more checks or answers (the drive ended). */
  stop(): void;
}

/** One watch per drive; the first check goes at once. */
export function createWeatherWatch(deps: WeatherWatchDeps): WeatherWatch {
  const lookup = deps.lookup ?? openMeteoLookup;
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
      try {
        const at = await position();
        alert = at === null ? null : await lookup(at.lat, at.lng);
      } catch {
        alert = null;
      } finally {
        inFlight = false;
      }
      if (!stopped) deps.onAlert(alert);
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
