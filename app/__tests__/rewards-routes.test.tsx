/**
 * M5 Task 14: the rewards routes are wired. Every M5 route file exists and renders its own screen
 * (with its route params passed through); every allowlisted M5 href — what a rewards notification
 * or a held invite link may open — resolves to a route file; and the inbox's type CHECK equals the
 * catalog's LIVE_TYPES (six types; rev1: R-I n1).
 *
 * The screens themselves are their tasks' subject (Tasks 8, 9, 12, 13); here each is a stub that
 * shows which screen a route rendered and with what, so a route pointing at the wrong screen, or
 * dropping its param, fails.
 */
import { render, screen } from '@testing-library/react-native';

import { ALLOWED_HREFS, JOIN_HREF } from '@/features/notifications/hrefs';
import { LIVE_TYPES } from '@/notifications/catalog';

import BadgeRoute from '../(app)/rewards/badges/[badgeId]';
import BadgesRoute from '../(app)/rewards/badges/index';
import ChallengeDetailRoute from '../(app)/rewards/challenges/[challengeId]';
import ChallengesRoute from '../(app)/rewards/challenges/index';
import WeeklyGoalRoute from '../(app)/rewards/goal';
import InviteRoute from '../(app)/rewards/invite';
import ShareRoute from '../(app)/rewards/share';
import RewardsTab from '../(tabs)/rewards';
import JoinRoute from '../join/[code]';

let mockParams: Record<string, unknown> = {};
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams }));

// One stub per screen: it renders its own name and the props it was given.
// (a function declaration: hoisted above the imports the mocks serve)
function mockStub(name: string) {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return function Stub(props: Record<string, unknown>) {
    return <RNText testID={name}>{JSON.stringify(props)}</RNText>;
  };
}
jest.mock('@/features/rewards/hub/RewardsHubScreen', () => ({ RewardsHubScreen: mockStub('RewardsHubScreen') }));
jest.mock('@/features/rewards/goal/WeeklyGoalScreen', () => ({ WeeklyGoalScreen: mockStub('WeeklyGoalScreen') }));
jest.mock('@/features/rewards/challenges/ChallengesScreen', () => ({ ChallengesScreen: mockStub('ChallengesScreen') }));
jest.mock('@/features/rewards/challenges/ChallengeDetailScreen', () => ({
  ChallengeDetailScreen: mockStub('ChallengeDetailScreen'),
}));
jest.mock('@/features/rewards/badges/BadgesScreen', () => ({ BadgesScreen: mockStub('BadgesScreen') }));
jest.mock('@/features/rewards/badges/BadgeDetailScreen', () => ({ BadgeDetailScreen: mockStub('BadgeDetailScreen') }));
jest.mock('@/features/referral/InviteScreen', () => ({ InviteScreen: mockStub('InviteScreen') }));
jest.mock('@/features/referral/JoinScreen', () => ({ JoinScreen: mockStub('JoinScreen') }));
jest.mock('@/features/share/ShareComposerScreen', () => ({ ShareComposerScreen: mockStub('ShareComposerScreen') }));

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time; the root
// tsconfig's `types` is ["jest"], hence local shapes (the migration parity tests' pattern).
declare const __dirname: string;
interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const fs = require('node:fs') as {
  existsSync: (file: string) => boolean;
  readFileSync: (file: string, encoding: 'utf8') => string;
  readdirSync: ((dir: string) => string[]) & ((dir: string, opts: { withFileTypes: true }) => Dirent[]);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...parts: string[]) => string; resolve: (...parts: string[]) => string };

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');

/** Every M5 route file, the screen it must render, and the params it is opened with. */
const ROUTES: {
  file: string;
  Route: () => React.JSX.Element;
  screen: string;
  params: Record<string, unknown>;
  props: Record<string, unknown>;
}[] = [
  { file: '(tabs)/rewards.tsx', Route: RewardsTab, screen: 'RewardsHubScreen', params: {}, props: {} },
  { file: '(app)/rewards/goal.tsx', Route: WeeklyGoalRoute, screen: 'WeeklyGoalScreen', params: {}, props: {} },
  {
    file: '(app)/rewards/challenges/index.tsx',
    Route: ChallengesRoute,
    screen: 'ChallengesScreen',
    params: {},
    props: {},
  },
  {
    file: '(app)/rewards/challenges/[challengeId].tsx',
    Route: ChallengeDetailRoute,
    screen: 'ChallengeDetailScreen',
    params: { challengeId: 'phone_down' },
    props: { challengeId: 'phone_down' },
  },
  {
    file: '(app)/rewards/badges/index.tsx',
    Route: BadgesRoute,
    screen: 'BadgesScreen',
    params: {},
    props: {},
  },
  {
    file: '(app)/rewards/badges/[badgeId].tsx',
    Route: BadgeRoute,
    screen: 'BadgeDetailScreen',
    params: { badgeId: 'safe_days_7' },
    props: { badgeId: 'safe_days_7' },
  },
  { file: '(app)/rewards/invite.tsx', Route: InviteRoute, screen: 'InviteScreen', params: {}, props: {} },
  {
    file: '(app)/rewards/share.tsx',
    Route: ShareRoute,
    screen: 'ShareComposerScreen',
    params: { kind: 'badge', badgeId: 'safe_days_7' },
    props: { params: { kind: 'badge', badgeId: 'safe_days_7' } },
  },
  {
    file: 'join/[code].tsx',
    Route: JoinRoute,
    screen: 'JoinScreen',
    params: { code: 'ABCD2345' },
    props: { code: 'ABCD2345' },
  },
];

