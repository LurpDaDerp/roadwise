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
  bell: {
    none: 'Inbox',
    unread: (n: number) => `Inbox, ${n} unread`,
    hint: 'Opens your inbox',
  },
} as const;
