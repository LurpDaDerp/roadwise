/** The Home card's strings; see `src/features/trips/copy.ts` for why they are not in `i18n` yet. */

const drives = (n: number) => (n === 1 ? '1 drive' : `${n} drives`);

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

  /** The licence card (§7.B B1, R9). The score is the server's, always dated. */
  card: {
    score: 'Score',
    safeDays: 'Safe days',
    /** Printed where a name would go before the profile has one. */
    noName: 'New driver',
    /** The printed date the server computed the score for: "as of Sep 21". */
    asOf: (day: string) => `as of ${day}`,
    /** Only drives that can still move the score (R9): scored, driver, on their way up. */
    pending: (n: number) => `${drives(n)} waiting to sync`,
    /**
     * The server says "building", yet this phone already holds three scored drives: what is still
     * missing is the hour of driving §9.6 also asks for, so the count would read as complete.
     */
    buildingTime: 'Building your score: it appears after an hour of scored driving',
    waiting: 'Your score appears when your drives sync',
    /** R9: a restore is owed or running, so "Building" would be false for a driver with history. */
    restoring: 'Restoring…',
    readError: "Couldn't read your score.",
    spoken: {
      score: (score: string, band: string, day: string) =>
        `Long-term score ${score} of 100, ${band}, as of ${day}`,
      building: (text: string) => `Long-term score not ready yet. ${text}`,
      waiting: 'Long-term score not ready yet. It appears when your drives sync',
      restoring: 'Long-term score: restoring your drives from the server',
      safeDays: (n: number) => `Safe days, ${n}`,
      safeDaysRestoring: 'Safe days: restoring your drives from the server',
      provisional: 'Provisional',
    },
  },

  /** Home's conditional banners (§7.B B1 item 2). */
  banners: {
    offline: "You're offline. Drives are saved on this phone and upload when you're back online.",
    restoring: (restored: number) =>
      restored > 0
        ? `Restoring your drives from the server: ${drives(restored)} so far.`
        : 'Restoring your drives from the server.',
    failed: "Couldn't finish restoring your drives. Your score may be missing until it does.",
    retry: 'Retry',
  },

  /** The detection status line (§7.B B1 item 8). */
  detection: {
    on: 'Auto-record is on',
    /** The driver asked for it, but the host is not armed: permission, the flag, or not started. */
    notRunning: "Auto-record is on but isn't running",
    manual: 'Manual mode',
    /** The server has not made auto-record available (D2 security M-2): never "turned off". */
    unavailable: 'Auto-record isn’t available yet',
    manualHint: 'Tap Start drive to record a drive.',
    open: 'Auto-record settings',
    openHint: 'Opens the auto-record screen',
  },

  startDrive: 'Start drive',
  startDriveHint: 'Opens the pre-drive sheet',
  diagnostics: 'Diagnostics',

  /** Asked only when the sign-out flush could not send every delete (security review D1 M-1). */
  signOutCheck: {
    title: 'Sign out?',
    unsentDeletes: (n: number) =>
      n === 1
        ? "1 deleted drive hasn't reached the server yet. If you sign out now, it may come back. Sign out anyway?"
        : `${n} deleted drives haven't reached the server yet. If you sign out now, they may come back. Sign out anyway?`,
    unknown:
      "We couldn't check whether your deleted drives reached the server. If any didn't, they may come back. Sign out anyway?",
    cancel: 'Cancel',
    confirm: 'Sign out',
  },
} as const;
