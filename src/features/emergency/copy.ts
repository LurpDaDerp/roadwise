/** The emergency contacts' words off the driving screen: plain, short, second person. */
import { CONTACT_NAME_MAX, EMERGENCY_NUMBER, MAX_CONTACTS, PHONE_DIGITS_MAX, PHONE_DIGITS_MIN, type ContactProblem } from './model';

export const emergencyCopy = {
  /** Settings › Emergency contacts. */
  title: 'Emergency contacts',
  intro: `Add up to ${MAX_CONTACTS} people to call from the driving screen. They stay on this phone.`,
  listTitle: 'Your contacts',
  add: 'Add a contact',
  max: `You can add up to ${MAX_CONTACTS} contacts.`,
  confirm: 'Your phone asks you to confirm each call before it goes through.',
  always: `${EMERGENCY_NUMBER} is always on the call list while you drive, so you don't need to add it.`,
  saveError: "Couldn't save your contacts. Try again.",
  /** One contact's row, read aloud: "Mom, (555) 123-4567". */
  rowSpoken: (name: string, number: string) => `${name}, ${number}`,
  rowHint: 'Edits this contact',

  sheet: {
    newTitle: 'New contact',
    name: 'Name',
    namePlaceholder: 'Mom, Coach Lee…',
    phone: 'Phone number',
    phonePlaceholder: '(555) 123-4567',
    save: 'Save',
    remove: 'Remove',
    removeTitle: (name: string) => `Remove ${name}?`,
    removeBody: "They won't show on the driving screen anymore.",
    cancel: 'Cancel',
    problems: {
      name_empty: 'Add a name.',
      name_long: `Keep the name to ${CONTACT_NAME_MAX} characters or fewer.`,
      phone: `Check the number. It needs ${PHONE_DIGITS_MIN} to ${PHONE_DIGITS_MAX} digits.`,
      too_many: `You can add up to ${MAX_CONTACTS} contacts.`,
    } satisfies Record<ContactProblem, string>,
  },
} as const;
