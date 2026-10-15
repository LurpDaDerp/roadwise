/**
 * The settings screens' own words. Plain, short, second person; each consequence is said before
 * the control that causes it, and only what the app and the server actually do.
 */
import type { HeatmapVisibility, LicenseStage } from '@/data/server/summary';

export const LICENSE_LABEL: Record<LicenseStage, string> = {
  permit: "Learner's permit",
  intermediate: 'Intermediate',
  full: 'Full license',
};

export const LICENSE_SHORT: Record<LicenseStage, string> = {
  permit: 'Permit',
  intermediate: 'Intermediate',
  full: 'Full',
};

export const VISIBILITY_LABEL: Record<HeatmapVisibility, string> = {
  only_me: 'Only me',
  clan: 'Clan',
  friends: 'Friends',
};

export const VISIBILITY_SEGMENTS = (['only_me', 'clan', 'friends'] as const).map((value) => ({
  value,
  label: VISIBILITY_LABEL[value],
}));

export const settingsCopy = {
  title: 'Settings',

  root: {
    driving: 'Driving',
    dashcam: { title: 'DashPal' },
    alerts: { title: 'Alerts', subtitle: 'Voice, sound and vibration' },
    permissions: { title: 'Permissions', subtitle: 'Location, motion and notifications' },
    privacy: 'Privacy',
    zones: { title: 'Privacy zones', subtitle: (n: number) => (n === 0 ? 'Hide routes near home or school' : `${n} of 3 set`) },
    heatmap: 'Heat map visibility',
    heatmapFooter: 'Who can see the map of roads you drive most. Only me is the default.',
    you: 'You',
    license: 'License stage',
    units: 'Units',
    state: { title: 'US state', subtitle: 'For the state filter on the global board', none: 'Not set' },
    notifications: { title: 'Notifications', subtitle: 'Weekly recap, leagues, friends' },
    saveError: "That didn't save. Check your connection and try again.",
  },

  states: {
    title: 'Your state',
    none: "Don't show a state",
  },

  alerts: {
    title: 'Alerts',
    voice: {
      title: 'Voice alerts',
      on: 'Alerts say a short phrase, like “Hard brake”, after the tone.',
      off: 'Alerts play a tone only. Nothing is spoken.',
    },
    tonesStay: 'Warning tones always play. This only switches the spoken words.',
    test: {
      label: 'Play a test alert',
      hint: 'Plays the warning tone, then the voice line if it is on',
      playing: 'Playing',
      busy: 'You can test the sound when you’re not on a drive.',
      failed: "The test alert couldn't play. Check that your phone isn't muted, then try again.",
    },
    saveError: "Couldn't save that setting. Try again.",
  },

  zones: {
    title: 'Privacy zones',
    intro:
      'Routes inside a zone are hidden on your maps, share cards and heat map. Use them for places like home or school.',
    local: 'Zones stay on this phone. They’re never uploaded.',
    trim: 'The first and last quarter mile of every drive is always hidden too.',
    add: 'Add a zone',
    max: 'You can set up to 3 zones.',
    empty: 'No zones yet',
    emptyBody: 'Add home or school so drives near them stay private.',
    radius: (m: number) => `${m} m radius`,
    edit: 'Edit',
    editTitle: 'Edit zone',
    newTitle: 'New zone',
    name: 'Name',
    namePlaceholder: 'Home, School…',
    presets: ['Home', 'School'] as const,
    size: 'Size',
    smaller: 'Smaller',
    bigger: 'Bigger',
    center: 'Center',
    useLocation: 'Use my current location',
    locating: 'Finding you',
    pickOnMap: 'Or tap the map to move the center.',
    noCenter: 'Set the center with your current location.',
    centerSet: 'Center set',
    save: 'Save zone',
    remove: 'Delete zone',
    removeTitle: (name: string) => `Delete “${name}”?`,
    removeBody: 'Routes near this place will show on your maps again.',
    cancel: 'Cancel',
    locationDenied: 'Location is off for RoadWise, so we can’t find you. Turn it on in Settings, or tap the map.',
    locationFailed: "Couldn't get your location. Try again.",
    problems: {
      name_empty: 'Give the zone a name.',
      name_long: 'Keep the name to 20 characters.',
      radius: 'Pick a size between 200 and 800 m.',
      center: 'Set the center first.',
      too_many: 'You can set up to 3 zones.',
    },
    saveError: "Couldn't save your zones. Try again.",
  },

  account: {
    title: 'Account',
    signedInAs: (u: string) => `Signed in as @${u}`,
    signOut: 'Sign out',
    signingOut: 'Signing out',
    export: {
      title: 'Export my data',
      body: 'A copy of everything RoadWise keeps about you, in one file.',
      action: 'Export my data',
      working: 'Preparing your data',
      failed: "Couldn't export your data. Check your connection and try again.",
      offline: "You're offline. Export your data when you're connected.",
      tooMany: "You've exported your data a few times today. Try again tomorrow.",
      saved: 'Your data file is saved.',
      androidNote: "You'll choose a folder on your phone to save the file in.",
    },
    delete: {
      title: 'Delete account',
      body: 'Permanently delete your account and everything RoadWise keeps about you.',
    },
  },

  deleteAccount: {
    title: 'Delete account',
    heading: 'This deletes your account for good',
    consequencesLabel: 'What gets deleted',
    consequences: [
      'Your profile, username and drives',
      'Your points, level, streak, freezes and achievements',
      'Your league history, friends and clan membership',
      'Your notification settings and devices on our servers',
    ],
    exportFirst: 'Want a copy first? Export your data before you delete.',
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
    busy: 'End your drive first.',
    sessionGone: "You've been signed out. If your account still exists, sign in and try again.",
  },

  blocked: {
    title: 'Blocked users',
    intro: 'People you block can’t find you, add you or invite you to a clan, and you won’t see each other on boards.',
    empty: 'Nobody blocked',
    emptyBody: 'You can block someone from their profile.',
    unblock: 'Unblock',
    unblockLabel: (u: string) => `Unblock ${u}`,
    loadError: "Couldn't load your blocked list.",
    retry: 'Try again',
  },
} as const;
