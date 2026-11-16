/**
 * The device-side words of the notification plumbing: Android channel names and descriptions (shown
 * in the system's notification settings). The weather channel carries Settings › Notifications' own
 * name for the heads-up.
 */
export const notificationCopy = {
  channels: {
    recaps: { name: 'Drive recaps', description: 'Your recap when a drive ends.' },
    pushes: { name: 'Updates', description: 'Your weekly recap, your monthly Wrapped and friend requests.' },
    weather: { name: 'Weather before your commute', description: 'A heads-up when bad weather is due around the time you usually leave.' },
    driveAlerts: { name: 'Are you driving?', description: 'Asks during a drive when your car isn’t connected, in case you’re a passenger.' },
  },
} as const;
