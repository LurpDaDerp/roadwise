/**
 * Every string the pre-drive sheet (C1), the end screen (C8) and the drive-summary notification
 * print, in one table.
 *
 * `src/i18n/en.ts` is shared by every feature and is not this task's file to grow; the keys are
 * shaped so a localisation pass can lift them without touching a component. Voice (§7.0): second
 * person, supportive, plain words. Honesty: nothing here states more than the data it is shown on
 * supports — "Saving your drive" until the save has answered, never "Drive saved" before it.
 */
export const startCopy = {
  sheet: {
    title: 'Start a drive',
    modeLabel: 'Phone',
    mounted: 'Mounted',
    mountedHint: 'The screen stays on and shows your speed',
    pocket: 'Pocket',
    pocketHint: 'The screen stays off; alerts are spoken',
    passenger: "I'm a passenger",
    passengerHint: "Records the drive without scoring it and turns alerts off",
    start: 'Start drive',
    starting: 'Starting',
    cancel: 'Cancel',
    startFailed: "Couldn't start the drive. Try again.",
    checking: 'Getting ready',
  },
  chips: {
    gpsReady: 'GPS ready',
    gpsSearching: 'Finding GPS',
    battery: (pct: number) => `Battery ${pct}%`,
    charging: (pct: number) => `Battery ${pct}%, charging`,
    hot: 'Phone is hot',
  },
  lowBattery: {
    message: (pct: number) =>
      `Battery is at ${pct}%. Pocket mode keeps the screen off, so it uses less power.`,
    action: 'Use Pocket',
  },
  locationDenied: {
    title: 'RoadWise needs your location to record a drive',
    body: "Without location, RoadWise can't measure your speed or the speed limit, so it can't record or score a drive. Everything else in the app still works.",
    steps: 'In Settings, turn on Location for RoadWise, then come back here.',
    openSettings: 'Open Settings',
    notNow: 'Not now',
  },
  end: {
    saving: 'Saving your drive',
    savingBody: 'This takes a moment.',
    short: 'Short drive saved — too short to score',
    shortBody: "Drives under half a mile or two minutes aren't scored. It's in your trips.",
    /** After 10 s with no answer: no claim of failure until an `ok: false` is actually seen (m1). */
    slow: 'Still saving…',
    slowBody:
      'This is taking longer than usual. It will finish saving on its own, or the next time RoadWise opens.',
    failed:
      "We couldn't finish saving this drive. It will be saved the next time RoadWise opens.",
    simulation: 'Simulation finished',
    simulationBody: 'Nothing from it was saved.',
    done: 'Done',
  },
  notification: {
    /** §11.2 "Trip summary ready" — no score and no places, so the lock screen shows neither. */
    title: 'Your drive is ready',
    body: 'Tap to see how it went',
    batchTitle: (n: number) => `${n} drives are ready`,
    batchBody: 'Tap to see how they went',
    channelName: 'Drive summaries',
  },
} as const;
