// Weather → driving-condition helpers (moved out of DriveScreen).

const weatherCodeMap = {
  0: { label: 'Clear sky', icon: 'weather-sunny' },
  1: { label: 'Mostly clear', icon: 'weather-sunny' },
  2: { label: 'Partly cloudy', icon: 'weather-partly-cloudy' },
  3: { label: 'Overcast', icon: 'weather-cloudy' },
  45: { label: 'Fog', icon: 'weather-fog' },
  48: { label: 'Rime fog', icon: 'weather-fog' },
  51: { label: 'Light drizzle', icon: 'weather-rainy' },
  53: { label: 'Drizzle', icon: 'weather-rainy' },
  55: { label: 'Dense drizzle', icon: 'weather-rainy' },
  61: { label: 'Light rain', icon: 'weather-pouring' },
  63: { label: 'Rain', icon: 'weather-pouring' },
  65: { label: 'Heavy rain', icon: 'weather-pouring' },
  71: { label: 'Light snow', icon: 'weather-snowy' },
  73: { label: 'Snow', icon: 'weather-snowy' },
  75: { label: 'Heavy snow', icon: 'weather-snowy' },
  80: { label: 'Rain showers', icon: 'weather-rainy' },
  81: { label: 'Rain showers', icon: 'weather-rainy' },
  82: { label: 'Heavy showers', icon: 'weather-rainy' },
  95: { label: 'Thunderstorm', icon: 'weather-lightning' },
  96: { label: 'Thunderstorm, hail', icon: 'weather-lightning' },
  99: { label: 'Thunderstorm, hail', icon: 'weather-lightning' },
};

export function getWeatherInfo(code) {
  return weatherCodeMap[code] || { label: 'Unknown', icon: 'weather-cloudy-alert' };
}

export function isRoadSlippery(weather) {
  const c = weather?.current;
  if (!c) return false;
  const tempF = c.temperature_2m;
  const precip = c.precipitation;
  const code = c.weathercode;
  if (tempF <= 32 && precip > 0) return true;
  if ([71, 73, 75].includes(code)) return true;
  if (precip > 0.4) return true;
  return false;
}

// Whether conditions changed enough to ask for a new road summary.
export function hasSignificantChange(prev, curr) {
  if (!prev) return true;
  const visChange = Math.abs((curr.visibility - prev.visibility) / 1609);
  const precipChange = Math.abs(curr.precipitation - prev.precipitation);
  const chanceChange = Math.abs(curr.precipitation_probability - prev.precipitation_probability);
  return (
    (visChange > 0.5 && prev.visibility / 1609 <= 2.5) ||
    (visChange > 1 && prev.visibility / 1609 <= 5) ||
    (visChange > 5 && prev.visibility / 1609 <= 25) ||
    (visChange > 10 && prev.visibility / 1609 > 25) ||
    precipChange > 0.05 ||
    chanceChange > 10 ||
    !!curr.slippery !== !!prev.slippery
  );
}

// Local fallback summary when the AI summary is unavailable: 2–5 words + 1..5 score.
export function localRoadSummary(weather) {
  const c = weather?.current;
  if (!c) return null;
  const info = getWeatherInfo(c.weathercode);
  const visMi = (Number(c.visibility) || 20000) / 1609;
  const precip = Number(c.precipitation) || 0;
  if (isRoadSlippery(weather)) return { summary: 'Slippery roads, slow down', score: 2 };
  if (visMi < 0.5) return { summary: 'Very low visibility', score: 2 };
  if (visMi < 1.5) return { summary: 'Low visibility', score: 3 };
  if (precip > 0.1) return { summary: `${info.label}, wet roads`, score: 3 };
  if ([2, 3].includes(c.weathercode)) return { summary: `${info.label}, roads dry`, score: 5 };
  return { summary: `${info.label}, good conditions`, score: 5 };
}

// 1..5 road score → severity level for the shared colour scale.
export function roadScoreToTone(score) {
  switch (Number(score)) {
    case 5: return 'success';
    case 4: return 'success';
    case 3: return 'warning';
    case 2: return 'danger';
    case 1: return 'danger';
    default: return 'neutral';
  }
}

export function roadScoreIcon(score) {
  switch (Number(score)) {
    case 5: return 'shield-check';
    case 4: return 'shield-check-outline';
    case 3: return 'alert-outline';
    case 2: return 'alert';
    case 1: return 'alert-octagon';
    default: return 'help-circle-outline';
  }
}
