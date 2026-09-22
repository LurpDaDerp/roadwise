/**
 * The one background-location disclosure, word for word. Moved here from M3's interim
 * `DetectionScreen.test.tsx` when that screen was deleted (Task 19): the words outlive the screen.
 */
import { DISCLOSURE_TEXT, DISCLOSURE_VERSION } from '@/features/drive/detectionCopy';

test('the one disclosure (M4 Task 9) is exported with its version, word for word', () => {
  expect(DISCLOSURE_VERSION).toBe('pd-1');
  expect(DISCLOSURE_TEXT.heading).toBe('Allow RoadWise to use your location in the background');
  // Play's prominent disclosure: what is collected, that it is collected in the background, what for.
  expect(DISCLOSURE_TEXT.body).toBe(
    'RoadWise collects location data to detect and record your drives automatically — measuring your speed, distance and the roads you drive — even when the app is closed or not in use. While a drive is being detected or recorded, your location is used to look up speed limits; where open map data has no limit, the location (without your account ID) may be sent to Amazon Location Service to find it. RoadWise also uses your phone’s motion activity to detect when a drive starts and ends. Location is kept only as part of a recorded drive. It is stored with your account to score your drives and is never sold. The detailed route of each drive is uploaded and kept for up to 14 days so disputed events can be checked.'
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
