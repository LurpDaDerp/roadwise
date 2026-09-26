// Task C9 (T9; review-C9): S-2H-MANY-DISPLAY. The drive and its stated synth setup are longDrive.test.ts's.
import type { AnglePair } from '../../engine/types';
import { check, FULL, type Case } from '../__fixtures__/longDrive';

describe('S-2H-MANY-DISPLAY (review-C9; NC-T9-T): a display watched 20–40 % never accumulates bias', () => {
  const displays: [AnglePair, number][] = [
    [{ yaw: 7, pitch: -1 }, 0.2],
    [{ yaw: 14, pitch: -8 }, 0.2],
    [{ yaw: 16, pitch: -4 }, 0.2],
    [{ yaw: 14, pitch: -8 }, 0.4],
  ];
  const all: Case[] = displays.flatMap(([at, share]) => [1, 2, 3].flatMap((seed) => [8, 15].map((fps) => ({ name: `(${at.yaw}°, ${at.pitch}°) ${share * 100} %`, seed, fps, share, at, settleS: at.yaw === 7 && seed === 1 && fps === 8 ? 95 : 90 }))));
  const cases = FULL ? all : all.filter((c) => c.seed === 1 && c.fps === 8 && c.share === 0.4);
  test.each(cases)('$name, plan $seed, $fps fps: the bias ≤ 2° outside the $settleS s after each step; 0 D1', (c) => check(c));
});
