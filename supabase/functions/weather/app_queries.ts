// The four Open-Meteo queries the app sends, for one place (47.6, -122.3). The relay accepts these
// shapes and nothing else (any one-decimal position), so every relayed call costs what the app's
// own calls cost (`MAX_CALL_COST` in handler.ts, measured from Open-Meteo's X-RateLimit-Cost).
// Plain data with no imports: the edge function and the app's Jest suite
// (src/features/weather/__tests__/transport.test.ts) both read it, so a change to one of the app's
// URL builders fails a test until this list (and the relay) learns it.
const VARS = 'weather_code,temperature_2m,precipitation,rain,showers,snowfall,wind_speed_10m,wind_gusts_10m,visibility,is_day';

export const APP_QUERY_PLACE = { latitude: '47.6', longitude: '-122.3' } as const;

export const APP_QUERIES = {
  /** The sky (src/ui/sky/weather.ts openMeteoUrl). Cost 1. */
  sky: 'latitude=47.6&longitude=-122.3&current=weather_code,is_day,cloud_cover,precipitation',
  /** Home and the alerts (src/features/weather/openMeteo.ts weatherUrl). Cost 2. */
  home: `latitude=47.6&longitude=-122.3&current=${VARS}&hourly=${VARS}&past_hours=6&forecast_hours=3&wind_speed_unit=mph&timeformat=unixtime`,
  /** The drive's series (src/features/weather/roadSeries.ts roadSeriesUrl). Cost 2. */
  series:
    `latitude=47.6&longitude=-122.3&minutely_15=${VARS}&hourly=${VARS}` +
    '&past_minutely_15=28&forecast_minutely_15=8&past_hours=6&forecast_hours=5&wind_speed_unit=mph&timeformat=unixtime',
  /** The commute heads-up (src/features/weather/forecast.ts forecastUrl). Cost 1. */
  forecast: `latitude=47.6&longitude=-122.3&hourly=${VARS}&past_hours=6&forecast_hours=24&wind_speed_unit=mph&timeformat=unixtime`,
} as const;
