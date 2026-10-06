/** The notification settings' own words. Each switch says what it sends, in either position. */
export const notificationSettingsCopy = {
  title: 'Notifications',
  send: 'Send me',
  kinds: {
    weekly_recap: {
      title: 'Weekly recap',
      on: 'Sunday evening: your week in review.',
      off: 'No Sunday recap.',
    },
    leagues: {
      title: 'League results',
      on: 'When your weekly league finishes.',
      off: 'No league results. You can still check Leagues.',
    },
    social: {
      title: 'Friend requests',
      on: 'When someone adds you as a friend.',
      off: 'No friend request alerts. Requests still show in Friends.',
    },
  },
  quiet: {
    title: 'Quiet hours',
    on: (start: string, end: string) => `Nothing arrives between ${start} and ${end}. It waits until ${end}.`,
    off: 'Notifications can arrive at any hour.',
    same: 'Start and end are the same, so quiet hours do nothing.',
    starts: 'Starts',
    ends: 'Ends',
    earlier: (what: string) => `${what} earlier`,
    later: (what: string) => `${what} later`,
    zone: (zone: string) => `Times are in ${zone}.`,
  },
  os: {
    denied: "Notifications are off for RoadWise in your phone's settings, so none of these can arrive.",
    openSettings: 'Open settings',
    undetermined: "RoadWise hasn't asked to send notifications on this phone yet.",
    allow: 'Allow',
  },
  loadError: "Couldn't load your notification settings.",
  saveError: "That didn't save. Try again.",
  retry: 'Try again',
} as const;
