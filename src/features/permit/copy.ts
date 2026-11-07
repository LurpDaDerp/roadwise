// The words of Permit mode: its Settings row and screen, the practice drives list, the recap's
// practice row and the printed log. This is the driver's own log of their practice; nothing here
// speaks of anyone else using the app.
import type { NightRule } from './states';

const NIGHT_WORDS: Record<NightRule, string> = {
  sunset: 'sunset to sunrise',
  dark30: '30 minutes after sunset to 30 minutes before sunrise',
  md30: '30 minutes before sunset to 30 minutes after sunrise',
};

export const permitCopy = {
  /** Settings › Driving. */
  row: {
    title: 'Permit mode',
    off: 'Off',
    on: 'On',
    progress: (done: string, target: string) => `On · ${done} of ${target} h`,
  },

  title: 'Permit mode',
  switchTitle: "I have a learner's permit",
  switchBody: 'RoadWise logs your practice hours, day and night, so you can show them when you apply for your license.',

  progress: {
    title: 'Your practice hours',
    day: 'Day',
    night: 'Night',
    total: 'Total',
    of: (done: string, target: string) => `${done} of ${target} h`,
    hours: (done: string) => `${done} h`,
    spoken: (what: string, done: string, target: string | null) => (target === null ? `${what}: ${done} hours` : `${what}: ${done} of ${target} hours`),
  },

  state: {
    title: 'State',
    choose: 'Choose your state',
    detected: 'Detected from your location',
    chosen: 'Chosen by you',
    sheetTitle: 'Your state',
    useLocation: 'Use my location',
    useLocationLine: 'RoadWise picks your state from where you are.',
    notFound: "We couldn't find your state. Choose it from the list.",
  },

  targets: {
    title: 'Hour targets',
    summary: (total: string | null, night: string | null) =>
      total === null && night === null ? 'No target' : night === null ? `${total} h total` : total === null ? `${night} h at night` : `${total} h total · ${night} h at night`,
    sheetTitle: 'Hour targets',
    total: 'Total hours',
    night: 'Night hours',
    placeholder: 'None',
    save: 'Save',
    reset: (state: string) => `Reset to ${state}'s numbers`,
    hint: "Check these match your state's current rules. Some states change the hours with driver's ed.",
  },

  supervisor: {
    title: 'Supervisor',
    notSet: 'Not set',
    sheetTitle: 'Supervisor',
    body: 'Who rides with you while you practice. Each new practice drive gets this name, and you can change it on any drive.',
    label: 'Name',
    placeholder: 'Name',
    save: 'Save',
  },

  driverName: {
    title: 'Name on the log',
    notSet: 'Optional',
    sheetTitle: 'Name on the log',
    body: 'Printed at the top of your practice log.',
    label: 'Your name',
    placeholder: 'Your name',
    save: 'Save',
  },

  startDay: {
    title: 'Log start date',
    sheetTitle: 'Log start date',
    body: 'Drives from this day on count toward your hours.',
    prevMonth: 'Previous month',
    nextMonth: 'Next month',
  },

  drives: {
    title: 'Practice drives',
    rowSubtitle: (n: number) => (n === 0 ? 'None yet' : n === 1 ? '1 drive' : `${n} drives`),
    empty: 'No practice drives yet',
    emptyBody: 'Drives you make from your log start date on show up here.',
    nightLine: (n: number) => `${n} min at night`,
    with: (name: string) => `with ${name}`,
  },

  download: 'Download log (PDF)',
  downloadError: "Couldn't make the log. Try again.",
  saveError: "Couldn't save that. Try again.",
  close: 'Close',

  /** The recap's row on a practice drive. */
  recap: {
    title: 'Practice drive',
    line: (duration: string, nightMin: number, supervisor: string | null) =>
      [duration, `${nightMin} min at night`, ...(supervisor === null ? [] : [`with ${supervisor}`])].join(' · '),
    change: 'Change',
    add: 'Add supervisor',
    sheetTitle: 'Who supervised this drive?',
    body: 'Only this drive changes. Your saved supervisor stays the same.',
  },

  /** The printed log. */
  pdf: {
    title: 'Supervised driving log',
    driver: 'Driver',
    state: 'State',
    period: 'Period',
    columns: ['Date', 'Start', 'End', 'Duration', 'Day min', 'Night min', 'Miles', 'Supervisor'],
    kmColumn: 'km',
    totals: 'Totals',
    progressTitle: 'Progress',
    day: 'Day',
    night: 'Night',
    total: 'Total',
    of: (done: string, target: string) => `${done} of ${target} h`,
    hours: (done: string) => `${done} h`,
    noState: 'Not set',
    nightRule: (rule: NightRule, state: string | null) => `Night = ${NIGHT_WORDS[rule]}${state === null ? '' : ` (${state})`}`,
    signatures: ['Supervisor', 'Driver', 'Date'],
    empty: 'No practice drives yet.',
    footer: 'Recorded by RoadWise. Some states require their own form; copy these hours onto it if so.',
    dialogTitle: 'Your practice log',
  },
} as const;
