// The words of the navigation button, its list of apps and its Settings row (product spec v3
// "Driving screen · Navigation", "Settings").
export const navCopy = {
  pickerTitle: 'Select default navigation app',
  /** Under the title, on the driving screen only. */
  driveLine: 'Your drive keeps recording while you navigate.',
  gone: (app: string) => `${app} isn't on this phone any more.`,
  failed: (app: string) => `${app} didn't open.`,
  empty: 'No navigation app found on this phone.',
  footer: 'You can change it in Settings › Driving.',
  cancel: 'Cancel',
  close: 'Close',
  selected: 'Selected',
  /** The button's caption with no app saved (12 characters at most, like every caption). */
  button: 'Navigate',
  openLabel: (app: string) => `Open ${app}`,
  chooseLabel: 'Choose a navigation app',
  /** The long press, and the screen reader's action for it (once an app is saved). */
  changeLabel: 'Change navigation app',
  changeHint: 'Touch and hold to change the navigation app.',
  /**
   * The button while greyed out for speed, in the driver's units: it greys out at 35 mph but only
   * comes back under 30 (48 km/h is under 30 mph), so the hint names the speed where it comes back.
   */
  lockedHint: (units: 'mi' | 'km') => (units === 'km' ? 'Available below 48 km/h.' : 'Available below 30 mph.'),
  settings: {
    title: 'Navigation app',
    notSet: 'Not set',
    gone: (app: string) => `${app} · not on this phone`,
  },
} as const;
