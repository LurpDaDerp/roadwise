/**
 * The settings screens' own words. Plain, short, second person; each consequence is said before
 * the control that causes it, and only what the app and the server actually do.
 */
import type { HeatmapVisibility } from '@/data/server/summary';
import type { AutoDrivesMissing } from '@/features/autoDrives/useAutoDrives';

export const VISIBILITY_LABEL: Record<HeatmapVisibility, string> = {
  only_me: 'Only me',
  friends: 'Friends',
};

/** The choices offered: Only me · Friends. */
export const VISIBILITY_SEGMENTS = (['only_me', 'friends'] as const).map((value) => ({
  value,
  label: VISIBILITY_LABEL[value],
}));

/**
 * The segment a saved visibility shows as. Anything but `'friends'` shows as Only me, so the screen
 * never says more people can see the map than the server allows.
 */
export function shownVisibility(v: HeatmapVisibility | null | undefined): 'only_me' | 'friends' | null {
  if (v === undefined || v === null) return null;
  return v === 'friends' ? 'friends' : 'only_me';
}

export const settingsCopy = {
  title: 'Settings',

  root: {
    driving: 'Driving',
    /** iPhone only: the switch for drives that start on their own, and what they need first while it is on. */
    autoDrives: {
      title: 'Automatic drives',
      on: 'On. RoadWise notices your drives.',
      /** Switched off: a drive records only from the Start drive swipe. */
      disabled: 'Off. Swipe Start drive on Home before you pull out.',
      /** Switched on, but the phone still has to allow something. */
      needs: (what: string) => `On, but it needs ${what}.`,
      /** The row under the switch while something is missing: where to allow it. */
      fix: 'Fix it in Permissions',
      what: {
        locationAlways: 'Location set to Always',
        precise: 'Precise Location',
        motion: 'Motion & Fitness',
        backgroundRefresh: 'Background App Refresh',
      } satisfies Record<AutoDrivesMissing, string>,
    },
    dashcam: { title: 'DashPal' },
    alerts: { title: 'Alerts', subtitle: 'Voice, sound and vibration' },
    permissions: { title: 'Permissions', subtitle: 'What RoadWise can use on this phone' },
    privacy: 'Privacy',
    zones: { title: 'Privacy zones', subtitle: (n: number) => (n === 0 ? 'Hide routes near home or school' : `${n} of 6 set`) },
    /** Home, Work, School and the driver's own places. */
    places: {
      title: 'Places',
      subtitle: (names: readonly string[]) =>
        names.length === 0 ? 'Home, work, school and more' : names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`,
    },
    /** What friends can see. Nobody but a friend ever sees any of it. */
    sharing: {
      rating: { title: 'Safety Rating', subtitle: 'Friends can see your Safety Rating' },
      categories: {
        title: 'Category scores',
        subtitle: 'Friends can see your category scores',
        /** In the subtitle's place while Safety Rating is off: the scores average to the rating, so they wait on it. */
        needsRating: 'Turn on Safety Rating to share these.',
      },
      achievements: { title: 'Achievements', subtitle: 'Friends can see your badges' },
      stats: { title: 'Driving stats', subtitle: 'Friends can see your drives, distance and events' },
    },
    heatmap: 'Heat map',
    privacyFooter:
      'Only your friends can see what you share here. The heat map shows the roads you drive most. RoadWise can tell when you pick up your phone on a drive, but it never sees your screen, apps or messages.',
    you: 'You',
    units: 'Units',
    appearance: {
      title: 'Appearance',
      sheetTitle: 'Appearance',
      /** Each choice and its one line, in the order the sheet lists them. */
      options: {
        adaptive: { label: 'Adaptive', detail: 'Follows the time of day and the weather' },
        light: { label: 'Light', detail: 'Always light' },
        dark: { label: 'Dark', detail: 'Always dark' },
        system: { label: 'System', detail: "Matches your phone's Light / Dark setting" },
      },
      footer: 'Saved on this phone only.',
    },
    notifications: { title: 'Notifications', subtitle: 'Weekly recap and friends' },
    saveError: "That didn't save. Check your connection and try again.",
  },

  alerts: {
    title: 'Alerts',
    voice: {
      title: 'Voice alerts',
      on: 'Alerts say a short phrase, like “Hard brake”, after the tone.',
      off: 'Alerts play a tone with no voice.',
    },
    tonesStay: 'Warning tones play either way.',
    test: {
      label: 'Play a test alert',
      hint: "Plays the warning tone, then the voice if it's on",
      playing: 'Playing',
      busy: 'You can test the sound when you’re not on a drive.',
      failed: "The test alert didn't play. Make sure your phone isn't muted and try again.",
    },
    saveError: "Couldn't save that setting. Try again.",
  },

  zones: {
    title: 'Privacy zones',
    intro:
      'Routes inside a zone are hidden on your maps, share cards and heat map. Handy around home or school.',
    local: 'Zones stay on this phone. They’re never uploaded.',
    trim: 'The first and last quarter mile of every drive is always hidden too.',
    add: 'Add a zone',
    max: 'You can set up to 6 zones.',
    /** The saved places, each with a switch that hides it. */
    places: {
      title: 'Your places',
      hidden: (radiusM: number) => `Hidden · ${radiusM} m radius`,
      shown: 'Not hidden',
      footer: 'Turn on a place to hide it in a zone centered on its address. Tap a hidden place to change the zone’s size.',
      add: { title: 'Add your places', subtitle: 'Home, work, school and more' },
      others: 'Other zones',
      full: 'You already have 6 zones. Delete one to hide this place.',
      hideLabel: (name: string) => `Hide ${name}`,
      editTitle: (name: string) => `${name} zone`,
      centered: (address: string) => `Centered on ${address}.`,
      stopTitle: (name: string) => `Stop hiding ${name}?`,
      stop: 'Stop hiding',
      saveSize: 'Save size',
    },
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
      name_long: 'Keep the name to 20 characters or fewer.',
      radius: 'Pick a size between 200 and 800 m.',
      center: 'Set the center first.',
      too_many: 'You can set up to 6 zones.',
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
      body: 'Get a copy of your data in one file.',
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
      body: 'Permanently delete your account and your data.',
    },
  },

  deleteAccount: {
    title: 'Delete account',
    heading: 'This deletes your account for good',
    consequencesLabel: 'What gets deleted',
    consequences: [
      'Your profile, username and drives',
      'Your Safety Rating, weekly goals and achievements',
      'Your friends and blocked list',
      'Your notification settings and the devices saved on our servers',
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
    intro: 'People you block can’t find you or add you, and you won’t see each other on boards.',
    empty: 'Nobody blocked',
    emptyBody: 'You can block someone from their profile.',
    unblock: 'Unblock',
    unblockLabel: (u: string) => `Unblock ${u}`,
    loadError: "Couldn't load your blocked list.",
    retry: 'Try again',
  },
} as const;
