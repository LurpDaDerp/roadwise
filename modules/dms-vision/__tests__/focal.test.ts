/** @jest-environment node */
// The Android focal length (plan rev1: m11), against hand-computed values.
import { focalFromSensor, focalScale } from '../src/reference/focal';

const sensor = { focalLengthMm: 3.6, physicalWidthMm: 4.8, physicalHeightMm: 3.6, pixelArrayWidth: 4000, pixelArrayHeight: 3000, activeWidth: 4000, activeHeight: 3000 };

test('a 4:3 sensor streamed at 4:3: fx = 3.6 mm * 640 px / 4.8 mm = 480 px', () => {
  expect(focalFromSensor(sensor, 640, 480)).toEqual([480, 480]);
  expect(focalScale(sensor, 640, 480, 0)).toBeCloseTo(0.75, 12); // 480 / 640
  expect(focalScale(sensor, 640, 480, 270)).toBeCloseTo(1, 12); // the upright width is the buffer height
});

test('a 16:9 active array streamed at 4:3 is cropped at the sides', () => {
  const wide = { ...sensor, physicalWidthMm: 6.4, pixelArrayWidth: 5333, activeWidth: 5333 };
  // The crop keeps the full 3.6 mm height and 4.8 mm of the width, so fx is 480 px again.
  expect(focalFromSensor(wide, 640, 480)![0]).toBeCloseTo(480, 6);
});

test('without usable characteristics, a 70 degree horizontal field of view', () => {
  const fov = 640 / (2 * Math.tan((35 * Math.PI) / 180));
  expect(focalScale(null, 640, 480, 0)).toBeCloseTo(fov / 640, 12);
  expect(focalScale(null, 640, 480, 90)).toBeCloseTo(fov / 480, 12);
  expect(focalScale({ ...sensor, focalLengthMm: 0 }, 640, 480, 0)).toBeCloseTo(fov / 640, 12);
  expect(focalScale({ ...sensor, activeWidth: 0 }, 640, 480, 0)).toBeCloseTo(fov / 640, 12);
});
