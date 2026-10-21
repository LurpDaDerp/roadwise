import { DAY, drive, ev, line, seeded, T0 } from '../__fixtures__/spots';
import { detectSpots } from '../detect';
import type { SpotEvent, SpotKind } from '../types';

/**
 * The worst case the caps allow: 400 drives of 600 points each along one 12 km road, 3 000
 * events over 60 places on it (two of them hot, so the geometry runs too). Node's guard is 1 s; the phone target (≈ 150 ms on a low-end
 * Android) is checked on a device.
 */
test('detectSpots over 400 drives × 600 points and 3 000 events takes under a second', () => {
  const road = line([0, 0], [11_980, 0]);
  expect(road).toHaveLength(600);
  const rnd = seeded(42);
  const kinds: SpotKind[] = ['speeding', 'hard_brake', 'hard_corner', 'hard_accel'];
  const drives = Array.from({ length: 400 }, (_, i) => drive(`d${String(i).padStart(3, '0')}`, i * 0.3, [road]));
  const events: SpotEvent[] = [];
  for (let k = 0; k < 3000; k++) {
    const d = drives[Math.floor(rnd() * drives.length)]!;
    const place = k < 1000 ? k % 2 : 2 + Math.floor(rnd() * 58);
    events.push(ev(`e${String(k).padStart(4, '0')}`, d, kinds[place % 2]!, [100 + place * 195, 0], { startedAt: d.startedAt + k }));
  }
  const now = T0 + 121 * DAY;
  const t0 = Date.now();
  const spots = detectSpots(drives, events, now);
  const ms = Date.now() - t0;
  expect(spots.length).toBeGreaterThan(0);
  expect(ms).toBeLessThan(1000);
});
