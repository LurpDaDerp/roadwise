/**
 * The device-side words of the notification plumbing: Android channel names (shown in the
 * system's notification settings) and the action buttons on "Were you driving?". The words of
 * the notifications themselves live in the catalog (`src/notifications/catalog.ts`).
 */
export const notificationCopy = {
  channels: {
    trips: 'Drive summaries',
    recording_problems: 'Recording problems',
  },
  actions: {
    drove: 'I drove',
    passenger: 'Passenger',
  },
} as const;
