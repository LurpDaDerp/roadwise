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
   * pushed words, present tense (from the catalog). Fixed since: past tense, naming only the
   * permission. Not readable here (no reading, motion "can't check", or a different install id):
   * only what was true that day, and nothing about now.
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
        title: 'Location was changed from Always',
        body: (day: string) => `On ${day}, location was changed from Always. Open to check how it is now.`,
      },
      location: {
        title: 'Location access was turned off',
        body: (day: string) => `On ${day}, location access was turned off. Open to check how it is now.`,
      },
      motion: {
        title: 'Motion access was turned off',
        body: (day: string) => `On ${day}, motion access was turned off. Open to check how it is now.`,
      },
    },
    /**
     * Always lost while that was not a fault (final review I4): auto-record off by the driver's
     * choice, or withdrawn by the server. B2 calls this "Your choice"; so this row never asks to fix
     * anything — past tense, and what it means now, with no imperative.
     */
    excused: {
      title: 'Location was changed from Always',
      body: (day: string) =>
        `On ${day}, location was changed from Always. Auto-record isn’t in use, so nothing needs to change.`,
    },
    /**
     * Reported under a different install id (review n2, n4): a phone signed in to the account —
     * possibly this one before a reinstall or a handover, so never "another phone". This phone's
     * permissions say nothing about it, so there is nothing here to check.
     */
    elsewhere: {
      location_always: {
        title: 'Location was changed from Always',
        body: (day: string) => `On ${day}, location was changed from Always on a phone signed in to your account.`,
      },
      location: {
        title: 'Location access was turned off',
        body: (day: string) => `On ${day}, location access was turned off on a phone signed in to your account.`,
      },
      motion: {
        title: 'Motion access was turned off',
        body: (day: string) => `On ${day}, motion access was turned off on a phone signed in to your account.`,
      },
    },
  },
  bell: {
    none: 'Inbox',
    unread: (n: number) => `Inbox, ${n} unread`,
    hint: 'Opens your inbox',
  },
} as const;
