/** The notification settings' own words. Each switch says what it sends, in either position. */
export const notificationSettingsCopy = {
  title: 'Notifications',
  send: 'Send me',
  kinds: {
    weekly_recap: {
      title: 'Weekly and monthly recaps',
      on: 'Your week in review every Sunday evening, and your Wrapped on the 1st of each month.',
      off: 'No weekly recap or monthly Wrapped.',
    },
    social: {
      title: 'Friend requests',
      on: 'When someone adds you as a friend.',
      off: 'No friend request alerts. Requests still show in Friends.',
    },
  },
  /** The weather heads-up before the commute: this phone's own switch. */
  commute: {
    title: 'Weather before your commute',
    on: 'A heads-up when bad weather is due around the time you usually leave.',
    off: 'No weather heads-ups before your commute.',
  },
  quiet: {
    title: 'Quiet hours',
    on: (start: string, end: string) => `Anything sent between ${start} and ${end} waits until ${end}.`,
    off: 'Notifications can arrive at any hour.',
    same: 'Start and end are the same, so quiet hours do nothing.',
    starts: 'Starts',
    ends: 'Ends',
    earlier: (what: string) => `${what} earlier`,
    later: (what: string) => `${what} later`,
    zone: (zone: string) => `Times are in ${zone}.`,
  },
  os: {
    denied: "RoadWise notifications are off in your phone's settings, so none of these will arrive.",
    openSettings: 'Open Settings',
    undetermined: "RoadWise hasn't asked to send notifications on this phone yet.",
    allow: 'Allow',
  },
  loadError: "Couldn't load your notification settings.",
  saveError: "That didn't save. Try again.",
  retry: 'Try again',
} as const;
