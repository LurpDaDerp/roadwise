/**
 * Every string the trip screens print, in one table.
 *
 * `src/i18n/en.ts` is shared by every feature and is not this task's file to grow; the keys here
 * are shaped so a localisation pass can lift them into it without touching a component. Voice
 * (§7.0, §9.10): second person, supportive, plain words, never a code in primary text.
 */
export const tripCopy = {
  summaryTitle: 'Drive summary',
  back: 'Back',
  done: 'Done',
  loading: 'Loading this drive',
  route: { label: 'Route', start: 'Start', end: 'End', to: 'to' },
  splits: { time: 'Time', distance: 'Distance', conditions: 'Conditions' },
  conditions: { day: 'Day', night: 'Night', rain: 'Rain', nightRain: 'Night, rain' },
  score: {
    label: 'Score',
    notScored: 'Not scored',
    notScoredYet: 'Not scored yet',
    calculating: 'Calculating…',
  },
  unscored: {
    /**
     * The "tell us whether you drove" variant: role `unknown`, reason `role_unknown` (§9.7). An
     * auto-detected drive whose evidence was ambiguous is asked about, never assumed, and C10's
     * chips are the answer. It states the rule, not an outcome: confirming you drove is necessary
     * for a score (a short or grade-C drive still stays unscored), and a passenger answer never
     * produces one.
     */
    unknownRole:
      "We couldn't tell who was driving. A drive is scored only once you confirm you drove it; a passenger drive stays unscored.",
    passenger: "You weren't driving, so this drive isn't scored.",
    tooShort: "Too short to score fairly. Drives under half a mile or two minutes aren't scored.",
    /** §7.D D1, verbatim. */
    gradeC: 'GPS signal was too weak to score this trip fairly.',
    implausible: "This didn't look like a drive, so it isn't scored.",
    calculating: 'Your score arrives when this drive syncs.',
    unknown: "This drive couldn't be scored.",
  },
  quality: {
    A: 'Clean signal',
    B: 'Some GPS gaps',
    C: 'Weak GPS',
    /** Matches the words `Stamp` speaks for a grade, so the button reads as one element. */
    spoken: (grade: string, caption: string) => `Data quality ${grade}, ${caption}`,
    hint: 'Opens how scoring works',
  },
  chips: { willSync: 'Will sync', recovered: 'Recovered' },
  recovered:
    'Your phone stopped recording before the end, so this drive was saved from its last checkpoint.',
  syncError: {
    message: "This drive didn't upload. It still counts here.",
    details: 'Details',
    hide: 'Hide details',
    code: (code: string) => `Server code: ${code}`,
  },
  highlights: {
    label: 'Highlights',
    positive: {
      phone: 'No phone use',
      speeding: 'Kept to the limit',
      braking: 'Smooth braking',
      accel: 'Smooth acceleration',
      cornering: 'Steady cornering',
      focus: 'Eyes on the road',
    },
    episodes: (n: number) => `${n} ${n === 1 ? 'episode' : 'episodes'}`,
    /** Spoken form of a cost row: "Speeding, 2 episodes, minus 9 points". */
    lost: (points: string) => `minus ${points} points`,
  },
  tip: { label: 'Tip', hint: 'Opens the full tip' },
  earned: {
    label: 'Earned',
    safeDay: 'Safe day',
    goodDay: 'Good day',
    safeOnTrack: 'Safe day on track',
    goodOnTrack: 'Good day on track',
    counts: 'On your record',
    provisional: 'Confirmed when the day closes.',
  },
  footer: {
    fullTrip: 'See full trip',
    wrong: 'Something wrong?',
    share: 'Share',
    shareSoon: 'Share cards are coming soon.',
  },
  /** §7.C C10, verbatim. */
  roles: {
    question: 'Were you driving?',
    driver: 'Yes, I drove',
    passenger: 'Passenger',
    other: 'Bus, train, other',
    error: "Couldn't save that. Try again.",
  },
  perfect: { stamp: 'Clean drive' },
  notFound: { title: "This drive isn't on your record", body: 'It may have been removed.' },
  error: { message: "Couldn't open this drive.", retry: 'Try again' },
  noTip: {
    title: 'No tip for this drive',
    body: "This drive didn't cost points in any one area.",
  },
  tipScreen: {
    why: 'Why it matters',
    fromThisDrive: 'From this drive',
    practice: 'Practice this week',
    focusSet: 'Focus set for this week',
    focusConfirm: 'This is your focus this week.',
    error: "Couldn't save that. Try again.",
  },

  // -------------------------------------------------------------------------------------------
  // D2 — the whole drive (§7.D D2)
  // -------------------------------------------------------------------------------------------
  detail: {
    title: 'The whole drive',
    routeLabel: 'Route',
    showMap: 'Show map',
    hideMap: 'Hide map',
    /** §22 tunable: endpoints trimmed by ~200 m wherever a route is drawn. */
    trimmed: 'The first and last few hundred metres are left off the map.',
    legendNormal: 'Within the limit',
    legendOver: 'Over the limit',
    noRoute: 'No route saved for this drive',
    noRouteBody:
      'Detailed routes are kept for 90 days. Everything below came from the drive itself and stays.',
    noMap: 'Map unavailable',
    noMapBody: 'The timeline below has every moment of the drive.',
    offline: "You're offline, so the map is off. The timeline below has every moment.",
    timelineLabel: 'Timeline',
    cleanTitle: 'Clean drive',
    cleanBody: 'Nothing came up on this drive.',
    categoriesLabel: 'Points lost',
    conditionsLabel: 'Conditions',
    qualityLabel: 'Data quality',
    edit: 'Edit drive',
    unscoredNote: 'This drive has no score, so nothing below cost points.',
  },
  conditionsPanel: {
    light: 'Light',
    day: 'Daylight',
    night: 'Night',
    weather: 'Weather',
    dry: 'Dry',
    rain: 'Rain',
    limits: 'Limits known',
    limitsPct: (pct: number) => `${pct}% of the drive`,
    limitsUnknown: 'Not recorded',
    camera: 'Camera',
    cameraOn: 'On for this drive',
    cameraOff: 'Off',
  },
  qualityPanel: {
    /** The grade is the only signal quality measure the device keeps; the raw % is not stored. */
    gpsUnknown: 'Not recorded',
    sensors: 'How the phone was carried',
    modes: {
      mounted: 'In a mount',
      pocket: 'Pocket or bag',
      handheld: 'Held or loose',
      unknown: 'Not recorded',
    } as Record<string, string>,
    recovered: 'Saved from a checkpoint',
    recoveredBody:
      'Your phone stopped recording before the end, so the tail of this drive is missing.',
  },

  // -------------------------------------------------------------------------------------------
  // D3 — one moment, and the report (§7.D D3)
  // -------------------------------------------------------------------------------------------
  events: {
    title: 'Something wrong?',
    intro: 'Pick the moment that looks wrong and tell us what happened.',
    emptyTitle: 'Nothing was flagged',
    emptyBody: 'This drive has no moments to report.',
    hint: 'Opens this moment',
  },
  event: {
    title: 'This moment',
    notFound: "This moment isn't on the drive",
    notFoundBody: 'It may have been removed.',
    whenLabel: 'When',
    whatLabel: 'What we measured',
    confidenceLabel: 'How sure we are',
    pointsLabel: 'Points',
    pointsLost: (points: string) => `−${points}`,
    pointsNone: 'None',
    /** Still in the score while the report travels: the chart and the score still include it. */
    pointsUnderReview: 'Still counted while we check',
    whyLabel: 'Why this matters',
    report: "This isn't right",
    back: 'Back to the drive',
  },
  severity: { moderate: 'Moderate', severe: 'Severe', none: 'Not counted' },
  confidence: { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' },
  standing: {
    possible: 'Detected, not counted',
    /** §9.4: below the confidence floor an event is shown and deliberately costs nothing. */
    possibleWhy: "We weren't sure enough about this one, so it didn't affect your score.",
    possibleNoReport: "We didn't count this one, so there's nothing to take off your score.",
    reportSending: 'Reported — sending',
    reportSendingWhy: "Your report is saved. We'll send it the next time you're online.",
    reportAccepted: 'Removed from score (your report)',
    reportAcceptedWhy: 'We took your word for it and scored the drive again without this moment.',
    reportRecorded: 'Reported',
    reportRecordedWhy:
      "You've used your reports for now, so this one didn't change your score. We still logged it, and it helps us fix what flagged you.",
    /** §9.9's two rails have different shapes, so each says which one was hit. */
    reportRecordedWhy7d:
      "You've used your three reports for this week, so this one didn't change your score. We still logged it, and it helps us fix what flagged you.",
    reportRecordedWhy30d:
      "You've reported a lot of moments this month, so this one didn't change your score. We still logged it, and it helps us fix what flagged you.",
    reportClosed: 'Reported too late',
    reportClosedWhy: "Reports close 14 days after a drive, so this one couldn't be applied.",
    /** Any other refusal the server actually made: named without inventing a rule for it. */
    reportRefused: "We couldn't apply that report",
    reportRefusedWhy:
      "This moment wasn't part of your score, so there was nothing to take off. Your report is still logged.",
    /** The report never reached the server, so nothing about it was decided. */
    reportUnsent: "Your report didn't send",
    reportUnsentWhy: "We couldn't get it through. You can send it again.",
    removed: 'Removed from score',
    /** §7.0: plain words first; the server's code only under "Details", for support. */
    details: 'Details',
    hideDetails: 'Hide details',
    code: (code: string) => `Server code: ${code}`,
  },
  measured: {
    speed: (mph: number) => `${mph} mph`,
    zone: (mph: number) => `in a ${mph} zone`,
    forSeconds: (s: string) => `for ${s}`,
    atSpeed: (mph: number) => `at ${mph} mph`,
    phone: (s: string) => `Phone handled for ${s}`,
    braking: (g: string) => `Braked at ${g}`,
    accel: (g: string) => `Pulled away at ${g}`,
    cornering: (g: string) => `Turned at ${g}`,
    glance: (s: string) => `Eyes off the road for ${s}`,
    drowsiness: 'Signs of drowsiness',
  },
  why: {
    speedFromGps: 'Speed from GPS',
    limitFromMap: 'speed limit from map data',
    noLimit: 'no speed limit was known here',
    phoneFromDevice: 'From how the phone was handled and how fast you were going',
    fromMotion: "From your phone's motion sensors",
    fromCamera: 'From the camera, processed on your phone',
    corrected: 'you eased off right after the alert',
  },
  whyItMatters: {
    phone:
      'Looking at a phone takes your eyes off the road while the car keeps going the length of a football field.',
    speeding: 'Every extra mph adds stopping distance and takes away time to react.',
    braking: 'Hard braking usually means the gap ahead closed faster than expected.',
    accel: 'Pulling away hard leaves less room to correct if something changes.',
    cornering: 'Taking a turn fast pushes the car towards the edge of its grip.',
    focus: 'Eyes off the road and tiredness are the two things a car cannot correct for you.',
  },

  // -------------------------------------------------------------------------------------------
  // The report sheet — §7.D D3's six reasons, verbatim
  // -------------------------------------------------------------------------------------------
  dispute: {
    title: 'What happened?',
    instruction: 'Pick the closest one.',
    reasons: {
      not_driver: "I wasn't the driver",
      passenger_phone: 'A passenger was using my phone',
      wrong_limit: 'The speed limit is wrong',
      hazard: 'I had to — avoiding a hazard / emergency',
      phone_moved: 'My phone fell or moved',
      other: 'Other',
    },
    limitLabel: 'The posted limit (optional)',
    limitPlaceholder: 'mph',
    limitHint: "A posted limit you tell us is free — it doesn't use up a report.",
    limitRange: (min: number, max: number) => `Enter a limit between ${min} and ${max} mph.`,
    noteLabel: 'What happened (optional)',
    notePlaceholder: 'A sentence is plenty',
    submit: 'Send report',
    cancel: 'Cancel',
    notDriverTitle: 'That changes the whole drive',
    notDriverBody:
      "If you weren't driving, the whole drive comes off your score — not just this moment.",
    notDriverGo: 'Change who was driving',
    queued: "Saved. We'll send it when you're online.",
    failed: "Couldn't save that. Try again.",
  },

  // -------------------------------------------------------------------------------------------
  // D4 — history (§7.D D4)
  // -------------------------------------------------------------------------------------------
  history: {
    title: 'Your drives',
    loading: 'Loading your drives',
    more: 'Show older drives',
    emptyTitle: 'No drives yet',
    emptyBody: 'Your first recorded drive lands here.',
    emptyFilteredTitle: 'No drives match',
    emptyFilteredBody: 'Try clearing a filter.',
    clear: 'Clear filters',
    error: "Couldn't open your drives.",
    retry: 'Try again',
    goodDay: 'Good day',
    /** §18.4: summaries and events stay until the driver deletes them; raw traces do not. */
    deleteFailed: (n: number) =>
      n === 1
        ? "One drive couldn't be deleted yet. It's gone from your phone, but still on our side."
        : `${n} drives couldn't be deleted yet. They're gone from your phone, but still on our side.`,
    deleteRetry: 'Try again',
    retention:
      "That's every drive on this phone. Drives stay until you delete them; the detailed route is kept for 90 days.",
    roles: {
      driver: 'You drove',
      passenger: 'Passenger',
      other: 'Other transport',
      unknown: 'Not answered',
    },
    filters: {
      label: 'Filters',
      role: 'Who',
      band: 'Score',
      category: 'What came up',
      all: 'All',
    },
    hint: 'Opens the drive summary',
  },

  // -------------------------------------------------------------------------------------------
  // D5 — edit the drive (§7.D D5)
  // -------------------------------------------------------------------------------------------
  edit: {
    title: 'Edit drive',
    roleLabel: 'Who was driving',
    roleDriver: 'I drove',
    rolePassenger: 'I was a passenger',
    roleOther: 'Bus, train, other',
    roleError: "Couldn't save that. Try again.",
    roleRescore: "We'll score this drive again with the new answer the next time you're online.",
    roleUnscore: 'This drive no longer counts towards your score.',
    vehicleLabel: 'Vehicle',
    vehicleSoon: 'Vehicles are coming soon.',
    deleteLabel: 'Delete',
    delete: 'Delete this drive',
    deleteLead: "Deleting a drive is permanent. We'll show you exactly what changes first.",
    deleteConfirmTitle: 'Delete this drive?',
    /** §7.D D5, including the guardian-visibility note — said plainly, before the button. */
    deleteConsequence: [
      'The drive, its score and everything on its timeline go for good.',
      "Your safety score and any safe day this drive was part of get worked out again without it. Points you've already earned are never taken back.",
      'If you share summaries with a parent or guardian, they can see that a drive was deleted — never what was on it.',
    ],
    deleteConfirm: 'Delete drive',
    deleteCancel: 'Keep it',
    deleteError: "Couldn't delete that. Try again.",
    rewarded: 'Already counted',
    rewardedBody:
      "This drive is part of a day you've already been credited for. Deleting it works the day out again; nothing you have earned is taken back.",
  },
} as const;
