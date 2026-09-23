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
    /** The rewards fields (M5): the server's settled values, never counted on this phone. */
    class: 'Class',
    streak: 'Streak',
    points: 'Points',
    shields: (n: number) => (n === 1 ? '1 shield' : `${n} shields`),
    /** Shown only once a streak has restarted, so the run it had is not lost from view. */
    best: (n: number) => `Best ${n}`,
    /** Under SAFE DAYS when this phone has drives from before the rewards began ("since Sep 21"). */
    since: (day: string) => `since ${day}`,
    rewardsError: "Couldn't read your rewards.",
    /** Offline with nothing saved on this phone: the cause, not a failure. */
    rewardsOffline: "Your rewards appear when you're online.",
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
      safeDays: (n: number, since: string | null = null) =>
        since === null ? `Safe days, ${n}` : `Safe days, ${n}, since ${since}`,
      safeDaysUnread: (reason: string) => `Safe days: ${reason}`,
      provisional: 'Provisional',
      /** "Class Steady. Streak 12 days, 2 shields. 1,250 points. Opens rewards" */
      rewards: (o: { className: string; streak: number; best: number | null; shields: number; points: string }) =>
        [
          `Class ${o.className}`,
          [
            `Streak ${o.streak} ${o.streak === 1 ? 'day' : 'days'}`,
            o.best === null ? null : `best ${o.best}`,
            o.shields > 0 ? (o.shields === 1 ? '1 shield' : `${o.shields} shields`) : null,
          ]
            .filter(Boolean)
            .join(', '),
          o.points,
          'Opens rewards',
        ].join('. '),
    },
  },

  /** This week's focus in the RECORD section (§7.B B1 item 6, M5). */
  focus: {
    label: 'This week',
    /** Passing driving days of the goal's target: "2 of 4 driving days" (Task 9's words). */
    progress: (pass: number, target: number) =>
      `${pass} of ${target} ${target === 1 ? 'driving day' : 'driving days'}`,
    /** A new week's goal has not been opened yet (it is opened on the next online look). */
    none: 'No goal for this week yet.',
    offline: "Your weekly goal appears when you're online.",
    error: "Couldn't read your weekly goal.",
    spoken: (parts: readonly string[]) => [...parts, 'Opens your weekly goal'].join('. '),
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
