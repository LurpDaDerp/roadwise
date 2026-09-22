/**
 * Every string the auto-record screen (R16) prints.
 *
 * The prominent disclosure is its own export with a version (M4 seam, controller ruling): M4 Task 9
 * takes ownership of the disclosure text and replaces this screen with A9, so one disclosure system
 * exists and a consent record can name exactly which words the driver was shown. Change
 * `DISCLOSURE_TEXT` only together with a bump of `DISCLOSURE_VERSION`.
 */

/** Bumped whenever `DISCLOSURE_TEXT` changes. */
export const DISCLOSURE_VERSION = 1;

/**
 * Google Play's prominent disclosure for background location, shown before any permission is
 * requested: what is collected (location, motion activity), that it is collected while the app is
 * closed or not in use, and what for. It claims nothing the app does not do.
 */
export const DISCLOSURE_TEXT = {
  heading: 'Record drives automatically',
  body: 'RoadWise collects your location, including in the background when the app is closed or not in use, to notice when you start driving and to record each drive: your route, your speed and the speed limits along the way. It also uses your phone’s motion activity to tell driving apart from walking. Your drives are scored to help you improve and are saved to your RoadWise account. You can turn auto-record off here at any time.',
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
