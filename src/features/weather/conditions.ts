/**
 * The weather now, as Home's drive card shows it: a temperature in °F, a coloured icon and one to
 * three words for the sky. It reads the same Open-Meteo answer the dangerous-weather alerts do (the
 * first sample, `current`), so it costs no request of its own.
 */
import type { IconName } from '@/ui';

import type { WeatherSample } from './openMeteo';

export type Conditions = {
  /** Whole degrees Fahrenheit. */
  tempF: number;
  /** One to three words: "Sunny", "Partly cloudy", "Heavy rain". */
  label: string;
  icon: IconName;
  /** The icon's colour, light enough to read on the drive card's dark scene. */
  color: string;
};

const SUN = '#FFC53D';
const MOON = '#C7D2FE';
const CLOUD = '#C3CEDD';
const RAIN = '#5EB1FF';
const SNOW = '#BDE9FF';
const STORM = '#FFD84D';
const FOG = '#AAB5C3';

type Look = Pick<Conditions, 'label' | 'icon' | 'color'>;

/** WMO weather interpretation codes (Open-Meteo's `weather_code`) in words, by day or night. */
function lookOf(code: number, day: boolean): Look | null {
  switch (code) {
    case 0:
      return day ? { label: 'Sunny', icon: 'sunny', color: SUN } : { label: 'Clear', icon: 'moon', color: MOON };
    case 1:
      return day ? { label: 'Mostly sunny', icon: 'sunny', color: SUN } : { label: 'Mostly clear', icon: 'moon', color: MOON };
    case 2:
      return { label: 'Partly cloudy', icon: day ? 'partly-sunny' : 'cloudy-night', color: day ? SUN : MOON };
    case 3:
      return { label: 'Cloudy', icon: 'cloud', color: CLOUD };
    case 45:
      return { label: 'Fog', icon: 'cloud', color: FOG };
    case 48:
      return { label: 'Freezing fog', icon: 'cloud', color: FOG };
    case 51:
      return { label: 'Light drizzle', icon: 'rainy', color: RAIN };
    case 53:
      return { label: 'Drizzle', icon: 'rainy', color: RAIN };
    case 55:
      return { label: 'Heavy drizzle', icon: 'rainy', color: RAIN };
    case 56:
    case 57:
      return { label: 'Freezing drizzle', icon: 'rainy', color: SNOW };
    case 61:
      return { label: 'Light rain', icon: 'rainy', color: RAIN };
    case 63:
      return { label: 'Rain', icon: 'rainy', color: RAIN };
    case 65:
      return { label: 'Heavy rain', icon: 'rainy', color: RAIN };
    case 66:
    case 67:
      return { label: 'Freezing rain', icon: 'rainy', color: SNOW };
    case 71:
      return { label: 'Light snow', icon: 'snow', color: SNOW };
    case 73:
      return { label: 'Snow', icon: 'snow', color: SNOW };
    case 75:
      return { label: 'Heavy snow', icon: 'snow', color: SNOW };
    case 77:
      return { label: 'Snow grains', icon: 'snow', color: SNOW };
    case 80:
      return { label: 'Light showers', icon: 'rainy', color: RAIN };
    case 81:
      return { label: 'Showers', icon: 'rainy', color: RAIN };
    case 82:
      return { label: 'Heavy showers', icon: 'rainy', color: RAIN };
    case 85:
      return { label: 'Snow showers', icon: 'snow', color: SNOW };
    case 86:
      return { label: 'Heavy snow showers', icon: 'snow', color: SNOW };
    case 95:
      return { label: 'Thunderstorm', icon: 'thunderstorm', color: STORM };
    case 96:
      return { label: 'Storm with hail', icon: 'thunderstorm', color: STORM };
    case 99:
      return { label: 'Severe hailstorm', icon: 'thunderstorm', color: STORM };
    default:
      return null;
  }
}

/** The conditions in a sample, or null when it lacks the weather code or the temperature. */
export function conditionsFrom(sample: WeatherSample | undefined): Conditions | null {
  if (!sample || sample.code === null || sample.tempC === null) return null;
  // `is_day` missing reads as day: the sun is the likelier icon.
  const look = lookOf(sample.code, sample.isDay !== false);
  if (!look) return null;
  return { tempF: Math.round((sample.tempC * 9) / 5 + 32), ...look };
}
