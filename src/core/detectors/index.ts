import type { Detector, DetectorSuite } from '../engine/types';
import { createHarshDetector } from './harsh';
import { createPhoneUseDetector } from './phoneUse';
import { createSpeedingDetector } from './speeding';
import { createWeatherSpeedingWatch } from './weatherSpeeding';

export { createHarshDetector, type HarshDetector } from './harsh';
export { createPhoneUseDetector, type PhoneUseDetector } from './phoneUse';
export { createSpeedingDetector, type SpeedingDetector } from './speeding';
export { createWeatherSpeedingWatch, type WeatherSpeedingWatch } from './weatherSpeeding';

/**
 * Every detector behind one `push`/`flush`: speeding, the hard brakes, starts and turns, and phone
 * pickups. `push` returns the events that closed on that row; `flush` closes whatever is still open
 * at trip end.
 *
 * Beside them, alert-only, the weather warnings: the weather "Slow down" (`weatherSpeeding.ts`) and
 * a second harsh detector at the grip's lines (`HarshOptions.weather`). They see the same rows but
 * share no state with the scoring detectors and return no events, so the events are the same
 * whatever the road state on the rows.
 */
export function createDetectors(newId: () => string): DetectorSuite {
  const speeding = createSpeedingDetector(newId);
  const harsh = createHarshDetector(newId);
  const phone = createPhoneUseDetector(newId);
  const detectors: Detector[] = [speeding, harsh, phone];
  const weatherHarsh = createHarshDetector(newId, { weather: true });
  const weatherSpeeding = createWeatherSpeedingWatch();
  return {
    push: (row, limit, ctx) => {
      const closed = detectors.flatMap((d) => d.push(row, limit, ctx));
      weatherHarsh.push(row, limit, ctx);
      weatherSpeeding.push(row, limit);
      return closed;
    },
    flush: () => {
      weatherHarsh.flush();
      weatherSpeeding.flush();
      return detectors.flatMap((d) => d.flush());
    },
    openSpeeding: () => speeding.open(),
    speedingNow: () => speeding.reading(),
    speedingEpisode: () => speeding.episode(),
    harshAlerts: () => harsh.alerts(),
    weatherHarshAlerts: () => weatherHarsh.alerts(),
    weatherSpeeding: () => weatherSpeeding.stretch(),
    phoneAlerts: () => phone.alerts(),
    unsafe: () => speeding.active(),
  };
}
