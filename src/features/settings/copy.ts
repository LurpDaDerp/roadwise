/**
 * The settings screens' own words (H1–H4, H7, H11–H14 as scope.md trims them). Each row's hint
 * says where it goes; each consequence is stated before the control that causes it, and only what
 * the app and the server actually do. H6 keeps its own copy in `notifications/copy.ts`.
 */

export const settingsCopy = {
  title: 'Settings',
  back: 'Back',
  /** Home's avatar, the one way in (scope.md lane C). */
  entry: {
    label: 'Profile and settings',
    hint: 'Opens your profile and the app settings',
  },

  root: {
    driving: 'Driving',
    app: 'App',
    account: 'Account',
    profileHint: 'Edit your name',
    detection: { title: 'Drive detection', subtitle: 'Record drives on their own', hint: 'Opens drive detection' },
    alerts: { title: 'Alerts and sounds', subtitle: 'Voice and a test sound', hint: 'Opens alerts and sounds' },
    camera: { title: 'Camera coaching', subtitle: 'Beta', hint: 'Opens camera coaching' },
    notifications: { title: 'Notifications', subtitle: 'What RoadWise sends you', hint: 'Opens notification settings' },
    privacy: { title: 'Privacy and data', subtitle: 'Export or delete your data', hint: 'Opens privacy and data' },
    help: { title: 'Help and legal', subtitle: 'Questions, terms and privacy', hint: 'Opens help and legal' },
    signOut: 'Sign out',
    version: (v: string) => `RoadWise ${v}`,
  },

  /** Home's own sign-out words are reused for the question (`homeCopy.signOutCheck`). */
  profile: {
    title: 'Profile',
    nameLabel: 'First name',
    nameHint: 'Shown on your card and to your family',
    nameEmpty: 'Enter a name',
    save: 'Save',
    saved: 'Saved',
    saveError: "Couldn't save your name. Check your connection and try again.",
    classLabel: 'Class',
    className: (name: string) => `Class ${name}`,
    classLoading: 'Reading your class',
    classUnread: "Couldn't read your class right now.",
    /** Said beside the class, so the driver knows where it comes from. */
    classHow: 'Your class follows the points you earn. Rewards explains how.',
  },

  alerts: {
    title: 'Alerts and sounds',
    voice: {
      title: 'Voice prompts',
      on: 'Alerts say a short phrase, such as "Slow down", after the tone.',
      off: 'Alerts play a tone only. Nothing is spoken.',
    },
    /** Stated plainly, so nobody thinks switching voice off silences the safety tones. */
    tonesStay: 'The warning tones and vibration always play. Only the spoken phrase is switched off.',
    test: {
      label: 'Play a test alert',
      hint: 'Plays the warning tone, then the voice prompt if it is on',
      playing: 'Playing',
      busy: "You can test the sound when you're not recording a drive.",
      failed: "The test alert couldn't play. Check that your phone isn't muted, then try again.",
    },
    saveError: "Couldn't save that setting. Try again.",
  },

  privacy: {
    title: 'Privacy and data',
    what: 'RoadWise keeps your drives, scores, rewards and settings on its servers so they follow you to a new phone. Raw GPS traces are removed after 14 days.',
    export: {
      title: 'Export my data',
      body: 'A copy of everything RoadWise keeps about you, in one JSON file.',
      action: 'Export my data',
      hint: 'Prepares your data and opens the share sheet',
      working: 'Preparing your data',
      failed: "Couldn't export your data. Check your connection and try again.",
      offline: "You're offline. Export your data when you're connected.",
      tooMany: "You've exported your data several times today. Try again tomorrow.",
      saved: 'Your data file is saved.',
      /** Android: React Native's share sheet can't carry a file, so the system folder picker saves it. */
      androidNote: "You'll choose a folder on your phone to save the file in.",
    },
    delete: {
      title: 'Delete account',
      body: 'Permanently delete your account and everything RoadWise keeps about you.',
      action: 'Delete account',
      hint: 'Opens the delete account screen',
    },
  },

  deleteAccount: {
    title: 'Delete account',
    heading: 'This deletes your account for good',
    consequencesLabel: 'What is deleted',
    consequences: [
      'Your profile, drives, scores and trip history',
      'Your points, streak, badges, challenges and weekly goals',
      "Your family membership and shared location. If you're the family's last member, the family and its saved places are deleted",
      'Your notifications, devices and settings on our servers',
      'Recorded GPS traces stored for your drives',
    ],
    exportFirst: 'You can export a copy of your data first.',
    exportAction: 'Export my data first',
    cannotUndo: "This can't be undone. Signing in again later starts a new, empty account.",
    typeLabel: 'Type DELETE to confirm',
    typeHint: 'Type the word DELETE in capital letters',
    confirmWord: 'DELETE',
    action: 'Delete my account',
    actionHint: 'Deletes your account and signs you out',
    working: 'Deleting your account',
    failed: "Couldn't delete your account. Check your connection and try again. Nothing was deleted.",
    offline: "You're offline. Delete your account when you're connected.",
    busy: 'Finish or end the drive in progress first.',
    /** A 401: the session no longer proves an account. Not a claim that anything was deleted. */
    sessionGone: "You've been signed out. If your account still exists, sign in and try again.",
  },

  help: {
    title: 'Help and legal',
    faqLabel: 'Questions',
    faq: [
      {
        q: "My drive didn't record",
        a: 'Drive detection needs location set to Always and motion access. Open Drive detection in Settings to check each one. You can also start a drive yourself from Home.',
      },
      {
        q: 'How is my score worked out?',
        a: 'Moments like speeding, phone use and harsh braking take points off a drive, and longer drives count for more. How scoring works, below, explains it in full.',
      },
      {
        q: 'Can I say an alert was wrong?',
        a: "Yes. Open the drive, tap the moment, and choose This isn't right. A moment your report removes comes off the drive's score.",
      },
      {
        q: 'What if I was a passenger?',
        a: "Open the drive and choose I was a passenger. A drive you weren't driving isn't scored.",
      },
      {
        q: 'Who can see my drives and location?',
        a: "Your drives and scores are yours alone. If you join a family and turn on location sharing, the family's members see where you are now. Turn sharing off at any time, and your last location is deleted at once.",
      },
    ],
    scoring: 'How scoring works',
    scoringHint: 'Opens the scoring explainer',
    legalLabel: 'Legal',
    safetyLabel: 'Safety',
    /** Printed with the disclaimer word for word (`SAFETY_DISCLAIMER`). */
    safetyNote: 'Keep your eyes on the road. Never touch your phone while driving. Follow the law where you drive, including where a phone may be mounted.',
    noDocuments: 'The terms and privacy policy will be linked here once they are published.',
  },
} as const;
