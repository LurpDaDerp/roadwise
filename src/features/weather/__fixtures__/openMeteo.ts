/** Open-Meteo answers for the weather tests. */

export const NOW = 1_792_397_700; // a quarter past the hour
export const H = NOW - 900; // the hour's own stamp

/** One value for each hourly row (H − 6 h … H + 2 h). */
export const rows = <T>(v: T): T[] => Array.from({ length: 9 }, () => v);

/** An Open-Meteo answer, by day: the current quarter hour, and hourly rows from 6 h back to 2 h ahead. */
export function openMeteoBody(over: { current?: Record<string, unknown>; hourly?: Record<string, unknown[]> } = {}) {
  return {
    current: {
      time: NOW,
      interval: 900,
      weather_code: 3,
      temperature_2m: 8.3,
      precipitation: 0,
      rain: 0,
      showers: 0,
      snowfall: 0,
      wind_speed_10m: 4.8,
      wind_gusts_10m: 7.6,
      visibility: 15300,
      is_day: 1,
      ...over.current,
    },
    hourly: {
      time: [-6, -5, -4, -3, -2, -1, 0, 1, 2].map((k) => H + k * 3600),
      weather_code: rows(3),
      temperature_2m: rows(8),
      precipitation: rows(0),
      rain: rows(0),
      showers: rows(0),
      snowfall: rows(0),
      wind_speed_10m: rows(5),
      wind_gusts_10m: rows(9),
      visibility: rows(16000),
      is_day: rows(1),
      ...over.hourly,
    },
  };
}

export const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
