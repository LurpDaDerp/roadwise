// The payload's DMS flags (plan §3): shares of the moving time, so DMS on with the camera covered claims nothing.
import { DMS_FACE_SEEN_MIN_SHARE, DMS_ON_MIN_FACE_SHARE, dmsPayloadFlags, faceShare } from '../flags';

test('the thresholds are the spec’s: dmsOn needs 80 % of the moving time tracked, dmsFaceSeen 50 %', () => {
  expect(DMS_ON_MIN_FACE_SHARE).toBe(0.8);
  expect(DMS_FACE_SEEN_MIN_SHARE).toBe(0.5);
});

test('dmsOn: DMS on for the drive AND a face tracked for ≥ 80 % of the moving rows', () => {
  expect(dmsPayloadFlags({ dmsOn: true, movingRows: 100, dmsFaceRows: 80 })).toEqual({ dmsOn: true, dmsFaceSeen: true });
  expect(dmsPayloadFlags({ dmsOn: true, movingRows: 100, dmsFaceRows: 79 })).toEqual({ dmsOn: false, dmsFaceSeen: true });
  expect(dmsPayloadFlags({ dmsOn: false, movingRows: 100, dmsFaceRows: 100 })).toEqual({ dmsOn: false, dmsFaceSeen: true });
});

test('dmsFaceSeen: a face tracked for ≥ 50 % of the moving rows, DMS on or not', () => {
  expect(dmsPayloadFlags({ dmsOn: false, movingRows: 100, dmsFaceRows: 50 }).dmsFaceSeen).toBe(true);
  expect(dmsPayloadFlags({ dmsOn: true, movingRows: 100, dmsFaceRows: 49 }).dmsFaceSeen).toBe(false);
});

test('the camera covered (no face rows) or a drive that never moved: both false', () => {
  expect(dmsPayloadFlags({ dmsOn: true, movingRows: 300, dmsFaceRows: 0 })).toEqual({ dmsOn: false, dmsFaceSeen: false });
  expect(dmsPayloadFlags({ dmsOn: true, movingRows: 0, dmsFaceRows: 0 })).toEqual({ dmsOn: false, dmsFaceSeen: false });
  expect(faceShare({ movingRows: 0, dmsFaceRows: 5 })).toBe(0);
  expect(faceShare({ movingRows: 10, dmsFaceRows: 12 })).toBe(1); // clamped
});
