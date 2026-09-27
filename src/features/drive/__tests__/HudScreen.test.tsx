import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState, Linking, StyleSheet } from 'react-native';

import type { AlertDecision, AlertKind, AlertLevel } from '@/core/alerts/types';
import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import type { LimitSample } from '@/core/engine/types';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState, HarshEventKind } from '@/drive/host';
import { ThemeProvider } from '@/ui';
import { HARSH_RECENT_MS, HOLD_TO_ACT_MS, HUD } from '@/ui/drive';

import { EVENT_BANNER_MS } from '../EventBanner';
import { hudCopy } from '../hudCopy';
import { HudScreen } from '../HudScreen';
import { WEATHER_REFRESH_MS } from '../weather';

const mockRouter = {
  replace: jest.fn(),
  push: jest.fn(),
  dismissAll: jest.fn(),
  canDismiss: jest.fn(() => false),
};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, usePathname: () => '/drive/hud' }));

const mockPosition: {
  current: { coords: { latitude: number; longitude: number } } | null;
  pending: boolean;
} = { current: null, pending: false };
jest.mock('expo-location', () => ({
  getLastKnownPositionAsync: jest.fn(() =>
    mockPosition.pending ? new Promise(() => {}) : Promise.resolve(mockPosition.current)
  ),
}));

// Counts how often the halo ring renders (review m3): a speed-only row must never reach it. The
// wrapper is not memoised, so each count is one render of the ring's parent.
const mockRenders = { halo: 0 };
jest.mock('@/ui/drive', () => {
  const actual = jest.requireActual<typeof import('@/ui/drive')>('@/ui/drive');
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return {
    ...actual,
    StatusHalo: (p: import('@/ui/drive').StatusHaloProps) => {
      mockRenders.halo += 1;
      return createElement(actual.StatusHalo, p);
    },
  };
});

const T = Date.UTC(2026, 8, 22, 19, 0, 0); // noon in Seattle (PDT, UTC−7)
const MPH = 0.44704;
const SEATTLE = { coords: { latitude: 47.6, longitude: -122.33 } };

const mockFetch = jest.fn<Promise<Response>, [string, RequestInit?]>();
const weather = (current: object) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ current }) } as Response);

function state(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'recording',
    mode: 'mounted',
    role: 'driver',
    clientTripId: 't1',
    startedAt: T,
    lastRowTs: T,
    speedMps: 20 * MPH,
    speedKnown: true,
    awaitingSpeedAfterResume: false,
    limit: UNKNOWN_LIMIT,
    distanceM: 0,
    stationarySinceTs: null,
    lockedOut: true,
    stoppedPanel: false,
    endCause: null,
    activeAlert: null,
    mutedForDrive: false,
    gps: 'good',
    thermal: 'nominal',
    callActive: false,
    screenLocked: false,
    lastFinalized: null,
    tripIndex: 5,
    dryRun: false,
    harshEvent: null,
    ...over,
  };
}

function stubHost(initial: DriveState, night = false) {
  let current = initial;
  const listeners = new Set<(s: DriveState) => void>();
  const host = {
    snapshot: () => current,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    end: jest.fn(async () => {}),
    setPassenger: jest.fn(async () => {}),
    setMode: jest.fn(async () => {}),
    muteCurrentAlert: jest.fn(async () => {}),
    muteForDrive: jest.fn(async () => {}),
    detectorContext: () => ({ night, precipitation: false, lockReliable: true, lockLagged: false }),
  };
  return {
    host,
    async push(next: Partial<DriveState>) {
      current = { ...current, ...next };
      await act(() => {
        for (const fn of listeners) fn(current);
      });
    },
  };
}

const posted = (mph: number, matchConfidence = 0.95): LimitSample => ({
  limitMps: mph * MPH,
  source: 'posted',
  matchConfidence,
  parallelRoads: false,
});

const decision = (
  level: AlertLevel,
  kind: AlertKind = level === 3 ? 'drowsy' : level === 2 ? 'phone' : 'speeding',
  id = `a-${kind}-${level}`
): AlertDecision => ({ id, level, kind, ts: T });

const harsh = (kind: HarshEventKind, id = `h-${kind}`, ts = T) => ({ id, kind, ts });

const flat = <T,>(el: { props: Record<string, unknown> }): T =>
  StyleSheet.flatten(el.props.style as never) as T;
