/** The notification settings' own words. Each switch says what it sends, in either position. */
export const notificationSettingsCopy = {
  title: 'Notifications',
  send: 'Send me',
  kinds: {
    weekly_recap: {
      title: 'Weekly recap',
      on: 'Your week in review, every Sunday evening.',
      off: 'No Sunday recap.',
    },
    social: {
      title: 'Friend requests',
      on: 'When someone adds you as a friend.',
      off: 'No friend request alerts. Requests still show in Friends.',
    },
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
