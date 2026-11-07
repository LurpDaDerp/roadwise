/**
 * Permit mode's screens: the switch and its description; while on, the progress card, the state
 * (detected, chosen, "Use my location"), the hour targets with the hint and the state's note, the
 * supervisor, the name on the log, the start date calendar, the practice drives and the PDF; the
 * practice drives list; and the recap's practice row. Device settings are an in-memory table; the
 * log's drives are stand-ins.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import { drive as mockDriveOf, HOUR } from '@/features/drives/__fixtures__/drives';
import { appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { ThemeProvider } from '@/ui';
import { dayKey } from '@/lib/time';

import { permitCopy } from '../copy';
import { dayOf, monthGrid, monthOf } from '../DayPickerSheet';
import { PermitScreen } from '../PermitScreen';
import { parseHours } from '../PermitSheets';
import { PracticeDriveRow, practiceLine } from '../PracticeDriveRow';
import { PracticeDrivesScreen } from '../PracticeDrivesScreen';
import { PERMIT_KEYS, readPermit } from '../prefs';
import type { StatePorts } from '../stateAt';

const mockPush = jest.fn();
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: mockPush, canGoBack: () => true }),
  useFocusEffect: (fn: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the real React inside a mock factory
    const { useEffect } = require('react') as typeof import('react');
    useEffect(() => fn(), [fn]);
  },
}));
// The log's drives: the in-memory table holds settings only.
let mockDrives: unknown[] = [];
// Set to hold the read (the log still loading).
let mockHold = false;
jest.mock('../data', () => ({
  ...jest.requireActual('../data'),
  readPracticeCandidates: () => (mockHold ? new Promise(() => {}) : Promise.resolve(mockDrives)),
}));

// The clock is pinned to noon today (only Date is faked; timers stay real, so waitFor and the
// queries run as usual): the fixture drives, an hour or three before now, then always fall on the
// log's start day (today), whenever the suite runs. Unpinned, a run soon after midnight put them on
// yesterday, before the start day, and out of the log.
const NOON = new Date();
NOON.setHours(12, 0, 0, 0);
jest.useFakeTimers({
  now: NOON,
  doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
});
afterAll(() => jest.useRealTimers());

const NOW = Date.now();
const TODAY = dayKey(new Date(NOW));
const ON = { [PERMIT_KEYS.enabled]: true, [PERMIT_KEYS.startDay]: TODAY };
const ports = (code: string | null): StatePorts => ({
  position: async () => (code === null ? null : { lat: 1, lng: 2 }),
  geocode: async () => (code === null ? [] : [{ isoCountryCode: 'US', region: code }]),
});
const noState = ports(null);

beforeEach(() => {
  mockPush.mockClear();
  mockHold = false;
  // An hour today, wholly by day or night depending on when the suite runs: only the total is asserted.
  mockDrives = [mockDriveOf({ clientTripId: 'p1', startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR, durationS: 3600, start: undefined, end: undefined, polyline: null, nightMiles: 0, practiceSupervisor: null })];
});
afterEach(() => clearQueryClients());

describe('Settings › Permit mode', () => {
  test('off: the switch and what it does, nothing else', async () => {
    const w = await appWorld();
    await w.render(<PermitScreen deps={{ state: noState }} />);
    expect((await screen.findByTestId('permit-switch')).props.accessibilityLabel).toBe("I have a learner's permit");
    expect(screen.getByText('RoadWise logs your practice hours, day and night, so you can show them when you apply for your license.')).toBeOnTheScreen();
    expect(screen.queryByTestId('permit-progress')).toBeNull();
    expect(screen.queryByTestId('permit-download')).toBeNull();
  });

  test('turning it on starts the log today and shows the hours, the rows and the download', async () => {
    const w = await appWorld({ settings: { [PERMIT_KEYS.state]: { code: 'CA', auto: false } } });
    await w.render(<PermitScreen deps={{ state: noState }} />);
    await fireEvent(await screen.findByTestId('permit-switch'), 'valueChange', true);
    await waitFor(async () => expect(await readPermit(w.settings)).toMatchObject({ enabled: true, startDay: TODAY }));
    expect(await screen.findByTestId('permit-progress')).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByTestId('permit-progress-total-value')).toHaveTextContent('1.0 of 50 h'));
    expect(screen.getByTestId('permit-progress-day-value')).toHaveTextContent(/of 40 h$/);
    expect(screen.getByTestId('permit-progress-night-value')).toHaveTextContent(/of 10 h$/);
    expect(screen.getByTestId('permit-state')).toHaveTextContent(/California\ ·\ Chosen\ by\ you/);
    expect(screen.getByTestId('permit-targets')).toHaveTextContent(/50\ h\ total\ ·\ 10\ h\ at\ night/);
    expect(screen.getByTestId('permit-targets-hint')).toHaveTextContent("Check these match your state's current rules. Some states change the hours with driver's ed.");
    expect(screen.queryByTestId('permit-state-note')).toBeNull();
    expect(screen.getByTestId('permit-supervisor')).toHaveTextContent(/Not\ set/);
    expect(screen.getByTestId('permit-driver-name')).toHaveTextContent(/Optional/);
    expect(screen.getByTestId('permit-drives')).toHaveTextContent(/1\ drive/);
    expect(screen.getByTestId('permit-download')).toHaveTextContent(/Download\ log\ \(PDF\)/);
  });

  test("the state is detected when the screen opens, with its note; without a night target only the total shows", async () => {
    const w = await appWorld({ settings: ON });
    await w.render(<PermitScreen deps={{ state: ports('AK') }} />);
    await waitFor(() => expect(screen.getByTestId('permit-state')).toHaveTextContent(/Alaska\ ·\ Detected\ from\ your\ location/));
    expect(await readPermit(w.settings)).toMatchObject({ state: { code: 'AK', auto: true } });
    expect(screen.getByTestId('permit-state-note')).toHaveTextContent('10 of the 40 hours must be in challenging conditions, like bad weather or darkness.');
    expect(screen.queryByTestId('permit-progress-night')).toBeNull();
    expect(screen.getByTestId('permit-progress-total-value')).toHaveTextContent('1.0 of 40 h');
  });

  test('no position: "Choose your state", no targets, hours without a bar', async () => {
    const w = await appWorld({ settings: ON });
    await w.render(<PermitScreen deps={{ state: noState }} />);
    expect(await screen.findByTestId('permit-state')).toHaveTextContent(/Choose your state/);
    expect(screen.getByTestId('permit-targets')).toHaveTextContent(/No\ target/);
    await waitFor(() => expect(screen.getByTestId('permit-progress-total-value')).toHaveTextContent('1.0 h'));
  });

  test('choosing a state from the list, then "Use my location": back to auto, and with nothing found "Choose your state"', async () => {
    const w = await appWorld({ settings: ON });
    const state = { current: null as string | null };
    const live: StatePorts = { position: async () => ({ lat: 1, lng: 2 }), geocode: async () => (state.current === null ? [] : [{ isoCountryCode: 'US', region: state.current }]) };
    await w.render(<PermitScreen deps={{ state: live }} />);
    await tap('permit-state');
    const sheet = await screen.findByTestId('permit-state-sheet');
    expect(within(sheet).getAllByText(/^[A-Z][a-z]/).length).toBeGreaterThan(51);
    await tap('permit-state-OR');
    await waitFor(async () => expect((await readPermit(w.settings)).state).toEqual({ code: 'OR', auto: false }));
    expect(screen.getByTestId('permit-state')).toHaveTextContent(/Oregon\ ·\ Chosen\ by\ you/);
    expect(screen.getByTestId('permit-state-note')).toHaveTextContent("50 hours if you pass an ODOT-approved driver's ed course.");
    await tap('permit-state');
    await tap('permit-state-auto');
    expect(await screen.findByTestId('permit-state-not-found')).toHaveTextContent("We couldn't find your state. Choose it from the list.");
    // The state follows the location from now on; none found yet.
    await waitFor(async () => expect((await readPermit(w.settings)).state).toEqual({ code: null, auto: true }));
    expect(screen.getByTestId('permit-state')).toHaveTextContent(/Choose your state/);
    // Picking one closes the sheet; opening it again starts without the "couldn't find" line.
    await tap('permit-state-TX');
    await waitFor(async () => expect((await readPermit(w.settings)).state).toEqual({ code: 'TX', auto: false }));
    await tap('permit-state');
    await screen.findByTestId('permit-state-auto');
    expect(screen.queryByTestId('permit-state-not-found')).toBeNull();
    state.current = 'Washington';
    await tap('permit-state-auto');
    await waitFor(async () => expect((await readPermit(w.settings)).state).toEqual({ code: 'WA', auto: true }));
  });

  test('targets: typed, saved, then reset to the state numbers', async () => {
    const w = await appWorld({ settings: { ...ON, [PERMIT_KEYS.state]: { code: 'TX', auto: false } } });
    await w.render(<PermitScreen deps={{ state: noState }} />);
    await tap('permit-targets');
    expect(screen.getByTestId('permit-target-total').props.value).toBe('30');
    expect(screen.queryByTestId('permit-targets-reset')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('permit-target-total'), '45');
    await fireEvent.changeText(screen.getByTestId('permit-target-night'), '');
    await tap('permit-targets-save');
    await waitFor(async () => expect((await readPermit(w.settings)).targets).toEqual({ totalH: 45, nightH: null }));
    expect(screen.getByTestId('permit-targets')).toHaveTextContent(/45\ h\ total/);
    await tap('permit-targets');
    expect(screen.getByTestId('permit-targets-reset')).toHaveTextContent("Reset to Texas's numbers");
    await tap('permit-targets-reset');
    await waitFor(async () => expect((await readPermit(w.settings)).targets).toBeNull());
    expect(screen.getByTestId('permit-targets')).toHaveTextContent(/30\ h\ total\ ·\ 10\ h\ at\ night/);
  });

  test('a target that is not a number cannot be saved', async () => {
    expect(parseHours('')).toBeNull();
    expect(parseHours('0')).toBeNull();
    expect(parseHours('12,5')).toBe(12.5);
    expect(parseHours('abc')).toBeUndefined();
    expect(parseHours('1000')).toBeUndefined();
    const w = await appWorld({ settings: ON });
    await w.render(<PermitScreen deps={{ state: noState }} />);
    await tap('permit-targets');
    await fireEvent.changeText(screen.getByTestId('permit-target-total'), 'lots');
    expect(screen.getByTestId('permit-targets-save')).toBeDisabled();
  });

  test('the supervisor and the name on the log are typed in their sheets', async () => {
    const w = await appWorld({ settings: ON });
    await w.render(<PermitScreen deps={{ state: noState }} />);
    await tap('permit-supervisor');
    await fireEvent.changeText(screen.getByTestId('permit-supervisor-sheet-input'), '  Dad ');
    await tap('permit-supervisor-sheet-save');
    await waitFor(() => expect(screen.getByTestId('permit-supervisor')).toHaveTextContent(/Dad/));
    await tap('permit-driver-name');
    await fireEvent.changeText(screen.getByTestId('permit-driver-name-sheet-input'), 'Sam Lee');
    await tap('permit-driver-name-sheet-save');
    await waitFor(async () => expect(await readPermit(w.settings)).toMatchObject({ supervisor: 'Dad', driverName: 'Sam Lee' }));
  });

  test('the start date: a calendar where days after today are off; a day picked moves the log', async () => {
    const w = await appWorld({ settings: ON });
    await w.render(<PermitScreen deps={{ state: noState }} />);
    await tap('permit-start-day');
    expect(screen.getByTestId('permit-calendar-next')).toBeDisabled();
    const { year, month } = monthOf(TODAY);
    const first = dayOf(year, month, 1);
    await tap(`permit-day-${first}`);
    await waitFor(async () => expect((await readPermit(w.settings)).startDay).toBe(first));
    await tap('permit-start-day');
    await tap('permit-calendar-prev');
    expect(screen.getByTestId('permit-calendar-next')).toBeEnabled();
    const tomorrow = dayKey(new Date(NOW + 86_400_000));
    if (monthOf(tomorrow).month === month) {
      await tap('permit-calendar-next');
      expect(screen.getByTestId(`permit-day-${tomorrow}`)).toBeDisabled();
    }
  });

  test('Practice drives opens the list; the download prints and shares the log', async () => {
    const w = await appWorld({ settings: { ...ON, [PERMIT_KEYS.driverName]: 'Sam' } });
    const print = jest.fn(async (_html: string) => ({ uri: 'file:///log.pdf' }));
    const share = jest.fn(async () => undefined);
    await w.render(<PermitScreen deps={{ state: noState, pdf: { isAvailable: async () => true, print, share, remove: () => {} } }} />);
    await tap('permit-drives');
    expect(mockPush).toHaveBeenCalledWith(SETTINGS_HREFS.practiceDrives);
    await waitFor(() => expect(screen.getByTestId('permit-drives')).toHaveTextContent(/1\ drive/));
    await tap('permit-download');
    await waitFor(() => expect(share).toHaveBeenCalledWith('file:///log.pdf', expect.objectContaining({ mimeType: 'application/pdf' })));
    expect(print.mock.calls[0]?.[0]).toContain('Sam');
    expect(screen.queryByTestId('permit-download-error')).toBeNull();
  });

  test('the download waits for the log: never a log printed before its drives are read', async () => {
    mockHold = true;
    const w = await appWorld({ settings: ON });
    const print = jest.fn(async (_html: string) => ({ uri: 'file:///log.pdf' }));
    await w.render(<PermitScreen deps={{ state: noState, pdf: { isAvailable: async () => true, print, share: async () => undefined, remove: () => {} } }} />);
    expect(await screen.findByTestId('permit-download')).toBeDisabled();
    await tap('permit-download');
    expect(print).not.toHaveBeenCalled();
  });

  test('a download that fails says so', async () => {
    const w = await appWorld({ settings: ON });
    await w.render(<PermitScreen deps={{ state: noState, pdf: { isAvailable: async () => false, remove: () => {} } }} />);
    await tap('permit-download');
    expect(await screen.findByTestId('permit-download-error')).toHaveTextContent("Couldn't make the log. Try again.");
  });
});

describe('Practice drives', () => {
  test('newest first: day and time span, then duration, night minutes and supervisor; a tap opens the recap', async () => {
    mockDrives = [
      mockDriveOf({ clientTripId: 'a', startedAt: NOW - 3 * HOUR, endedAt: NOW - 3 * HOUR + 30 * 60_000, durationS: 1800, start: undefined, end: undefined, polyline: null, miles: 10, nightMiles: 0 }),
      mockDriveOf({ clientTripId: 'b', startedAt: NOW - 2 * HOUR, endedAt: NOW - 2 * HOUR + 20 * 60_000, durationS: 1200, start: undefined, end: undefined, polyline: null, miles: 10, nightMiles: 10, practiceSupervisor: 'Mom' }),
      mockDriveOf({ clientTripId: 'z', startedAt: NOW - HOUR, archived: true, start: undefined, end: undefined, polyline: null }),
    ];
    const w = await appWorld({ settings: { ...ON, [PERMIT_KEYS.supervisor]: 'Dad' } });
    await w.render(<PracticeDrivesScreen />);
    const list = await screen.findByTestId('practice-drives-list');
    const rows = within(list).getAllByTestId(/^practice-drive-/).map((r) => r.props.testID as string);
    expect(rows).toEqual(['practice-drive-z', 'practice-drive-b', 'practice-drive-a']);
    expect(screen.getByTestId('practice-drive-b')).toHaveTextContent(/20 min · 20 min at night · with Mom/);
    expect(screen.getByTestId('practice-drive-a')).toHaveTextContent(/30 min · 0 min at night · with Dad/);
    await tap('practice-drive-a');
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/(app)/drives/[clientTripId]', params: { clientTripId: 'a' } });
    mockPush.mockClear();
    await tap('practice-drive-z');
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('empty: "No practice drives yet"', async () => {
    mockDrives = [];
    const w = await appWorld({ settings: ON });
    await w.render(<PracticeDrivesScreen />);
    expect(await screen.findByText('No practice drives yet')).toBeOnTheScreen();
  });
});

describe("the recap's practice row", () => {
  test('how long, the minutes at night and who supervised; Change sets this drive only', async () => {
    const onSupervisor = jest.fn(async () => true);
    await render(
      <ThemeProvider>
        <PracticeDriveRow practice={{ dayMin: 50, nightMin: 15, supervisor: 'Dad' }} onSupervisor={onSupervisor} />
      </ThemeProvider>
    );
    expect(screen.getByText('Practice drive')).toBeOnTheScreen();
    expect(screen.getByTestId('summary-practice-line')).toHaveTextContent('1 h 05 min · 15 min at night · with Dad');
    await tap('summary-practice-change');
    expect(screen.getByText('Who supervised this drive?')).toBeOnTheScreen();
    expect(screen.getByTestId('summary-practice-sheet-input').props.value).toBe('Dad');
    await fireEvent.changeText(screen.getByTestId('summary-practice-sheet-input'), 'Mom');
    await tap('summary-practice-sheet-save');
    expect(onSupervisor).toHaveBeenCalledWith('Mom');
  });

  test('no supervisor: no "with", and the button adds one', async () => {
    await render(
      <ThemeProvider>
        <PracticeDriveRow practice={{ dayMin: 24, nightMin: 0, supervisor: null }} onSupervisor={async () => true} />
      </ThemeProvider>
    );
    expect(practiceLine({ dayMin: 24, nightMin: 0, supervisor: null })).toBe('24 min · 0 min at night');
    expect(screen.getByTestId('summary-practice-change')).toHaveTextContent(/Add\ supervisor/);
  });
});

describe('the calendar', () => {
  test('whole weeks, Sunday first', () => {
    // November 2026 starts on a Sunday and has 30 days.
    const nov = monthGrid(2026, 10);
    expect(nov[0]).toBe(1);
    expect(nov.length % 7).toBe(0);
    expect(nov.filter((n) => n !== null)).toHaveLength(30);
    // October 2026 starts on a Thursday.
    const oct = monthGrid(2026, 9);
    expect(oct.slice(0, 4)).toEqual([null, null, null, null]);
    expect(oct[4]).toBe(1);
    expect(dayOf(2026, 0, 5)).toBe('2026-01-05');
    expect(monthOf('2026-12-31')).toEqual({ year: 2026, month: 11 });
  });
});

test('copy is plain: no dashes, no exclamation marks, and never about other users', () => {
  const words = JSON.stringify(permitCopy, (_k, v: unknown) => (typeof v === 'function' ? (v as (...a: unknown[]) => string)('A', 'B', 'C') : v));
  expect(words).not.toMatch(/[–—!]/);
  expect(words).not.toMatch(/parent|guardian/i);
});