const numeralInk = () => flat<{ color: string }>(screen.getByTestId('hud-speed-numeral')).color;
const haloColor = () => flat<{ borderColor: string }>(screen.getByTestId('hud-halo')).borderColor;

function wrap(host: unknown, children: ReactNode) {
  return (
    <ThemeProvider scheme="light">
      <DriveProvider host={host as DriveHost}>{children}</DriveProvider>
    </ThemeProvider>
  );
}

async function renderHud(
  over: Partial<DriveState> = {},
  opts: { night?: boolean; overlay?: boolean } = {}
) {
  const h = stubHost(state(over), opts.night);
  await render(wrap(h.host, <HudScreen overlay={opts.overlay} />));
  // The night check and the weather read the OS's cached position once on mount.
  await act(async () => {});
  return h;
}

const hold = async (testID: string, ms = HOLD_TO_ACT_MS) => {
  await fireEvent(screen.getByTestId(testID), 'pressIn');
  await act(() => jest.advanceTimersByTime(ms));
};

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});
beforeEach(() => {
  jest.useFakeTimers({ now: T });
  mockPosition.current = null;
  mockPosition.pending = false;
  mockFetch.mockReset();
  mockFetch.mockImplementation(() => Promise.reject(new Error('offline')));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('HudScreen (C3): the speed, the limit and the halo', () => {
  test('no GPS: the speed reads "—", no words; the halo is calm', async () => {
    await renderHud({ speedKnown: false, speedMps: 0, gps: 'none', lockedOut: false });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('—');
    expect(screen.queryByText(/Finding GPS/i)).toBeNull();
    expect(haloColor()).toBe(HUD.day.calm);
  });

  test('no limit: the sign reads "—" and a fast speed is not treated as speeding', async () => {
    await renderHud({ speedMps: 60 * MPH, limit: UNKNOWN_LIMIT });
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('—');
    expect(numeralInk()).toBe(HUD.day.ink);
    expect(haloColor()).toBe(HUD.day.calm);
  });

  test('a limit below the action gate is not shown (ramp match at 0.65)', async () => {
    await renderHud({ speedMps: 60 * MPH, limit: posted(35, 0.65) });
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('—');
    expect(haloColor()).toBe(HUD.day.calm);
  });

  test('over the tolerance the numerals and the halo shift to amber; well over, to soft red', async () => {
    const h = await renderHud({ speedMps: 38 * MPH, limit: posted(35) });
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('35');
    expect(numeralInk()).toBe(HUD.day.ink);
    await h.push({ speedMps: 45 * MPH });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('45');
    expect(numeralInk()).toBe(HUD.day.attention);
    expect(haloColor()).toBe(HUD.day.attention);
    await h.push({ speedMps: 52 * MPH });
    expect(numeralInk()).toBe(HUD.day.critical);
    expect(haloColor()).toBe(HUD.day.critical);
    await h.push({ speedMps: 30 * MPH });
    expect(numeralInk()).toBe(HUD.day.ink);
    expect(haloColor()).toBe(HUD.day.calm);
  });

  test.each([
    [1, HUD.day.attention, 'Recording, caution'],
    [2, HUD.day.attention, 'Recording, caution'],
    [3, HUD.day.critical, 'Recording, urgent'],
  ] as const)('alert level %i colours the halo and the numerals', async (level, color, label) => {
    await renderHud({ activeAlert: decision(level) });
    expect(haloColor()).toBe(color);
    expect(numeralInk()).toBe(color);
    expect(screen.getByTestId('hud-halo').props.accessibilityLabel).toBe(label);
  });

  test('a harsh event holds the halo on attention for 10 s of the row clock, then it settles', async () => {
    const h = await renderHud();
    await h.push({ harshEvent: harsh('braking') });
    expect(haloColor()).toBe(HUD.day.attention);
    await h.push({ lastRowTs: T + HARSH_RECENT_MS - 1 });
    expect(haloColor()).toBe(HUD.day.attention);
    await h.push({ lastRowTs: T + HARSH_RECENT_MS });
    expect(haloColor()).toBe(HUD.day.calm);
    // The same event, republished, stays settled; a new one is a new window.
    await h.push({ harshEvent: harsh('braking'), lastRowTs: T + 20_000 });
    expect(haloColor()).toBe(HUD.day.calm);
    await h.push({ harshEvent: harsh('cornering', 'h2', T + 20_000) });
    expect(haloColor()).toBe(HUD.day.attention);
    // No wall-clock timer is involved: time passing without rows changes nothing.
    await act(() => jest.advanceTimersByTime(60_000));
    expect(haloColor()).toBe(HUD.day.attention);
  });

  test('a harsh event the HUD only meets long after its time is old news: no attention, no banner', async () => {
    await renderHud({ harshEvent: harsh('braking', 'old', T - 20 * 60_000) });
    expect(haloColor()).toBe(HUD.day.calm);
    expect(screen.queryByTestId('hud-banner')).toBeNull();
  });

  test('mounting with a fresh event already in the state shows it', async () => {
    await renderHud({ harshEvent: harsh('accel', 'now') });
    expect(haloColor()).toBe(HUD.day.attention);
    expect(screen.getByTestId('hud-banner-words')).toHaveTextContent('Rapid acceleration');
  });

  test('the halo never pulses: no animated node, just a coloured ring', async () => {
    await renderHud({ activeAlert: decision(3) });
    const ring = screen.getByTestId('hud-halo');
    expect(ring.props.style).toBeDefined();
    expect(flat<{ borderWidth: number }>(ring).borderWidth).toBe(10);
  });

  test('nothing else: no corner indicators, no camera chip, no unavailable mark, no stopped panel', async () => {
    await renderHud({
      alertsAvailable: false,
      stoppedPanel: true,
      speedMps: 0,
      lockedOut: false,
      thermal: 'critical',
      role: 'passenger',
    });
    expect(screen.queryByTestId('hud-ind-gps')).toBeNull();
    expect(screen.queryByTestId('hud-ind-passenger')).toBeNull();
    expect(screen.queryByTestId('hud-alerts-unavailable')).toBeNull();
    expect(screen.queryByTestId('stopped-panel')).toBeNull();
    expect(screen.queryByTestId('hud-alert')).toBeNull();
    expect(screen.queryByText(hudCopy.alerts.unavailable)).toBeNull();
  });
});

describe('HudScreen: the event banner', () => {
  test('an alert shows its words for 4 s of the row clock, then goes, while the alert stays active', async () => {
    const h = await renderHud();
    await h.push({ activeAlert: decision(2, 'phone') });
    const banner = screen.getByTestId('hud-banner');
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(banner.props.pointerEvents).toBe('none');
    expect(screen.getByTestId('hud-banner-words')).toHaveTextContent(hudCopy.event.phone);
    expect(flat<{ backgroundColor: string }>(banner).backgroundColor).toBe(HUD.day.attention);
    await h.push({ lastRowTs: T + EVENT_BANNER_MS - 1 });
    expect(screen.getByTestId('hud-banner')).toBeTruthy();
    await h.push({ lastRowTs: T + EVENT_BANNER_MS });
    expect(screen.queryByTestId('hud-banner')).toBeNull();
    // The alert is still active (an L2 shows 5 s, an L3 8 s): the halo says so, the banner does not.
    expect(haloColor()).toBe(HUD.day.attention);
    expect(EVENT_BANNER_MS).toBe(4000);
  });

  test('an L1 alert the host drops after 3 s goes with it (3–5 s is the window)', async () => {
    const h = await renderHud();
    await h.push({ activeAlert: decision(1, 'speeding') });
    await h.push({ lastRowTs: T + 2999 });
    expect(screen.getByTestId('hud-banner-words')).toHaveTextContent(hudCopy.event.speeding);
    await h.push({ activeAlert: null, lastRowTs: T + 3000 });
    expect(screen.queryByTestId('hud-banner')).toBeNull();
  });

  test('an L3 alert is a critical band; the break suggestion says how long the drive has run', async () => {
    const h = await renderHud({ activeAlert: decision(3, 'drowsy') });
    expect(flat<{ backgroundColor: string }>(screen.getByTestId('hud-banner')).backgroundColor).toBe(
      HUD.day.critical
    );
    expect(screen.getByTestId('hud-banner-words')).toHaveTextContent(hudCopy.event.drowsy);
    await h.push({ activeAlert: decision(1, 'break'), startedAt: T - 2 * 3_600_000 });
    expect(screen.getByTestId('hud-banner-words')).toHaveTextContent('Take a break');
    expect(screen.getByTestId('hud-banner-detail')).toHaveTextContent('2 h driving');
  });

  test.each([
    ['braking', 'Hard braking'],
    ['accel', 'Rapid acceleration'],
    ['cornering', 'Sharp turn'],
  ] as const)('a harsh %s event shows "%s" briefly, and only once per event', async (kind, words) => {
    const h = await renderHud();
    await h.push({ harshEvent: harsh(kind) });
    expect(screen.getByTestId('hud-banner-words')).toHaveTextContent(words);
    await h.push({ lastRowTs: T + EVENT_BANNER_MS });
    expect(screen.queryByTestId('hud-banner')).toBeNull();
    await h.push({ harshEvent: harsh(kind), lastRowTs: T + 10_000 });
    expect(screen.queryByTestId('hud-banner')).toBeNull();
  });

  test('a newer event replaces the banner and its window runs from its own time', async () => {
    const h = await renderHud();
    await h.push({ harshEvent: harsh('braking') });
    await h.push({ lastRowTs: T + 3000, activeAlert: { ...decision(2, 'eyes_off'), ts: T + 3000 } });
    expect(screen.getByTestId('hud-banner-words')).toHaveTextContent(hudCopy.event.eyes_off);
    await h.push({ lastRowTs: T + 6999 });
    expect(screen.getByTestId('hud-banner')).toBeTruthy();
    await h.push({ lastRowTs: T + 7000 });
    expect(screen.queryByTestId('hud-banner')).toBeNull();
  });

  test('the banner needs no timer: with no rows, time passing changes nothing', async () => {
    const h = await renderHud();
    await h.push({ harshEvent: harsh('braking') });
    await act(() => jest.advanceTimersByTime(60_000));
    expect(screen.getByTestId('hud-banner')).toBeTruthy();
  });
});

describe('HudScreen: the weather hazard bar (Open-Meteo)', () => {
  test('with no cached position nothing is fetched and the bar is empty', async () => {
    await renderHud();
    expect(screen.getByTestId('hud-hazard-bar')).toBeTruthy();
    expect(screen.queryByTestId('hud-hazard')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a thunderstorm at the last known position is the one hazard shown', async () => {
    mockPosition.current = SEATTLE;
    mockFetch.mockImplementation(() => weather({ weather_code: 95, wind_gusts_10m: 90 }));
    await renderHud();
    expect(await screen.findByText(hudCopy.hazard.thunderstorm)).toBeTruthy();
    expect(screen.getAllByTestId('hud-hazard')).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]![0];
    expect(url).toContain('api.open-meteo.com/v1/forecast');
    expect(url).toContain('latitude=47.6&');
    expect(url).toContain('current=weather_code,wind_gusts_10m,visibility');
  });

  test('a failed fetch, or calm weather, shows nothing', async () => {
    mockPosition.current = SEATTLE;
    await renderHud();
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('hud-hazard')).toBeNull();
    mockFetch.mockImplementation(() => weather({ weather_code: 1, wind_gusts_10m: 12 }));
    await act(() => jest.advanceTimersByTime(WEATHER_REFRESH_MS));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('hud-hazard')).toBeNull();
  });

  test('refreshed every 15 min, and again after 20 km, never faster', async () => {
    mockPosition.current = SEATTLE;
    mockFetch.mockImplementation(() => weather({ weather_code: 45 }));
    const h = await renderHud();
    expect(await screen.findByText(hudCopy.hazard.dense_fog)).toBeTruthy();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await h.push({ speedMps: 25 * MPH, distanceM: 19_000 });
    await act(() => jest.advanceTimersByTime(WEATHER_REFRESH_MS - 1000));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(() => jest.advanceTimersByTime(1000));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await h.push({ distanceM: 21_000 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(WEATHER_REFRESH_MS).toBe(15 * 60_000);
  });

  test('nothing is fetched unless the drive is recording, and a hazard clears when it stops', async () => {
    mockPosition.current = SEATTLE;
    mockFetch.mockImplementation(() => weather({ weather_code: 99 }));
    const h = await renderHud({ status: 'ending', lockedOut: false, speedMps: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
    await h.push({ status: 'recording' });
    expect(await screen.findByText(hudCopy.hazard.thunderstorm)).toBeTruthy();
    await h.push({ status: 'ending' });
    expect(screen.queryByTestId('hud-hazard')).toBeNull();
  });
});

describe('HudScreen: touch policy — two hold-to-act controls, nothing else', () => {
  test('while moving the only controls are SOS and End; a tap on either does nothing', async () => {
    const h = await renderHud({ lockedOut: true });
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByTestId('hud-tap-area')).toBeNull();
    expect(screen.queryByTestId('hud-touch-shield')).toBeNull();
    await fireEvent.press(screen.getByTestId('hud-end'));
    await fireEvent.press(screen.getByTestId('hud-sos'));
    await act(() => jest.advanceTimersByTime(5000));
    expect(h.host.end).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('a 2 s hold on End routes to the end screen and ends the drive — at speed too', async () => {
    const h = await renderHud({ lockedOut: true, speedMps: 40 * MPH });
    await hold('hud-end', HOLD_TO_ACT_MS - 1);
    expect(h.host.end).not.toHaveBeenCalled();
    await act(() => jest.advanceTimersByTime(1));
    expect(mockRouter.replace).toHaveBeenCalledWith('/drive/end');
    expect(h.host.end).toHaveBeenCalledTimes(1);
  });

  test('a hold released early ends nothing', async () => {
    const h = await renderHud({ lockedOut: false, speedMps: 0 });
    await hold('hud-end', 1500);
    await fireEvent(screen.getByTestId('hud-end'), 'pressOut');
    await act(() => jest.advanceTimersByTime(5000));
    expect(h.host.end).not.toHaveBeenCalled();
  });

  test('a 2 s hold on SOS opens the dialer with the region’s emergency number', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    jest
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ locale: 'en-GB' } as Intl.ResolvedDateTimeFormatOptions);
    const h = await renderHud({ lockedOut: true });
    await hold('hud-sos');
    expect(open).toHaveBeenCalledWith('tel:112');
    expect(h.host.end).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  test('SOS defaults to 911 when the region is unknown, and a refused dialer is silent', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no dialer'));
    jest
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ locale: 'en' } as Intl.ResolvedDateTimeFormatOptions);
    await renderHud();
    await hold('hud-sos');
    await act(async () => {});
    expect(open).toHaveBeenCalledWith('tel:911');
    jest.restoreAllMocks();
  });

  test('the SOS and End buttons name themselves and their hold for a screen reader', async () => {
    await renderHud();
    const sos = screen.getByRole('button', { name: hudCopy.hud.sosLabel });
    expect(sos).toHaveProp('accessibilityHint', hudCopy.hud.sosHint);
    const end = screen.getByRole('button', { name: hudCopy.hud.endLabel });
    expect(end).toHaveProp('accessibilityHint', hudCopy.hud.endHint);
    expect(screen.getByText(hudCopy.hud.sos)).toBeTruthy();
    expect(screen.getByText(hudCopy.hud.end)).toBeTruthy();
  });

  test('with no drive open there is no End, and SOS is still there', async () => {
    await renderHud({ status: 'armed', clientTripId: null, lockedOut: false, startedAt: null });
    expect(screen.queryByTestId('hud-end')).toBeNull();
    expect(screen.getByTestId('hud-sos')).toBeTruthy();
    expect(screen.queryByTestId('hud-timer')).toBeNull();
  });

  test('End is offered in the gap window (ending) as well', async () => {
    await renderHud({ status: 'ending', lockedOut: false, speedMps: 0 });
    expect(screen.getByTestId('hud-end')).toBeTruthy();
  });
});

describe('HudScreen: the end of the drive', () => {
  test('finalizing replaces the HUD with the end screen', async () => {
    const h = await renderHud({ lockedOut: false, speedMps: 0 });
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await h.push({ status: 'finalizing' });
    expect(mockRouter.replace).toHaveBeenCalledWith('/drive/end');
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  });

  test('a close that skips straight to armed (batched renders) still reaches the end screen', async () => {
    const h = await renderHud({ lockedOut: false, speedMps: 0 });
    await h.push({ status: 'armed', clientTripId: null });
    expect(mockRouter.replace).toHaveBeenCalledWith('/drive/end');
  });

  test('a HUD opened with no drive at all does not claim one ended', async () => {
    await renderHud({ status: 'armed', clientTripId: null, lockedOut: false });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('as the lockout overlay it never routes on its own; its End pushes the end screen, then ends', async () => {
    const h = await renderHud({ lockedOut: true }, { overlay: true });
    await hold('hud-end');
    expect(mockRouter.push).toHaveBeenCalledWith('/drive/end');
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(h.host.end).toHaveBeenCalledTimes(1);
    await h.push({ status: 'finalizing', lockedOut: false });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});

describe('HudScreen: the trip timer', () => {
  test('shows H:MM since the drive began, on the row clock, moving once a minute', async () => {
    const h = await renderHud({ startedAt: T - (67 * 60_000 + 45_000) });
    expect(screen.getByTestId('hud-timer')).toHaveTextContent('1:07');
    await h.push({ lastRowTs: T + 14_000 });
    expect(screen.getByTestId('hud-timer')).toHaveTextContent('1:07');
    await h.push({ lastRowTs: T + 15_000 });
    expect(screen.getByTestId('hud-timer')).toHaveTextContent('1:08');
  });

  test('a minute-only selector: a row that does not change the minute re-renders no timer', async () => {
    const h = await renderHud({ startedAt: T });
    const timer = screen.getByTestId('hud-timer');
    await h.push({ lastRowTs: T + 1000, speedMps: 21 * MPH });
    expect(screen.getByTestId('hud-timer')).toBe(timer);
    expect(screen.getByTestId('hud-timer')).toHaveTextContent('0:00');
  });
});

describe('HudScreen: palette and layout', () => {
  test('day: the ink-black ground, the day ink, no hazard', async () => {
    mockPosition.current = SEATTLE;
    await renderHud();
    expect(flat<{ backgroundColor: string }>(screen.getByTestId('hud-screen')).backgroundColor).toBe(
      HUD.day.ground
    );
    expect(numeralInk()).toBe(HUD.day.ink);
    expect(screen.queryByTestId('hud-hazard')).toBeNull();
  });

  test('night by the sun at the last known position: the night palette, and no night chip', async () => {
    jest.setSystemTime(Date.UTC(2026, 8, 23, 6, 0, 0)); // 23:00 in Seattle
    mockPosition.current = SEATTLE;
    await renderHud();
    expect(numeralInk()).toBe(HUD.night.ink);
    expect(haloColor()).toBe(HUD.night.calm);
    expect(screen.queryByTestId('hud-hazard')).toBeNull();
  });

  test('the same instant is day where the sun is up (the position decides, not the clock)', async () => {
    jest.setSystemTime(Date.UTC(2026, 8, 23, 6, 0, 0)); // 23:00 Seattle = 16:00 in Tokyo
    mockPosition.current = { coords: { latitude: 35.68, longitude: 139.69 } };
    await renderHud();
    expect(numeralInk()).toBe(HUD.day.ink);
  });

  test("with no cached position it falls back to the host's night rule", async () => {
    mockPosition.current = null;
    await renderHud({}, { night: true });
    expect(numeralInk()).toBe(HUD.night.ink);
  });

  test('m1: at night the very first paint is already the night palette (no day flash)', async () => {
    mockPosition.pending = true; // the OS never answers during this test
    const h = stubHost(state(), true);
    await render(wrap(h.host, <HudScreen />));
    expect(numeralInk()).toBe(HUD.night.ink);
  });

  test('lays the halo and the sign side by side for a landscape mount', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native/Libraries/Utilities/useWindowDimensions');
    const spy = jest
      .spyOn(mod, 'default')
      .mockReturnValue({ width: 844, height: 390, scale: 3, fontScale: 1 });
    await renderHud();
    expect(screen.getByTestId('hud-layout-landscape')).toBeTruthy();
    expect(screen.queryByTestId('hud-layout-portrait')).toBeNull();
    const ring = flat<{ width: number; height: number }>(screen.getByTestId('hud-halo'));
    expect(ring.width).toBe(ring.height);
    expect(ring.width).toBeLessThanOrEqual(390);
    expect(ring.width).toBeGreaterThanOrEqual(180);
    spy.mockRestore();
  });

  test('portrait by default, with the halo sized to the width', async () => {
    await renderHud();
    expect(screen.getByTestId('hud-layout-portrait')).toBeTruthy();
    const ring = flat<{ width: number }>(screen.getByTestId('hud-halo'));
    expect(ring.width).toBeGreaterThanOrEqual(180);
    expect(ring.width).toBeLessThanOrEqual(320);
  });

  test('m3: a speed-only row re-renders the readout, not the halo', async () => {
    const h = await renderHud({ speedMps: 20 * MPH, limit: posted(35) });
    const before = mockRenders.halo;
    await h.push({ speedMps: 21 * MPH, lastRowTs: T + 1000 });
    await h.push({ speedMps: 22 * MPH, lastRowTs: T + 2000 });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('22');
    expect(mockRenders.halo).toBe(before);
    // Crossing the tolerance is a level change, and that does reach the halo.
    await h.push({ speedMps: 45 * MPH, lastRowTs: T + 3000 });
    expect(mockRenders.halo).toBeGreaterThan(before);
  });
});
