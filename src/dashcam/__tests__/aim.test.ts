/**
 * The aiming screen's reading of AIM frames: the border's three colours per scheme, the ramp's
 * contrast on the app's backgrounds, the colour equal to what Reanimated draws, the good latch, every
 * hint line with the mirror's swap, and when a screen reader hears them.
 */
import { interpolateColor } from 'react-native-reanimated';

import { contrastRatio } from '@/ui/contrast';

import {
  AIM_INPUT,
  AIM_STOPS,
  aimColor,
  aimLevel,
  aimLine,
  createAimAnnouncer,
  createGoodLatch,
  hintText,
  type AimScheme,
} from '../aim';
import { dashpalCopy } from '../copy';

const aim = dashpalCopy.wizard.aim;
const ramp = Array.from({ length: 101 }, (_, i) => i / 100);

function rgbaHex(c: string | number): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(c));
  if (!m) throw new Error(`not an rgba colour: ${String(c)}`);
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

describe('the border colour', () => {
  it.each(['light', 'dark'] as const)('%s: the three stops exactly at 0.20, 0.55 and 0.90, clamped beyond', (scheme) => {
    const [bad, mid, good] = AIM_STOPS[scheme];
    expect(aimColor(0, scheme)).toBe(bad.toLowerCase());
    expect(aimColor(0.2, scheme)).toBe(bad.toLowerCase());
    expect(aimColor(0.55, scheme)).toBe(mid.toLowerCase());
    expect(aimColor(0.9, scheme)).toBe(good.toLowerCase());
    expect(aimColor(1, scheme)).toBe(good.toLowerCase());
    expect(aimColor(Number.NaN, scheme)).toBe(bad.toLowerCase());
  });

  it('the stops are the designed ones', () => {
    expect(AIM_STOPS.light).toEqual(['#B93C00', '#7F6356', '#007585']);
    expect(AIM_STOPS.dark).toEqual(['#FF9152', '#BBB6A0', '#3CCFE0']);
    expect(AIM_INPUT).toEqual([0.2, 0.55, 0.9]);
  });

  it.each(['light', 'dark'] as const)('%s: equals Reanimated’s interpolateColor over 101 points', (scheme: AimScheme) => {
    for (const s of ramp) expect(aimColor(s, scheme)).toBe(rgbaHex(interpolateColor(s, [...AIM_INPUT], [...AIM_STOPS[scheme]])));
  });

  it('light: every point of the ramp has 4.5:1 or more on #FFFFFF and #EEF3F9', () => {
    for (const s of ramp) {
      const c = aimColor(s, 'light');
      expect(contrastRatio(c, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c, '#EEF3F9')).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('dark: every point of the ramp has 7:1 or more on #000000, #000814 and #001D3D', () => {
    for (const s of ramp) {
      const c = aimColor(s, 'dark');
      for (const bg of ['#000000', '#000814', '#001D3D']) expect(contrastRatio(c, bg)).toBeGreaterThanOrEqual(7);
    }
  });

  it('the score byte is a level of 0..1, above 100 counting as 100', () => {
    expect(aimLevel(0)).toBe(0);
    expect(aimLevel(90)).toBe(0.9);
    expect(aimLevel(100)).toBe(1);
    expect(aimLevel(255)).toBe(1);
  });
});

describe('the good latch', () => {
  /** AIMs every 200 ms from `t0`. */
  function feed(l: ReturnType<typeof createGoodLatch>, scores: number[], t0 = 0): boolean[] {
    return scores.map((s, i) => l.push(s, t0 + i * 200));
  }

  it('comes on once every score for 1 s is 90 or more', () => {
    const l = createGoodLatch();
    expect(feed(l, [90, 95, 92, 99, 90])).toEqual([false, false, false, false, false]);
    expect(l.push(91, 1000)).toBe(true);
  });

  it('a score under 90 inside the second starts it again', () => {
    const l = createGoodLatch();
    feed(l, [95, 95, 95, 89, 95, 95, 95, 95, 95]);
    expect(l.good()).toBe(false);
    expect(l.push(95, 1800)).toBe(true);
  });

  it('goes off only once every score for 0.5 s is under 80; one low score, or scores of 80-89, keep it', () => {
    const l = createGoodLatch();
    feed(l, [95, 95, 95, 95, 95, 95]);
    expect(l.good()).toBe(true);
    expect(feed(l, [70, 95, 85, 85, 85, 85, 85, 85], 1200).every(Boolean)).toBe(true);
    // Under 80 from 2.8 s: still on at 3.2 s (0.4 s), off at 3.4 s (0.6 s).
    expect(feed(l, [79, 70, 60, 60], 2800)).toEqual([true, true, true, false]);
  });

  it('a missing reading clears it', () => {
    const l = createGoodLatch();
    feed(l, [95, 95, 95, 95, 95, 95]);
    expect(l.push(null, 1200)).toBe(false);
    expect(l.push(95, 1400)).toBe(false);
  });

  it('a byte above 100 counts as 100', () => {
    const l = createGoodLatch();
    feed(l, [200, 200, 200, 200, 200, 200]);
    expect(l.good()).toBe(true);
  });
});

describe('the hint line', () => {
  it('every hint has its line; the picture’s left and right swap for the mirror; the camera’s sides do not', () => {
    expect(hintText(0)).toBe('Good position. Sit as you drive, look at the road, then tap Next.');
    expect(hintText(1)).toBe('Can’t see your face. Point DashPal at your face.');
    // DashPal's EDGE_LEFT (2): the face is at the left of its picture, the right of the mirror.
    expect(hintText(2)).toBe(aim.hint[3]);
    expect(hintText(2)).toContain('right edge');
    expect(hintText(3)).toBe(aim.hint[2]);
    expect(hintText(3)).toContain('left edge');
    expect(hintText(4)).toBe('Your face is near the top of the picture. Tilt DashPal up a little.');
    expect(hintText(5)).toBe('Your chin is near the bottom of the picture. Tilt DashPal down a little.');
    expect(hintText(6)).toBe('DashPal is too close. Move it farther from your face.');
    expect(hintText(7)).toBe('DashPal is too far away. Move it closer to you.');
    expect(hintText(8)).toBe('DashPal is too far to your right. Move it closer to straight in front of you.');
    expect(hintText(9)).toBe('DashPal is too far to your left. Move it closer to straight in front of you.');
    expect(hintText(10)).toBe('DashPal is mounted too high. Move it lower, nearer your eye level.');
    expect(hintText(11)).toBe('DashPal is mounted too low. Move it a little higher.');
    expect(hintText(12)).toBe('DashPal is tilted. Straighten it.');
    expect(hintText(13)).toBe('It’s too dark to see your face well. Add some light.');
    for (const unknown of [14, 99, 255]) expect(hintText(unknown)).toBe('Adjust DashPal until the frame shows Good position.');
  });

  it('no fresh AIM reads “Waiting for the picture…”', () => {
    expect(aimLine(null)).toBe('Waiting for the picture…');
    expect(aimLine({ type: 'AIM', seq: 1, score: 40, hint: 6, flags: 3, iod: 80, yaw: 0, pitch: 0 })).toBe(hintText(6));
  });
});

describe('what a screen reader hears', () => {
  it('a changed line once it has held 1 s, at most every 2 s; entering good at once', () => {
    const a = createAimAnnouncer();
    const A = hintText(6);
    const B = hintText(7);
    expect(a.next(A, false, 0)).toBeNull();
    expect(a.next(A, false, 900)).toBeNull();
    expect(a.next(A, false, 1000)).toBe(A);
    expect(a.next(A, false, 5000)).toBeNull(); // said already
    expect(a.next(B, false, 5200)).toBeNull();
    expect(a.next(B, false, 6200)).toBe(B);
    // A flips back and holds 1 s, but only 1.2 s after B was said: it waits for the 2 s.
    expect(a.next(A, false, 6400)).toBeNull();
    expect(a.next(A, false, 7400)).toBeNull();
    expect(a.next(A, false, 8200)).toBe(A);
    // Entering good is said at once, whatever was said just before.
    expect(a.next(hintText(0), true, 8300)).toBe('Good position');
  });

  it('a line that flickers is never said', () => {
    const a = createAimAnnouncer();
    const said: (string | null)[] = [];
    for (let t = 0; t < 10_000; t += 200) said.push(a.next(hintText(t % 400 === 0 ? 2 : 3), false, t));
    expect(said.filter(Boolean)).toEqual([]);
  });
});
