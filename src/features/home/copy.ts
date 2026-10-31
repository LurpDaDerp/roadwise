/** Every word Home says (ui.md §3.1). Plain, warm and short; no em dashes, no exclamation marks. */
export const homeCopy = {
  greeting: (name: string) => `Hey, ${name}`,
  week: {
    /** "4 drives", "1 drive", "0 drives". */
    drives: (n: number) => `${n} ${n === 1 ? 'drive' : 'drives'}`,
    drivesSpoken: (n: number) => `${n} ${n === 1 ? 'drive' : 'drives'} this week`,
    /** The distance pill's words for screen readers, `dist` spoken: "38 miles since Monday". */
    distanceSpoken: (dist: string) => `${dist} since Monday`,
    goals: (done: number, total: number) => `${done}/${total} goals`,
    goalsSpoken: (done: number, total: number) => `${done} of ${total} weekly goals done`,
    goalsHint: "Shows this week's goals",
  },
  rating: {
    label: 'Safety Rating',
    window: 'Last 90 days',
    up: (d: number) => `Up ${d} this week`,
    down: (d: number) => `Down ${d} this week`,
    steady: 'Steady this week',
    none: 'No rating yet',
    /** "4 of 10 mi to your rating". */
    toRating: (progress: string) => `${progress} to your rating`,
    afterFirst: 'Your rating shows up after your first drive.',
    spoken: (r: string) => `Safety Rating ${r} out of 100`,
    hint: 'Opens Analytics',
  },
  start: {
    label: 'Start drive',
    hint: 'Swipe right to start recording.',
    auto: 'Or just drive. RoadWise notices on its own.',
  },
  notices: {
    notDriving: "Got it. That trip won't count.",
    ok: 'OK',
  },
  firstRun: {
    first: 'Take your first drive',
    more: (left: number) => `${left} more ${left === 1 ? 'drive' : 'drives'} to unlock your stats`,
    auto: "Just drive. RoadWise notices once you're moving and records the drive.",
    manual: 'Swipe Start drive before you pull out. Then put your phone down and go.',
    keepGoing: 'Nice start. Your stats show up here after 3 drives.',
  },
  goals: {
    title: "This week's goals",
    progress: (p: number, t: number) => `${Math.min(p, t)}/${t}`,
    spokenDone: (title: string, line: string) => `${title}, done. ${line}`,
    spokenOpen: (title: string, p: number, t: number, line: string) => `${title}, ${Math.min(p, t)} of ${t}. ${line}`,
    footer: 'New goals every Monday.',
  },
  how: { title: 'How it works', action: 'How scores work' },
} as const;
