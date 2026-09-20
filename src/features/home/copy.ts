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
  /**
   * Said before signing out, not after (security review I-5). The next person to sign in on this
   * phone gets a clean device, and a drive that has not reached the server yet exists nowhere
   * else — so the person about to sign out is the only one who can still act on that.
   */
  signOutWarning:
    "Drives that haven't finished uploading are lost if someone else signs in on this phone.",
  error: "Couldn't read your last drive.",
  /** The progress line's own failure: the drive above it still stands. */
  countError: "Couldn't count your drives.",
  retry: 'Try again',
} as const;
