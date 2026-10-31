/**
 * The two error boundaries under the real expo-router: the root layout's (`AppCrashed`) and the
 * driving screen's (`app/drive/_layout.tsx`, `HudCrashed`). A screen that throws while drawing
 * shows the fallback instead of a blank app, the error goes to the crash sink once, and Try again
 * draws the screen again.
 */
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Stack } from 'expo-router';
import { Text } from 'react-native';

import { AppCrashed, appCrashedCopy } from '@/boot/AppCrashed';
import { HUD_CRASHED_TARGET_W_PT, HudCrashed } from '@/features/drive/HudCrashed';
import { hudCopy } from '@/features/drive/hudCopy';
import { t } from '@/i18n';
import { reportError } from '@/lib/crashReport';
import { HUD_MIN_TARGET_PT } from '@/ui/drive';

import * as DriveLayout from '../drive/_layout';

jest.mock('@/lib/crashReport', () => ({ reportError: jest.fn() }));

const report = reportError as jest.Mock;

/** A screen that throws while `broken` is set, and draws its words once it is not. */
let broken = true;
function Flaky({ words }: { words: string }) {
  if (broken) throw new Error('render failed');
  return <Text>{words}</Text>;
}

beforeEach(() => {
  broken = true;
  report.mockClear();
  // React logs every error a boundary catches; the fallback is what is under test.
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

function flatStyle(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
}

describe('the root error boundary', () => {
  const routes = {
    _layout: { default: () => <Stack screenOptions={{ headerShown: false }} />, ErrorBoundary: AppCrashed },
    index: () => <Flaky words="Home" />,
  };

  test('a screen that throws shows "Something went wrong" and Try again, and the error goes to the sink once', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText(appCrashedCopy.title)).toBeTruthy();
    expect(screen.getByText(appCrashedCopy.body)).toBeTruthy();
    expect(screen.getByRole('header', { name: appCrashedCopy.title })).toBeTruthy();
    expect(screen.getByTestId('app-crashed-retry')).toBeTruthy();
    expect(screen.getByText(t('common.retry'))).toBeTruthy();
    expect(screen.queryByText('Home')).toBeNull();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'render failed' }), 'root screen');
  });

  test('Try again draws the screen again', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    await screen.findByText(appCrashedCopy.title);
    broken = false;
    await act(async () => {
      fireEvent.press(screen.getByTestId('app-crashed-retry'));
    });
    expect(await screen.findByText('Home')).toBeTruthy();
    expect(screen.queryByText(appCrashedCopy.title)).toBeNull();
  });

  test('Try again on a screen that still throws shows the fallback again', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    await screen.findByText(appCrashedCopy.title);
    await act(async () => {
      fireEvent.press(screen.getByTestId('app-crashed-retry'));
    });
    expect(await screen.findByText(appCrashedCopy.title)).toBeTruthy();
    expect(screen.queryByText('Home')).toBeNull();
  });
});

describe('the driving screen error boundary', () => {
  const routes = {
    _layout: () => <Stack screenOptions={{ headerShown: false }} />,
    index: () => <Text>Home</Text>,
    'drive/_layout': DriveLayout,
    'drive/index': () => <Flaky words="Speed" />,
  };

  test('app/drive/_layout exports HudCrashed as its ErrorBoundary', () => {
    expect(DriveLayout.ErrorBoundary).toBe(HudCrashed);
  });

  test('a driving screen that throws shows three words and one 64 pt Try again, and stays on the drive route', async () => {
    const app = renderRouter(routes, { initialUrl: '/drive' });
    await app;
    expect(await screen.findByText(hudCopy.crashed.title)).toBeTruthy();
    expect(hudCopy.crashed.title.split(/\s+/)).toHaveLength(3);
    expect(hudCopy.crashed.retry.split(/\s+/).length).toBeLessThanOrEqual(3);
    const retry = screen.getByTestId('hud-crashed-retry');
    expect(retry.props.accessibilityLabel).toBe(hudCopy.crashed.retry);
    const style = flatStyle(retry.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(HUD_MIN_TARGET_PT);
    expect(style.minWidth).toBe(HUD_CRASHED_TARGET_W_PT);
    // The spoken label says the drive is untouched; there is no way Home from here.
    expect(screen.getByLabelText(hudCopy.crashed.spoken)).toBeTruthy();
    expect(screen.queryByText('Home')).toBeNull();
    expect(app.getPathname()).toBe('/drive');
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'render failed' }), 'driving screen');
  });

  test('Try again draws the driving screen again', async () => {
    const app = renderRouter(routes, { initialUrl: '/drive' });
    await app;
    await screen.findByText(hudCopy.crashed.title);
    broken = false;
    await act(async () => {
      fireEvent.press(screen.getByTestId('hud-crashed-retry'));
    });
    expect(await screen.findByText('Speed')).toBeTruthy();
    expect(screen.queryByText(hudCopy.crashed.title)).toBeNull();
    expect(app.getPathname()).toBe('/drive');
  });
});
