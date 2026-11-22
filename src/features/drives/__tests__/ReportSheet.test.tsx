/**
 * The recap's report sheet while it closes. iOS keeps drawing a closing modal's content until its
 * fade-out has finished, so the sheet must fade out as it stood, not empty first. Jest's own Modal
 * draws nothing once it is told to hide; the one here keeps drawing, as iOS does mid-fade.
 */
import { act, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { ThemeProvider } from '@/ui/theme';

import { event, press } from '../__fixtures__/drives';
import type { LocalDriveEvent } from '../model';
import { ReportSheet } from '../ReportSheet';

jest.mock('react-native/Libraries/Modal/Modal', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: import('react').ReactNode }) => React.createElement(View, null, children),
  };
});

const onSend = jest.fn(async () => undefined);
const sheet = (e: LocalDriveEvent | null) => (
  <ReportSheet event={e} allowNotDriving onClose={jest.fn()} onSend={onSend} onNotDriving={jest.fn()} />
);

const Theme = ({ children }: { children: ReactNode }) => (
  <ThemeProvider scheme="light" reduceMotion>
    {children}
  </ThemeProvider>
);
const draw = (e: LocalDriveEvent | null) => render(sheet(e), { wrapper: Theme });

beforeEach(() => onSend.mockClear());

test('closing keeps the event, the reason chosen and the button as they stood while the sheet fades out; a tap meanwhile sends nothing', async () => {
  const hardBrake = event();
  const view = await draw(hardBrake);
  await press(screen.getByTestId('reason-hazard'));
  await view.rerender(sheet(null));
  expect(screen.getByText(/^Hard brake · .* at /)).toBeOnTheScreen();
  expect(screen.getByTestId('reason-hazard')).toBeChecked();
  expect(screen.getByTestId('reason-not_driving')).toBeOnTheScreen();
  expect(screen.getByTestId('report-send')).toBeEnabled();
  await press(screen.getByTestId('report-send'));
  expect(onSend).not.toHaveBeenCalled();
});

test('opened again, or on another event, it starts a fresh report; a fresh copy of the same event keeps it', async () => {
  const hardBrake = event();
  const view = await draw(hardBrake);
  await press(screen.getByTestId('reason-hazard'));
  // A refetch hands over a new copy of the same event: the choice stays.
  await view.rerender(sheet({ ...hardBrake }));
  expect(screen.getByTestId('reason-hazard')).toBeChecked();
  // Closed and opened again: fresh.
  await view.rerender(sheet(null));
  await view.rerender(sheet(hardBrake));
  expect(screen.getByTestId('reason-hazard')).not.toBeChecked();
  expect(screen.getByTestId('report-send')).toBeDisabled();
  // Another event: fresh.
  await press(screen.getByTestId('reason-hazard'));
  await view.rerender(sheet(event({ id: 'e2' })));
  expect(screen.getByTestId('reason-hazard')).not.toBeChecked();
});

test('the thanks after a sent report stays while the sheet fades out', async () => {
  const view = await draw(event());
  await press(screen.getByTestId('reason-hazard'));
  await act(async () => {
    await press(screen.getByTestId('report-send'));
  });
  expect(onSend).toHaveBeenCalledWith('e1', 'hazard');
  expect(screen.getByTestId('report-sent')).toBeOnTheScreen();
  await view.rerender(sheet(null));
  expect(screen.getByTestId('report-sent')).toBeOnTheScreen();
});
