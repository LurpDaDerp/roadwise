/**
 * Screen 3, the aiming picture: two image layers loaded with no cache and shown as a mirror, nothing
 * drawn on the face, the frame's colour and the hint following DashPal's AIM frames, no verdict on a
 * stale reading, the good latch with its check, haptic and announcement, the picture covered and
 * dropped the moment RoadWise leaves the front, screenshots blocked while it shows, the refusals with
 * Try again where it helps, and Next at every moment.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { AccessibilityInfo, AppState, StyleSheet, type AppStateStatus } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';

import { ThemeProvider } from '@/ui';
import { tokens } from '@/ui/tokens';

import { AIM_BORDER, AIM_BORDER_GOOD, aimColor, hintText } from '../aim';
import { dashpalCopy } from '../copy';
import type { AimFrame, ViewReason } from '../protocol';
import type { AimStatus } from '../setup';
import { StepAim } from '../ui/wizard/StepAim';
import { jpegDataUri } from '../view';

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));
jest.mock('expo-screen-capture', () => ({ usePreventScreenCapture: jest.fn() }));
// expo-image as a plain view that keeps the props the screen gives it.
jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- inside the mock factory
  const { View } = require('react-native') as typeof import('react-native');
  return { Image: (p: Record<string, unknown>) => <View {...p} /> };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocks above
const haptics = require('expo-haptics') as { notificationAsync: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocks above
const capture = require('expo-screen-capture') as { usePreventScreenCapture: jest.Mock };

const aimCopy = dashpalCopy.wizard.aim;

/** A flow's two listener hooks, fed by the test. */
function feed() {
  const frames = new Set<(j: Uint8Array) => void>();
  const aims = new Set<(a: AimFrame | null) => void>();
  return {
    flow: {
      onViewFrame: (fn: (j: Uint8Array) => void) => {
        frames.add(fn);
        return () => void frames.delete(fn);
      },
      onAim: (fn: (a: AimFrame | null) => void) => {
        aims.add(fn);
        return () => void aims.delete(fn);
      },
    },
    image: (bytes: number[]) =>
      act(() => {
        for (const fn of [...frames]) fn(Uint8Array.from(bytes));
      }),
    aim: (score: number, hint = score >= 90 ? 0 : 6) =>
      act(() => {
        for (const fn of [...aims]) fn({ type: 'AIM', seq: 1, score, hint, flags: score >= 90 ? 7 : 3, iod: 60, yaw: 0, pitch: 0 });
      }),
    listeners: () => frames.size + aims.size,
  };
}

let appState: ((s: AppStateStatus) => void) | null = null;
let say: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  haptics.notificationAsync.mockClear();
  capture.usePreventScreenCapture.mockClear();
  // React Native's jest setup already mocks it: the spy is that mock, cleared here.
  say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  say.mockClear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, fn) => {
    appState = fn as (s: AppStateStatus) => void;
    return { remove: () => void (appState = null) } as ReturnType<typeof AppState.addEventListener>;
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function Screen(p: { f: ReturnType<typeof feed>; status?: AimStatus; reason?: ViewReason | null; onNext?: () => void; onRetry?: () => void }): ReactElement {
  return (
    <StepAim
      status={p.status ?? 'live'}
      reason={p.reason ?? null}
      holdLeftS={null}
      reconnecting={false}
      step="Step 3 of 3"
      flow={p.f.flow}
      onRetry={p.onRetry ?? (() => {})}
      onNext={p.onNext ?? (() => {})}
    />
  );
}

async function show(ui: ReactElement, o: { reduceMotion?: boolean; scheme?: 'light' | 'dark' } = {}) {
  return await render(
    <ThemeProvider reduceMotion={o.reduceMotion ?? true} scheme={o.scheme ?? 'light'}>
      {ui}
    </ThemeProvider>
  );
}

/** The frame's style as drawn now (Reanimated's animated style included). */
const border = () => getAnimatedStyle(screen.getByTestId('aim-border')) as { borderColor?: string; borderWidth?: number };
const hint = () => screen.getByTestId('aim-hint');
/** `#rrggbb` or Reanimated's `rgba(r, g, b, a)` as `#rrggbb`. */
const rgb = (c: string | undefined): string => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c ?? '');
  return m ? `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}` : (c ?? '').toLowerCase();
};
const layers = () => ['a', 'b'].map((k) => screen.queryByTestId(`aim-layer-${k}`, { includeHiddenElements: true }));
const advance = (ms: number) => act(() => void jest.advanceTimersByTime(ms));

