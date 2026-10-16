/**
 * The forgot-to-start reminder's words, in Settings and in onboarding. Second person, plain; each
 * line says what the reminder does: one note a trip, at a stop, and a tap on it starts the drive
 * (nothing starts one by itself).
 */
export const reminderCopy = {
  title: 'Forgot-to-start reminder',
  lines: {
    off: "One note at a stop when you're driving with no drive recording. Tap it to start your drive.",
    onAndroid: 'On. Once a trip, without sound, usually as you park.',
    onIos: 'On. Once a trip, at a stop. If Driving Focus is on, allow RoadWise in it. If you swipe RoadWise away, it waits until you open it.',
    needsAndroid: (what: string) => `On, but it needs ${what}.`,
    needsAlways: 'On, but it needs Location set to Always (Settings › RoadWise › Location).',
    needsPrecise: 'On, but it needs Precise Location turned on.',
    needsIosNotifications: 'On, but it needs notifications allowed.',
    needsIosMotion: 'On, but it needs Motion & Fitness turned on.',
    unavailable: 'Not available on this phone.',
  },
  missingAndroid: { motion: 'motion access', notifications: 'notifications' },
  openSettings: 'Open Settings',
  failed: "That didn't work. Try again.",
  step: {
    title: 'Forgot to start?',
    body: "Turn this on and RoadWise sends one note at a stop when you're driving with no drive recording. Tap it and your drive starts.",
    bullets: ['Once a trip: a trip ends after 30 min without driving', 'Never while a drive is recording'],
    ios: 'Needs Location set to Always so it can notice a trip with the app closed. iOS may ask you later to confirm. Your location stays on your phone.',
    android: 'Silent, and it usually shows as you park.',
    turnOn: 'Turn on',
    notNow: 'Not now',
    continue: 'Continue',
  },
} as const;
