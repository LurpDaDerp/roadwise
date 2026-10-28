/**
 * The re-aim sheet (`ui/ReaimSheet.tsx`): the paired DashPal's live picture with the setup's frame and
 * hint (a good aim says Done, not Next), Try again on a refusal it can help with, firmware too old for
 * the picture, screenshots blocked while it shows, and Done stopping the picture.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ThemeProvider } from '@/ui';

import { createFakeDashcamRuntime, PAIRED } from '../__fixtures__/fakeRuntime';
import { dashpalCopy } from '../copy';
import { setActiveDashcam } from '../registry';
import { ReaimSheet } from '../ui/ReaimSheet';

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));
jest.mock('expo-screen-capture', () => ({ usePreventScreenCapture: jest.fn() }));
jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- inside the mock factory
  const { View } = require('react-native') as typeof import('react-native');
  return { Image: (p: Record<string, unknown>) => <View {...p} /> };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocks above
const capture = require('expo-screen-capture') as { usePreventScreenCapture: jest.Mock };

const copy = dashpalCopy.screen.reaim;
const record = (frame: number, data: number[]): number[] => [1, 1, frame, 0, data.length & 0xff, data.length >> 8, 0, 0, ...data];

function connected(firmware = 'dms-core 3.6') {
  const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connected', paired: PAIRED, firmware } });
  const view = rt.withPairedView();
  setActiveDashcam(rt);
  return { rt, view };
}

const renderSheet = async (onClose = jest.fn()) =>
  await render(
    <ThemeProvider>
      <ReaimSheet visible onClose={onClose} />
    </ThemeProvider>
  );

afterEach(async () => {
  await act(async () => setActiveDashcam(null));
});

test('the live picture: the image as a mirror, a good aim says tap Done; screenshots are blocked; Done stops the picture without Recalibrate', async () => {
  const { rt, view } = connected();
  const onClose = jest.fn();
  await renderSheet(onClose);
  await waitFor(() => expect(rt.log).toContain('command:10:1'));
  expect(capture.usePreventScreenCapture).toHaveBeenCalledWith('dashpal-reaim');
  await act(async () => {
    rt.viewFrame({ type: 'VIEW_STATE', on: 1, reason: 0, leftS: 600 });
    view.record(record(1, [0xff, 0xd8, 0xff, 0xd9]));
    rt.viewFrame({ type: 'AIM', seq: 1, score: 95, hint: 0, flags: 7, iod: 52, yaw: 0, pitch: 0 });
  });
  await waitFor(() => expect(screen.getByTestId('aim-hint')).toHaveTextContent(copy.good));
  expect(screen.getByTestId('reaim-privacy')).toHaveTextContent(copy.privacy);
  await act(async () => {
    fireEvent.press(screen.getByTestId('reaim-done'));
  });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(rt.log).toContain('command:10:0');
  expect(rt.log).not.toContain('command:2:0');
  expect(view.subscribed()).toBe(false);
});

test('a refusal Try again can help with offers it, and it asks once more', async () => {
  const { rt } = connected();
  await renderSheet();
  await waitFor(() => expect(rt.log).toContain('command:10:1'));
  await act(async () => rt.viewFrame({ type: 'VIEW_STATE', on: 0, reason: 2, leftS: 600 }));
  expect(await screen.findByTestId('reaim-refused')).toHaveTextContent(copy.refused.moving);
  await act(async () => {
    fireEvent.press(screen.getByTestId('reaim-retry'));
  });
  await waitFor(() => expect(rt.log.filter((c) => c === 'command:10:1')).toHaveLength(2));
});

test('firmware before 3.6: no picture asked, the update said; Done recalibrates', async () => {
  const { rt } = connected('dms-core 3.5');
  const onClose = jest.fn();
  await renderSheet(onClose);
  expect(await screen.findByTestId('reaim-status')).toHaveTextContent(copy.unsupported);
  expect(screen.queryByTestId('aim-video')).toBeNull();
  await act(async () => {
    fireEvent.press(screen.getByTestId('reaim-done'));
  });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(rt.log).toEqual(['command:2:0']);
});