describe('every M5 route file exists and renders its screen', () => {
  test.each(ROUTES)('$file → $screen', async ({ file, Route, screen: name, params, props }) => {
    expect(fs.existsSync(path.join(APP, file))).toBe(true);
    mockParams = params;
    await render(<Route />);
    expect(JSON.parse(screen.getByTestId(name).props.children as string)).toEqual(props);
  });

  test('a list-valued param is read as its first value', async () => {
    mockParams = { badgeId: ['safe_days_30', 'x'] };
    await render(<BadgeRoute />);
    expect(JSON.parse(screen.getByTestId('BadgeDetailScreen').props.children as string)).toEqual({ badgeId: 'safe_days_30' });
  });
});

/**
 * The route file an href opens under Expo Router: groups `(x)` drop out of the URL, `index` is the
 * directory, `[param]` matches one segment. Resolved against the real `app/` tree.
 */
function routeFileFor(href: string): string | null {
  const segments = href.split('/').filter(Boolean);
  // every file that matches, with how many segments it matched dynamically
  const matches: { file: string; dynamic: number }[] = [];
  const walk = (dir: string, rest: string[], dynamic: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && /^\(.+\)$/.test(e.name)) {
        walk(full, rest, dynamic); // a group is transparent
        continue;
      }
      if (rest.length === 0) {
        if (e.isFile() && e.name === 'index.tsx') matches.push({ file: full, dynamic });
        continue;
      }
      const [head, ...tail] = rest as [string, ...string[]];
      const base = e.isFile() ? e.name.replace(/\.tsx$/, '') : e.name;
      if (e.isFile() && !e.name.endsWith('.tsx')) continue;
      if (base.startsWith('_') || base.startsWith('+')) continue;
      const isParam = /^\[[^.\]]+\]$/.test(base);
      if (base !== head && !isParam) continue;
      const d = dynamic + (isParam ? 1 : 0);
      if (e.isFile()) {
        if (tail.length === 0) matches.push({ file: full, dynamic: d });
      } else {
        walk(full, tail, d);
      }
    }
  };
  walk(APP, segments, 0);
  if (matches.length === 0) return null;
  // Expo Router prefers a static route to a dynamic one
  matches.sort((x, y) => x.dynamic - y.dynamic);
  return matches[0]?.file ?? null;
}

describe('every allowlisted M5 href resolves to a route', () => {
  const M5_HREFS: [string, string][] = [
    ['/rewards', '(tabs)/rewards.tsx'],
    ['/rewards/goal', '(app)/rewards/goal.tsx'],
    ['/rewards/challenges', '(app)/rewards/challenges/index.tsx'],
    ['/rewards/badges', '(app)/rewards/badges/index.tsx'],
    ['/rewards/invite', '(app)/rewards/invite.tsx'],
    ['/join/ABCD2345', 'join/[code].tsx'],
  ];

  test.each(M5_HREFS)('%s → app/%s', (href, file) => {
    expect(ALLOWED_HREFS.some((re) => re.test(href))).toBe(true);
    expect(routeFileFor(href)).toBe(path.join(APP, file));
  });

  test('the list is every allowlisted pattern that is not M4\'s', () => {
    const m4 = ['/trips/abc/summary', '/trips', '/permissions', '/inbox'];
    const m5 = ALLOWED_HREFS.filter((re) => !m4.some((h) => re.test(h)));
    expect(m5).toHaveLength(M5_HREFS.length);
    for (const re of m5) expect(M5_HREFS.some(([href]) => re.test(href))).toBe(true);
    expect(m5).toContain(JOIN_HREF);
  });

  test('an href that is not allowlisted is not taken for one (the resolver is not permissive)', () => {
    expect(routeFileFor('/rewards/nowhere')).toBeNull();
  });
});

test('the inbox type CHECK equals LIVE_TYPES (six types, in catalog order)', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  // the last migration that (re)defines inbox_type_check is the one in force
  const defs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const all = [...sql.matchAll(/inbox_type_check\s+check\s*\(\s*type\s+in\s*\(([^)]*)\)/gi)];
      return all.map((m) => [...(m[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    });
  expect(defs.length).toBeGreaterThan(0);
  expect(defs[defs.length - 1]).toEqual([...LIVE_TYPES]);
  expect(LIVE_TYPES).toHaveLength(6);
});

