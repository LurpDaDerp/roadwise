/** The places screens' words: plain, short, second person, and only what the app does. */
import { MAX_CUSTOM_PLACES, PLACE_NAME_MAX, type PlaceKind, type PlaceProblem } from './model';

export const placesCopy = {
  title: 'Places',
  intro: 'Your places name your drives and show your commute. They also give you one-tap directions on the driving screen and a heads-up when bad weather is due before you usually leave.',
  fixedTitle: 'Your places',
  otherTitle: 'Other places',
  add: 'Add a place',
  max: `You can save up to ${MAX_CUSTOM_PLACES} other places.`,
  noAddress: 'Add address',
  kindLabel: { home: 'Home', work: 'Work', school: 'School', custom: 'Place' } satisfies Record<PlaceKind, string>,
  zonesRow: { title: 'Privacy zones', subtitle: (n: number) => (n === 0 ? 'Keep a place private' : `${n} ${n === 1 ? 'place' : 'places'} hidden`) },
  local: 'Your places stay on this phone.',
  saveError: "Couldn't save your places. Try again.",

  sheet: {
    newTitle: 'New place',
    searchPlaceholder: 'Search for an address',
    searchLabel: 'Address',
    clear: 'Clear',
    useLocation: 'Use my current location',
    locating: 'Finding you',
    locationDenied: 'Location is off for RoadWise. Search for the address instead.',
    locationFailed: "Couldn't get your location. Try again or search instead.",
    suggestions: 'Suggestions',
    results: 'Addresses',
    searching: 'Searching',
    noMatches: 'No matches yet. Keep typing, or look up the exact address.',
    searchFailed: "Couldn't search right now. Look up the exact address instead.",
    exact: (q: string) => `Look up “${q}”`,
    exactHint: 'Exact street address, from your phone',
    exactFailed: "Couldn't find that address. Check it and try again.",
    credit: 'Search by Photon · © OpenStreetMap contributors',
    unnamed: 'Address not found',
    inZone: (zone: string) => `Inside your “${zone}” zone`,
    name: 'Name',
    namePlaceholder: 'Gym, Grandma’s…',
    pinHint: 'Tap the map to move the pin.',
    save: 'Save',
    changeAddress: 'Change address',
    remove: 'Remove',
    removeTitle: (name: string) => `Remove ${name}?`,
    removeBody: 'Its privacy zone, if it has one, stays. You can delete the zone in Privacy zones.',
    cancel: 'Cancel',
    problems: {
      name_empty: 'Give the place a name.',
      name_long: `Keep the name to ${PLACE_NAME_MAX} characters or fewer.`,
      point: 'Pick an address first.',
      too_many: `You can save up to ${MAX_CUSTOM_PLACES} other places.`,
    } satisfies Record<PlaceProblem, string>,
  },

  /** The recap's small "Save as …?" card under the map. */
  prompt: {
    title: (kind: 'home' | 'work' | 'school') => `Save as ${kind === 'home' ? 'Home' : kind === 'work' ? 'Work' : 'School'}?`,
    why: { nights: 'Most nights end here', weekdays: 'You’re here most weekdays', name: 'Looks like a school' } as const,
    whyWork: 'Looks like a workplace',
    inZone: (zone: string) => `In your “${zone}” zone`,
    unnamed: 'Saved from a drive',
    yes: 'Yes',
    no: 'No',
    never: 'Don’t remind me',
    saved: (name: string) => `Saved as ${name}. Change it in Settings › Places.`,
    failed: "Couldn't save that. Try again.",
  },

  /** Places' switch for the recap card. */
  askAfterDrives: { title: 'Suggest after drives', subtitle: 'Offers to save a likely home, work or school' },

} as const;
