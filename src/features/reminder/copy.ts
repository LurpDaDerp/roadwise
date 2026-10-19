/**
 * The forgot-to-start reminder's words, in Settings and in onboarding. Second person, plain; each
 * line says what the reminder does: one note a trip, at a stop, and a tap on it starts the drive
 * (nothing starts one by itself).
 */
export const reminderCopy = {
  title: 'Forgot-to-start reminder',
  lines: {
    off: 'Reminds you at a stop if you forgot to start a drive. One tap starts it.',
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
    body: 'If you forget to start a drive, RoadWise reminds you at a stop. Tap the reminder to start it.',
    bullets: ['One reminder a trip', 'Never while a drive is recording'],
    ios: 'Needs Location set to Always. iOS may ask you to confirm later. Your location stays on your phone.',
    android: 'Silent, and it usually shows as you park.',
    turnOn: 'Turn on',
    notNow: 'Not now',
    continue: 'Continue',
  },
} as const;
