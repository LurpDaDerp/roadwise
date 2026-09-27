/**
 * The one background-location disclosure, word for word. Moved here from M3's interim
 * `DetectionScreen.test.tsx` when that screen was deleted (Task 19): the words outlive the screen.
 */
import { DISCLOSURE_FAMILY_TEXT, DISCLOSURE_TEXT, DISCLOSURE_VERSION } from '@/features/drive/detectionCopy';

test('the one disclosure (M4 Task 9) is exported with its version, word for word', () => {
  expect(DISCLOSURE_VERSION).toBe('pd-2');
  expect(DISCLOSURE_TEXT.heading).toBe('Allow RoadWise to use your location in the background');
  // Play's prominent disclosure: what is collected, that it is collected in the background, what for.
  expect(DISCLOSURE_TEXT.body).toBe(
    'RoadWise collects location data to detect and record your drives automatically — measuring your speed, distance and the roads you drive — even when the app is closed or not in use. While a drive is being detected or recorded, your location is used to look up speed limits; where open map data has no limit, the location (without your account ID) may be sent to Amazon Location Service to find it. RoadWise also uses your phone’s motion activity to detect when a drive starts and ends. Drive locations are kept as part of a recorded drive. They are stored with your account to score your drives and is never sold. The detailed route of each drive is uploaded and kept for up to 14 days so disputed events can be checked. If you turn on location sharing in a family, RoadWise also shares your latest location with your family, even when the app is closed or not in use: it is updated as you drive or move around, kept as one location that is replaced each time (never a history), and deleted when you stop sharing or leave the family, or after 24 hours.'
  );
  // Ruling T9 security I-1: the trace retention is named, and nothing claims lookups or saving
  // happen only during a recorded drive (lookups start on a candidate; pre-roll is kept).
  expect(DISCLOSURE_TEXT.body).toMatch(/uploaded and kept for up to 14 days so disputed events can be checked/);
  expect(DISCLOSURE_TEXT.body).toMatch(/While a drive is being detected or recorded/);
  expect(DISCLOSURE_TEXT.body).not.toMatch(/only (while|during) (a )?(recorded )?drives?/i);
  expect(DISCLOSURE_TEXT.body).not.toMatch(/saved only while a drive is being recorded/);
  expect(DISCLOSURE_TEXT.body).toMatch(/score your drives/);
  expect(DISCLOSURE_TEXT.body).toMatch(/stored with your account/);
  expect(DISCLOSURE_TEXT.body).toMatch(/never sold/);
  expect(DISCLOSURE_TEXT.body).toMatch(/even when the app is closed or not in use/);
  // Ruling T9 (1): every use of background location and motion is named.
  expect(DISCLOSURE_TEXT.body).toMatch(/look up speed limits/);
  expect(DISCLOSURE_TEXT.body).toMatch(/Amazon Location Service/);
  expect(DISCLOSURE_TEXT.body).toMatch(/without your account ID/);
  expect(DISCLOSURE_TEXT.body).toMatch(/motion activity to detect when a drive starts and ends/);
});

test('pd-2 names family location sharing as a background use, in the words the sharing prompt shows', () => {
  expect(DISCLOSURE_TEXT.body.endsWith(DISCLOSURE_FAMILY_TEXT)).toBe(true);
  expect(DISCLOSURE_FAMILY_TEXT).toMatch(/shares your latest location with your family, even when the app is closed/);
  expect(DISCLOSURE_FAMILY_TEXT).toMatch(/never a history/);
  expect(DISCLOSURE_FAMILY_TEXT).toMatch(/deleted when you stop sharing or leave the family, or after 24 hours/);
  // pd-1's claim is gone: location is no longer kept ONLY as part of a recorded drive.
  expect(DISCLOSURE_TEXT.body).not.toMatch(/kept only as part of a recorded drive/);
});
