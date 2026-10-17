import { CLOCK_SUNRISE_H, readPhase, TWILIGHT_STEP_MS } from '@/ui/sky/phase';
import { sunTimes } from '@/ui/sky/solar';

const SEATTLE = { lat: 47.6062, lng: -122.3321 };
const MIN = 60_000;

describe('readPhase from the sun', () => {
  const day = sunTimes(new Date('2024-03-20T20:00:00Z'), SEATTLE.lat, SEATTLE.lng);
  const at = (d: Date | null, deltaMin: number) => new Date(d!.getTime() + deltaMin * MIN);

  test('night before civil dawn, waking at dawn', () => {
    const r = readPhase(at(day.dawn, -20), SEATTLE);
    expect(r).toMatchObject({ phase: 'night', scheme: 'dark', glow: 0, source: 'sun' });
    expect(Math.abs(r.nextAt - day.dawn!.getTime())).toBeLessThan(1000);
  });

  test('dawn is light and warm, brightest at sunrise, re-read every 10 min', () => {
    const r = readPhase(day.sunrise!, SEATTLE);
    expect(r).toMatchObject({ phase: 'dawn', scheme: 'light', glow: 1 });
    expect(r.nextAt - day.sunrise!.getTime()).toBeCloseTo(TWILIGHT_STEP_MS, -3);
    expect(readPhase(at(day.sunrise, 30), SEATTLE).glow).toBeLessThan(1);
  });

  test('day from 45 min after sunrise until 30 min before sunset', () => {
    expect(readPhase(at(day.sunrise, 46), SEATTLE).phase).toBe('day');
    const noon = readPhase(day.noon, SEATTLE);
    expect(noon).toMatchObject({ phase: 'day', scheme: 'light' });
    expect(Math.abs(noon.nextAt - (day.sunset!.getTime() - 30 * MIN))).toBeLessThan(1000);
  });

  test('dusk is dark and warm, from 30 min before sunset to civil dusk', () => {
    expect(readPhase(at(day.sunset, -29), SEATTLE)).toMatchObject({ phase: 'dusk', scheme: 'dark' });
    expect(readPhase(day.sunset!, SEATTLE).glow).toBe(1);
    expect(readPhase(at(day.dusk, 1), SEATTLE)).toMatchObject({ phase: 'night', scheme: 'dark' });
  });

  test('after dusk the next change is tomorrow’s dawn', () => {
    const r = readPhase(at(day.dusk, 60), SEATTLE);
    const tomorrow = sunTimes(new Date(day.noon.getTime() + 24 * 3600_000), SEATTLE.lat, SEATTLE.lng);
    expect(Math.abs(r.nextAt - tomorrow.dawn!.getTime())).toBeLessThan(MIN);
  });

  test('polar night and midnight sun hold one phase and look again in an hour', () => {
    const t = new Date('2024-12-21T11:00:00Z');
    const r = readPhase(t, { lat: 69.6492, lng: 18.9553 });
    expect(r.phase).toBe('night');
    expect(r.nextAt - t.getTime()).toBe(3600_000);
    expect(readPhase(new Date('2024-06-21T23:00:00Z'), { lat: 69.6492, lng: 18.9553 }).phase).toBe('day');
  });
});

describe('readPhase with no position: the 07:00 / 19:00 clock', () => {
  const local = (h: number, m = 0) => new Date(2026, 9, 17, h, m);

  test.each([
    [3, 0, 'night'],
    [6, 45, 'dawn'],
    [CLOCK_SUNRISE_H, 0, 'dawn'],
    [12, 0, 'day'],
    [18, 45, 'dusk'],
    [19, 45, 'night'],
  ] as const)('%i:%i is %s', (h, m, phase) => {
    const r = readPhase(local(h, m), null);
    expect(r.phase).toBe(phase);
    expect(r.source).toBe('clock');
    expect(r.nextAt).toBeGreaterThan(local(h, m).getTime());
  });
});
