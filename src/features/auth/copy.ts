/**
 * Strings for the auth screens that M4 adds (the M2 pattern: each feature keeps its own copy).
 * The M0 strings already in `src/i18n/en.ts` stay there.
 *
 * Honesty (M4 constraint): nothing here promises deletion or export (M8), rewards or points (M5),
 * or anything a guardian can see (M6). Auto-record is described as something the app can do, not
 * as a given: it depends on a permission and a setting the driver controls.
 */
export const welcomeCopy = {
  cards: [
    {
      title: 'Drives record themselves',
      body: 'With auto-record on, RoadWise notices when you start driving and records the drive for you. Rather start each one yourself? That counts just the same.',
    },
    {
      title: 'Quiet coaching, fair scores',
      // Not "a score": too-short, grade-C, passenger and unanswered role-unknown drives carry none.
      body: 'Short, calm cues while you drive. Afterwards, see what counted and why, and flag anything that looks wrong.',
    },
    {
      title: "You control what's shared",
      // The privacy promise itself is the footer line (`welcome.privacy`); this says what it does not.
      body: 'Sharing starts off, and turning it on is your call.',
    },
  ],
  page: (n: number, total: number) => `Page ${n} of ${total}`,
  next: 'Next',
  skip: 'Skip',
  noVideo: 'No video is stored.',
} as const;
