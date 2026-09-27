/**
 * Every word the family screens show (the lane's own strings, not `src/i18n/en.ts`). Factual and
 * warm; nothing claims more than the data holds: a location is "5 min ago", never "now"; a member
 * who does not share is "Location sharing off", never "unknown".
 */
import type { FamilyErrorCode } from './api';

export const familyCopy = {
  tabTitle: 'Family',
  loading: 'Loading your family',
  loadError: "Couldn't load your family.",
  retry: 'Try again',
  offline: "You're offline. Family needs a connection.",

  start: {
    title: 'Family',
    explainer:
      'Keep up with each other on the road. Family members can share where they are, and save places like home or school, so everyone knows who is where.',
    privacy: 'Location sharing is off until each person turns it on for themselves.',
    createTitle: 'Start a family',
    nameLabel: 'Family name',
    namePlaceholder: 'The Parks',
    create: 'Create family',
    joinTitle: 'Join with a code',
    codeLabel: 'Family code',
    codePlaceholder: '6 letters and numbers',
    join: 'Join family',
    or: 'or',
  },

  home: {
    members: 'Members',
    places: 'Places',
    addPlace: 'Add a place',
    manage: 'Family settings',
    mySharingTitle: 'Share my location',
    mySharingOn: 'Your family can see where you are.',
    mySharingOff: "Your family can't see where you are.",
    mapAndroidSoon: 'Map coming soon on Android.',
    noPlaces: 'No places yet. Add home or school so the family sees when someone is there.',
    you: 'You',
    admin: 'Admin',
  },

  confirmShareOn: {
    title: 'Share your location?',
    body: 'Everyone in your family will see where you are, updated as you drive and move around, and when you open RoadWise. You can turn it off at any time.',
    confirm: 'Share',
    cancel: 'Not now',
  },
  confirmShareOff: {
    title: 'Stop sharing your location?',
    body: 'Your family will no longer see where you are. Your last shared location is deleted now.',
    confirm: 'Stop sharing',
    cancel: 'Keep sharing',
  },

  status: {
    sharingOff: 'Location sharing off',
    noLocation: 'No recent location',
    atPlace: (place: string) => `At ${place}`,
    near: (area: string) => `Near ${area}`,
    located: 'Location shared',
    driving: 'Driving',
    justNow: 'just now',
    minutesAgo: (n: number) => `${n} min ago`,
    hoursAgo: (n: number) => `${n} h ago`,
  },

  manage: {
    title: 'Family settings',
    codeLabel: 'Join code',
    codeExpires: (when: string) => `Works until ${when}. Anyone with it can join, up to 8 people.`,
    codeSpoken: (spoken: string) => `Join code: ${spoken}`,
    share: 'Share code',
    shareMessage: (name: string, code: string) =>
      `Join "${name}" on RoadWise: open Family, tap Join with a code, and enter ${code}.`,
    rotate: 'Get a new code',
    rotateHint: 'The old code stops working.',
    membersLabel: 'Members',
    remove: 'Remove',
    removeTitle: (name: string) => `Remove ${name}?`,
    removeBody: 'They leave the family, and their shared location is deleted.',
    removeConfirm: 'Remove',
    leave: 'Leave family',
    leaveTitle: 'Leave this family?',
    leaveBody: 'You stop seeing the family, and your shared location is deleted.',
    leaveBodyLast: 'You are the only member, so the family and its places are deleted.',
    leaveConfirm: 'Leave',
    cancel: 'Cancel',
    memberCount: (n: number) => `${n} of 8 members`,
  },

  place: {
    addTitle: 'Add a place',
    editTitle: 'Edit place',
    nameLabel: 'Name',
    namePlaceholder: 'Home',
    addressLabel: 'Address',
    addressPlaceholder: 'Street, city',
    find: 'Find address',
    finding: 'Finding…',
    found: (lat: number, lng: number) => `Found: ${lat.toFixed(4)}, ${lng.toFixed(4)}`,
    notFound: "Couldn't find that address. Check it and try again.",
    radiusLabel: 'Counts as there within',
    radius: (m: number) => `${m} m`,
    save: 'Save place',
    delete: 'Delete place',
    deleteTitle: 'Delete this place?',
    deleteBody: 'It is removed for the whole family.',
    deleteConfirm: 'Delete',
    cancel: 'Cancel',
    needAddress: 'Find the address first.',
  },

  step: {
    title: 'Family',
    body: 'Join your family with their code, or start one. You can do this later from the Family tab.',
    skip: 'Not now',
    continue: 'Continue',
    member: (name: string) => `You're in ${name}.`,
  },

  errors: {
    offline: "You're offline. Try again when you're connected.",
    busy: 'RoadWise is busy. Try again in a moment.',
    not_eligible: "Family isn't available for this account.",
    invalid_name: 'Give the family a name of up to 40 characters.',
    invalid_code: "That code didn't work. Check it and try again.",
    family_full: 'That family already has 8 members.',
    already_member: "You're already in a family. Leave it first to join another.",
    too_many: 'Too many tries today. Try again tomorrow.',
    not_in_family: "You're not in that family any more.",
    not_admin: 'Only the family admin can do that.',
    sharing_off: 'Location sharing is off.',
    invalid_place: 'Check the name, address and distance.',
    too_many_places: 'A family can save up to 20 places.',
    unknown: 'Something went wrong. Try again.',
  } satisfies Record<FamilyErrorCode, string>,
} as const;

/** "ABC123" → "A, B, C, 1, 2, 3", so a screen reader reads a code one character at a time. */
export function spokenCode(code: string): string {
  return code.split('').join(', ');
}

/** "ABC123" → "ABC 123": two groups read more easily than six. */
export function spacedCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
