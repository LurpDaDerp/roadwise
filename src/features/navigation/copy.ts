// The words of the navigation button, its list of apps and its Settings row (product spec v3
// "Driving screen · Navigation", "Settings").
export const navCopy = {
  pickerTitle: 'Select default navigation app',
  /** Under the title, on the driving screen only. */
  driveLine: 'Opening it with this button never costs points. Leaving RoadWise any other way during a drive does.',
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
  settings: {
    title: 'Navigation app',
    notSet: 'Not set',
    gone: (app: string) => `${app} · not on this phone`,
  },
} as const;
