/** The Home card's strings; see `src/features/trips/copy.ts` for why they are not in `i18n` yet. */
export const homeCopy = {
  lastDrive: 'Last drive',
  open: 'Opens the drive summary',
  /** §7.B B1, verbatim shape: "Building your score: 1 of 3 drives". */
  building: (scored: number, needed: number) =>
    `Building your score: ${scored} of ${needed} drives`,
  notScored: 'Not scored',
  empty: {
    /** §7.B B1, verbatim. */
    title: 'Your first drive will appear here',
    body: 'Every drive you record is printed on this card.',
  },
  error: "Couldn't read your last drive.",
  retry: 'Try again',
} as const;
