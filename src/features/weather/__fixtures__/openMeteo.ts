/** Open-Meteo answers for the weather tests. */

export const NOW = 1_792_397_700; // a quarter past the hour
export const H = NOW - 900; // the hour's own stamp

/** An Open-Meteo answer: the current quarter hour, and hourly rows from 3 h back to 2 h ahead. */
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
      ...over.current,
    },
    hourly: {
      time: [H - 3 * 3600, H - 2 * 3600, H - 3600, H, H + 3600, H + 2 * 3600],
      weather_code: [3, 3, 3, 3, 3, 3],
      temperature_2m: [8, 8, 8, 8, 8, 8],
      precipitation: [0, 0, 0, 0, 0, 0],
      rain: [0, 0, 0, 0, 0, 0],
      showers: [0, 0, 0, 0, 0, 0],
      snowfall: [0, 0, 0, 0, 0, 0],
      wind_speed_10m: [5, 5, 5, 5, 5, 5],
      wind_gusts_10m: [9, 9, 9, 9, 9, 9],
      visibility: [16000, 16000, 16000, 16000, 16000, 16000],
      ...over.hourly,
    },
  };
}

export const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
