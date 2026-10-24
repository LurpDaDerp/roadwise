import { conditionsFrom } from '../conditions';
import type { WeatherSample } from '../openMeteo';

const sample = (over: Partial<WeatherSample> = {}): WeatherSample => ({
  time: 0,
  code: 3,
  tempC: 20,
  rainMmH: 0,
  precipMmH: 0,
  snowCmH: 0,
  windMph: 0,
  gustMph: 0,
  visibilityM: 10000,
  isDay: true,
  ...over,
});

describe('conditionsFrom', () => {
  test('whole degrees Fahrenheit from the Celsius reading', () => {
    expect(conditionsFrom(sample({ tempC: 20 }))?.tempF).toBe(68);
    expect(conditionsFrom(sample({ tempC: 21.7 }))?.tempF).toBe(71);
    expect(conditionsFrom(sample({ tempC: 0 }))?.tempF).toBe(32);
    expect(conditionsFrom(sample({ tempC: -10 }))?.tempF).toBe(14);
  });

  test('the sky in words, by day and by night', () => {
    expect(conditionsFrom(sample({ code: 0, isDay: true }))).toMatchObject({ label: 'Sunny', icon: 'sunny' });
    expect(conditionsFrom(sample({ code: 0, isDay: false }))).toMatchObject({ label: 'Clear', icon: 'moon' });
    expect(conditionsFrom(sample({ code: 2, isDay: true }))).toMatchObject({ label: 'Partly cloudy', icon: 'partly-sunny' });
    expect(conditionsFrom(sample({ code: 2, isDay: false }))).toMatchObject({ label: 'Partly cloudy', icon: 'cloudy-night' });
    expect(conditionsFrom(sample({ code: 3 }))).toMatchObject({ label: 'Cloudy', icon: 'cloud' });
    expect(conditionsFrom(sample({ code: 53 }))).toMatchObject({ label: 'Drizzle', icon: 'rainy' });
    expect(conditionsFrom(sample({ code: 65 }))).toMatchObject({ label: 'Heavy rain', icon: 'rainy' });
    expect(conditionsFrom(sample({ code: 75 }))).toMatchObject({ label: 'Heavy snow', icon: 'snow' });
    expect(conditionsFrom(sample({ code: 95 }))).toMatchObject({ label: 'Thunderstorm', icon: 'thunderstorm' });
  });

  test('an unknown day / night reads as day', () => {
    expect(conditionsFrom(sample({ code: 0, isDay: null }))?.label).toBe('Sunny');
  });

  test('every label is one to three words and every icon has a colour', () => {
    const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
    for (const code of codes) {
      for (const isDay of [true, false]) {
        const c = conditionsFrom(sample({ code, isDay }));
        expect(c).not.toBeNull();
        expect(c!.label.split(' ').length).toBeLessThanOrEqual(3);
        expect(c!.color).toMatch(/^#[0-9A-F]{6}$/i);
      }
    }
  });

  test('nothing without a weather code (or one it has no words for) or a temperature', () => {
    expect(conditionsFrom(undefined)).toBeNull();
    expect(conditionsFrom(sample({ code: null }))).toBeNull();
    expect(conditionsFrom(sample({ code: 42 }))).toBeNull();
    expect(conditionsFrom(sample({ tempC: null }))).toBeNull();
  });
});
