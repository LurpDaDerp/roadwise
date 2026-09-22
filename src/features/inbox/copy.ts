/**
 * B3's own words. The notification titles and bodies are NOT here: they come from the catalog
 * (`renderLocal`, `renderInboxBase`), so a row says what its notification said, re-rendered from
 * the drive's current state. Nothing here names a score (§B3: no score in the inbox).
 */
export const inboxCopy = {
  title: 'Inbox',
  back: 'Back',
  settings: 'Notification settings',
  markAllRead: 'Mark all read',
  empty: {
    title: 'Nothing new — drive safe',
    body: 'Drive summaries and recording problems will show up here.',
    action: 'See your drives',
  },
  offline: "You're offline. This is what was saved on this phone.",
  error: "We couldn't load your inbox.",
  retry: 'Try again',
  actionFailed: "That didn't save. Try again.",
  deleted: { title: 'Drive deleted', body: 'You deleted this drive.' },
  /** A drive the server knows and this phone does not (another phone, or before a restore). */
  notOnPhone: 'Not on this phone',
  /**
   * That drive's row: facts only (review m1). No "Tap to see…" and no "Were you driving?" — there
   * is nothing to open and nowhere to answer from here.
   */
  elsewhere: {
    title: 'Drive summary',
    // "trip", not "drive": the phone cannot tell who was at the wheel of a trip it does not hold.
    body: (mi: string) => `A ${mi} mi trip on your account.`,
    bodyNoDistance: 'A trip on your account.',
  },
  today: 'Today',
  yesterday: 'Yesterday',
  unread: 'Unread',
  dismiss: 'Dismiss',
  dismissLabel: (title: string) => `Dismiss: ${title}`,
  open: 'Opens the details',
  /** One line from the newest report the driver made on this drive, as the server settled it. */
  dispute: {
    reportAccepted: 'Your report was accepted.',
    reportRecorded: "Your report was logged but didn't change this drive.",
    reportClosed: 'Your report came in too late to apply.',
    reportRefused: "We couldn't apply your report.",
    reportUnsent: "Your report didn't send.",
    reportSending: 'Your report is waiting to send.',
  },
  /**
   * A permission lapse told from the phone's permissions NOW (ruling T6 (1)). Still lapsed: the
   * pushed words, present tense (from the catalog). Fixed since: past tense and "back on". Not
   * readable here (no reading, motion "can't check", or the lapse was on another phone): only what
   * was true that day, and nothing about now.
   */
  lapse: {
    /**
     * Only the permission was checked (review n1): these say the permission is back, never that
     * recording or detection works — other things (battery, the auto-record switch) can still stop it.
     */
    fixed: {
      location_always: {
        title: 'Location is set to Always again',
        body: (day: string) => `On ${day}, location was changed from Always. It's set to Always again.`,
      },
      location: {
        title: 'Location access is back',
        body: (day: string) => `On ${day}, location access was turned off. Location access is back.`,
      },
      motion: {
        title: 'Motion access is back',
        body: (day: string) => `On ${day}, motion access was turned off. Motion access is back.`,
      },
    },
    unknown: {
      location_always: {
        title: 'Automatic recording was off',
        body: (day: string) => `On ${day}, automatic recording was off. Open to check how it is now.`,
      },
      location: {
        title: 'Drive recording was off',
        body: (day: string) =>
          `On ${day}, location access was off, so drives couldn't be recorded. Open to check how it is now.`,
      },
      motion: {
        title: 'Drive detection needed attention',
        body: (day: string) => `On ${day}, motion access was off. Open to check how it is now.`,
      },
    },
    /**
     * Reported by another phone on the account (review n2): this phone's permissions say nothing
     * about that one, so there is nothing here to check.
     */
    elsewhere: {
      location_always: {
        title: 'Automatic recording was off',
        body: (day: string) => `On ${day}, automatic recording was off on another phone signed in to your account.`,
      },
      location: {
        title: 'Drive recording was off',
        body: (day: string) =>
          `On ${day}, location access was off on another phone signed in to your account, so drives couldn't be recorded there.`,
      },
      motion: {
        title: 'Drive detection needed attention',
        body: (day: string) => `On ${day}, motion access was off on another phone signed in to your account.`,
      },
    },
  },
  bell: {
    none: 'Inbox',
    unread: (n: number) => `Inbox, ${n} unread`,
    hint: 'Opens your inbox',
  },
} as const;
