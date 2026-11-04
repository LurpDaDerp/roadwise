// "Where you parked": Home's card words (iPhone with the car link).
export const parkedCopy = {
  title: 'Where you parked',
  /** The drive's end label and when the car parked (as the drive rows say it), or the time alone. */
  line: (label: string | null, when: string): string => (label === null ? when : `${label} · ${when}`),
  walk: 'Walk back',
  walkHint: 'Opens walking directions to your car',
  dismiss: 'Close',
} as const;
