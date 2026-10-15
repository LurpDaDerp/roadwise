/**
 * The forgot-to-start reminder's words, in Settings and in onboarding. Second person, plain; each
 * line says only what the reminder does: one note, never a drive started for you.
 */
export const reminderCopy = {
  title: 'Forgot-to-start reminder',
  lines: {
    off: 'One note at a stop when you seem to be driving with no drive recording. Tap it to open RoadWise.',
    autoOff: 'Turned off: the last reminders went unused. Turn it on to try again.',
    onAndroid: 'On. At most once a trip, without sound. It often shows as you park.',
    onIos:
      "On. Once a trip, only while you're stopped (maybe once more, an hour or more later, if you drove on before you could see it). If Driving Focus is on, allow RoadWise in it. If you swipe RoadWise away, it waits until you open it.",
    needsAndroid: (what: string) => `On, but it needs ${what}.`,
    needsAlways: 'On, but it needs Location set to Always (Settings › RoadWise › Location).',
    needsPrecise: 'On, but it needs Precise Location turned on.',
    needsIosNotifications: 'On, but it needs notifications allowed.',
    needsIosMotion: 'On, but it needs Motion & Fitness turned on.',
    paused: (day: string) => `Paused until ${day}: the last 3 reminders went unused.`,
    unavailable: 'Not available on this phone.',
  },
  missingAndroid: { motion: 'motion access', notifications: 'notifications' },
  openSettings: 'Open Settings',
  resume: 'Resume now',
  failed: "That didn't work. Try again.",
  step: {
    title: 'Forgot to start?',
    body:
      "Turn this on and RoadWise sends one note when you seem to be driving with no drive recording. Tap it when you're stopped and it's safe to open RoadWise and start your drive. It never starts a drive by itself.",
    bullets: ['Usually once a trip, at least an hour apart, never more than 2 a day', 'Goes quiet if you keep ignoring it'],
    ios: 'Needs Location set to Always so it can notice a trip with the app closed. iOS may ask you later to confirm. Your location stays on your phone.',
    android: 'Silent, and it often shows as you park.',
    turnOn: 'Turn on',
    notNow: 'Not now',
    continue: 'Continue',
  },
} as const;
