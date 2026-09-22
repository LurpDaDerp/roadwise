/**
 * Every string the auto-record screen (R16) prints, and the app's ONE background-location
 * disclosure.
 *
 * The prominent disclosure is owned by M4 from Task 9 on (controller ruling I3): this module is
 * the single source of its words. M4's `BackgroundDisclosure` (A9, the post-drive offers and B2's
 * repair) and M3's interim detection screen both print these constants, and the consent record a
 * grant writes names `DISCLOSURE_VERSION`, so it says exactly which words the driver was shown.
 * Change `DISCLOSURE_TEXT` only together with a new `DISCLOSURE_VERSION`.
 */

/** Names the words in `DISCLOSURE_TEXT`; stored as `consents.version` for `background_location`. */
export const DISCLOSURE_VERSION = 'pd-1';

/**
 * Google Play's prominent disclosure for background location, shown before any background
 * request on both platforms (design §5.3): what is collected, that it is collected while the app
 * is closed or not in use, what for, and how it is kept. On counsel's list before any store build.
 */
export const DISCLOSURE_TEXT = {
  heading: 'Allow RoadWise to use your location in the background',
  body: 'RoadWise collects location data to detect and record your drives automatically — measuring your speed, distance and the roads you drive — even when the app is closed or not in use. Location is saved only while a drive is being recorded. It is stored with your account to score your drives and is never sold.',
} as const;

export const detectionCopy = {
  title: 'Auto-record',
  back: 'Back',
  turnOn: 'Turn on auto-record',
  turnOnHint: 'Asks for motion and location access, then turns auto-record on',
  turnOff: 'Turn off auto-record',
  requesting: 'Asking for access',
  on: {
    title: 'Auto-record is on',
    body: 'RoadWise starts recording when it notices you driving. You can still start a drive yourself with Start drive.',
  },
  /** Asked for, but the phone's settings stop it from running. */
  blocked: {
    title: "Auto-record can't run yet",
    body: 'It needs location access set to Always (Allow all the time on Android) and motion access. You can change both in Settings.',
  },
  /** Asked for and permitted, but the host is not armed (a refused arm, a moment after Settings). */
  notRunning: {
    title: "Auto-record isn't running",
    body: 'Your phone allows it, but it hasn’t started. Try again, or turn it off and on.',
  },
  denied: {
    title: 'Auto-record needs your permission',
    body: 'Without Always location and motion access, RoadWise can’t notice when you start driving. You can allow both in Settings, or keep starting drives yourself.',
  },
  unsupported: {
    title: "This phone can't detect drives on its own",
    body: 'It has no motion sensing RoadWise can use. Tap Start drive on Home whenever you drive.',
  },
  notAvailable: {
    title: 'Auto-record isn’t available yet',
    body: 'For now, tap Start drive on Home whenever you drive. You’ll be able to turn auto-record on here once it’s ready.',
  },
  /** R16: iOS offers auto-record only after the first completed drive, and asks for nothing before. */
  firstDrive: {
    title: 'Record your first drive first',
    body: 'On iPhone, auto-record can be turned on after your first drive. Tap Start drive on Home when you set off, and come back here afterwards.',
  },
  notificationsNote:
    'Notifications are off, so you won’t see the notice that a drive is being recorded. You can turn them on in Settings.',
  openSettings: 'Open Settings',
  turnOnAgain: 'Turn on again',
  readError: "Couldn't check auto-record on this phone.",
  retry: 'Try again',
} as const;
