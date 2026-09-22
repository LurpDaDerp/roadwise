/**
 * The app's ONE background-location disclosure.
 *
 * The prominent disclosure is owned by M4 from Task 9 on (controller ruling I3): this module is
 * the single source of its words. `BackgroundDisclosure` (A6, the post-drive offers, B2's repair
 * and the auto-record screen's Fix) is the only screen that prints them — M3's interim detection
 * screen and its strings are gone (Task 19). The consent record a grant writes names
 * `DISCLOSURE_VERSION`, so it says exactly which words the driver was shown. Change
 * `DISCLOSURE_TEXT` only together with a new `DISCLOSURE_VERSION`.
 */

/** Names the words in `DISCLOSURE_TEXT`; stored as `consents.version` for `background_location`. */
export const DISCLOSURE_VERSION = 'pd-1';

/**
 * Google Play's prominent disclosure for background location, shown before any background
 * request on both platforms (design §5.3): what is collected, that it is collected while the app
 * is closed or not in use, what for, and how it is kept. Ruling T9 (1): it names every use of
 * background location and motion — the speed-limit lookups (including the Amazon Location Service
 * fallback, sent without the account id) and motion activity for drive start and end; and (Ruling
 * T9 security I-1) that the raw route trace is uploaded and kept up to 14 days for disputes.
 * Lookups begin while a possible drive is still being checked, so the text never says they happen
 * only during recorded drives; and a confirmed drive keeps its candidate pre-roll, so it says
 * location is kept "as part of a recorded drive", not "only while a drive is being recorded".
 * Showing drives to a guardian (M6) needs 'pd-2' and a fresh consent. On counsel's list before any
 * store build.
 */
export const DISCLOSURE_TEXT = {
  heading: 'Allow RoadWise to use your location in the background',
  body: 'RoadWise collects location data to detect and record your drives automatically — measuring your speed, distance and the roads you drive — even when the app is closed or not in use. While a drive is being detected or recorded, your location is used to look up speed limits; where open map data has no limit, the location (without your account ID) may be sent to Amazon Location Service to find it. RoadWise also uses your phone’s motion activity to detect when a drive starts and ends. Location is kept only as part of a recorded drive. It is stored with your account to score your drives and is never sold. The detailed route of each drive is uploaded and kept for up to 14 days so disputed events can be checked.',
} as const;