describe('the picture', () => {
  it('two layers, no cache, no fade, shown as a mirror; the newest image loads in the back one and becomes the front once loaded', async () => {
    const f = feed();
    await show(<Screen f={f} />);
    expect(layers()).toEqual([null, null]);
    const img = (n: number) => [0xff, 0xd8, n, 0xff, 0xd9];
    const layer = (k: 'a' | 'b') => screen.getByTestId(`aim-layer-${k}`, { includeHiddenElements: true });
    const opacity = (k: 'a' | 'b') => StyleSheet.flatten(layer(k).props.style).opacity;
    await f.image(img(1));
    expect(layer('b').props).toMatchObject({ cachePolicy: 'none', transition: 0, contentFit: 'cover', source: { uri: jpegDataUri(img(1)) } });
    expect(StyleSheet.flatten(layer('b').props.style).transform).toEqual([{ scaleX: -1 }]);
    expect(opacity('b')).toBe(0);
    await act(async () => fireEvent(layer('b'), 'load'));
    expect(opacity('b')).toBe(1);
    // The next image goes to the other layer, hidden until it loads; a newer one meanwhile replaces it.
    await f.image(img(2));
    expect(layer('a').props.source).toEqual({ uri: jpegDataUri(img(2)) });
    expect(opacity('a')).toBe(0);
    await f.image(img(3));
    expect(layer('a').props.source).toEqual({ uri: jpegDataUri(img(3)) });
    expect(layer('b').props.source).toEqual({ uri: jpegDataUri(img(1)) });
    await act(async () => fireEvent(layer('a'), 'load'));
    expect([opacity('a'), opacity('b')]).toEqual([1, 0]);
  });

  it('draws nothing on the face: no box, landmark, rectangle or face mark', async () => {
    const f = feed();
    const r = await show(<Screen f={f} />);
    await f.image([0xff, 0xd8, 0xff, 0xd9]);
    await f.aim(95, 0);
    const ids: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const node = n as { props?: { testID?: string }; children?: unknown[] };
      if (node.props?.testID) ids.push(node.props.testID);
      for (const c of node.children ?? []) walk(c);
    };
    walk(r.toJSON());
    expect(ids.length).toBeGreaterThan(3);
    expect(ids.filter((id) => /box|landmark|rect|face|bbox/i.test(id))).toEqual([]);
  });

  it('one element for a screen reader: an image named “What DashPal’s camera sees”, its value the hint', async () => {
    const f = feed();
    await show(<Screen f={f} />);
    await f.aim(40, 7);
    const v = screen.getByTestId('aim-video');
    expect(v.props).toMatchObject({ accessible: true, accessibilityRole: 'image', accessibilityLabel: 'What DashPal’s camera sees', accessibilityValue: { text: hintText(7) } });
  });

  it('blocks screenshots and the app switcher’s picture while it is shown', async () => {
    await show(<Screen f={feed()} />);
    expect(capture.usePreventScreenCapture).toHaveBeenCalled();
  });

  it.each(['inactive', 'background'] as const)('RoadWise %s: covered, and the images and the reading dropped in that render', async (state) => {
    const f = feed();
    await show(<Screen f={f} />);
    await f.image([0xff, 0xd8, 0xff, 0xd9]);
    await f.aim(95, 0);
    expect(layers().some(Boolean)).toBe(true);
    await act(() => appState!(state));
    expect(screen.getByTestId('aim-cover', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(layers()).toEqual([null, null]);
    expect(hint()).toHaveTextContent(aimCopy.waiting);
    await advance(20);
    expect(border().borderColor).toBe(tokens.color.light.borderStrong);
    await act(() => appState!('active'));
    expect(screen.queryByTestId('aim-cover', { includeHiddenElements: true })).toBeNull();
  });
});

describe('the frame and the hint', () => {
  it.each(['light', 'dark'] as const)('%s: the frame’s colour follows the score at once under Reduce Motion; the hint follows the hint code', async (scheme) => {
    const f = feed();
    await show(<Screen f={f} />, { scheme });
    for (const [score, hintCode] of [
      [10, 1],
      [40, 2],
      [55, 6],
      [75, 9],
      [96, 0],
    ] as const) {
      await f.aim(score, hintCode);
      await advance(20);
      expect(rgb(border().borderColor)).toBe(aimColor(score / 100, scheme));
      expect(hint()).toHaveTextContent(hintText(hintCode));
    }
  });

  it('no AIM for a second: a neutral frame, “Waiting for the picture…”, no verdict', async () => {
    const f = feed();
    await show(<Screen f={f} />);
    await f.aim(30, 6);
    await advance(20);
    expect(rgb(border().borderColor)).toBe(aimColor(0.3, 'light'));
    await advance(1300);
    await advance(20);
    expect(hint()).toHaveTextContent('Waiting for the picture…');
    expect(border().borderColor).toBe(tokens.color.light.borderStrong);
    expect(screen.queryByTestId('aim-good')).toBeNull();
  });

  it('before any AIM: neutral and waiting', async () => {
    await show(<Screen f={feed()} />);
    expect(hint()).toHaveTextContent('Waiting for the picture…');
    expect(border()).toMatchObject({ borderColor: tokens.color.light.borderStrong, borderWidth: AIM_BORDER });
  });

  it('good for a second: “Good position” with a check, a wider frame, one success haptic and the announcement; it holds through one low score', async () => {
    const f = feed();
    await show(<Screen f={f} />);
    for (let i = 0; i < 5; i++) {
      await f.aim(95, 0);
      await advance(200);
    }
    expect(screen.queryByTestId('aim-good')).toBeNull();
    await f.aim(95, 0);
    // (after the check glyph)
    expect(screen.getByTestId('aim-good')).toHaveTextContent(/Good position$/);
    expect(border().borderWidth).toBe(AIM_BORDER_GOOD);
    expect(haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(haptics.notificationAsync).toHaveBeenCalledWith('success');
    expect(say).toHaveBeenLastCalledWith('Good position');
    await advance(200);
    await f.aim(60, 6);
    await advance(200);
    await f.aim(95, 0);
    expect(screen.getByTestId('aim-good')).toBeOnTheScreen();
    expect(haptics.notificationAsync).toHaveBeenCalledTimes(1);
  });

  it('a hint is said once it has held 1 s, not at every frame', async () => {
    const f = feed();
    await show(<Screen f={f} />);
    for (let i = 0; i < 4; i++) {
      await f.aim(40, 7);
      await advance(200);
    }
    expect(say.mock.calls).toEqual([]);
    for (let i = 0; i < 3; i++) {
      await f.aim(40, 7);
      await advance(200);
    }
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith(hintText(7));
  });

  it('without Reduce Motion the frame still reaches the score’s colour', async () => {
    const f = feed();
    await show(<Screen f={f} />, { reduceMotion: false });
    await f.aim(96, 0);
    await advance(600);
    expect(rgb(border().borderColor)).toBe(aimColor(0.96, 'light'));
  });
});

describe('the states and Next', () => {
  it('starting: “Starting the camera…”; stalled: “The picture stopped. Hold on…”', async () => {
    const f = feed();
    const r = await show(<Screen f={f} status="starting" />);
    expect(hint()).toHaveTextContent('Starting the camera…');
    await r.rerender(
      <ThemeProvider reduceMotion scheme="light">
        <Screen f={f} status="stalled" />
      </ThemeProvider>
    );
    expect(hint()).toHaveTextContent('The picture stopped. Hold on…');
  });

  it.each([
    ['moving', 'Stop the car to aim DashPal.', true],
    ['drive', 'Finish your drive first.', false],
    ['budget', 'Aiming time is used up for now. Press DashPal’s button 5 times to aim it again.', false],
    ['busy', 'DashPal’s camera is busy. Try again in a moment.', true],
    ['camera', 'DashPal’s camera isn’t ready. Try again in a moment.', true],
    ['memory', 'DashPal’s camera isn’t ready. Try again in a moment.', true],
    ['no_state', 'The picture stopped. Try again.', true],
    ['mtu', 'Your phone’s Bluetooth can’t show the picture. You can go on without it.', false],
    ['not_allowed', 'Your other phone already aimed DashPal.', false],
    ['hold_ended', 'Setup ended. Try again.', false],
  ] as const)('refused %s: “%s”, Try again %s', async (reason, text, retry) => {
    const onRetry = jest.fn();
    await show(<Screen f={feed()} status="refused" reason={reason} onRetry={onRetry} />);
    expect(screen.getByTestId('wizard-aim-refused')).toHaveTextContent(text);
    expect(screen.queryByTestId('aim-hint')).toBeNull();
    if (retry) {
      await act(async () => fireEvent.press(screen.getByTestId('wizard-aim-retry')));
      expect(onRetry).toHaveBeenCalledTimes(1);
    } else expect(screen.queryByTestId('wizard-aim-retry')).toBeNull();
  });

  it.each(['starting', 'live', 'stalled', 'refused'] as const)('%s: Next is there and enabled', async (status) => {
    const onNext = jest.fn();
    await show(<Screen f={feed()} status={status} reason={status === 'refused' ? 'budget' : null} onNext={onNext} />);
    const next = screen.getByTestId('wizard-aim-next');
    expect(next).toHaveTextContent('Next');
    expect(next.props.accessibilityState?.disabled ?? false).toBe(false);
    await act(async () => fireEvent.press(next));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('leaves its listeners when it goes', async () => {
    const f = feed();
    const r = await show(<Screen f={f} />);
    expect(f.listeners()).toBe(2);
    await r.unmount();
    expect(f.listeners()).toBe(0);
  });
});
