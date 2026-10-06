import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { DriveState } from '@/drive/host';
import { ThemeProvider } from '@/ui';

import { DriveInProgressBanner } from '../DriveInProgressBanner';
import { DRIVE_HREF, hudCopy } from '../hudCopy';

const mockRouter = { navigate: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

let mockStatus: DriveState['status'] = 'recording';
jest.mock('@/drive/useDrive', () => ({
  useDrive: <T,>(sel: (s: Pick<DriveState, 'status'>) => T) => sel({ status: mockStatus }),
}));

async function renderBanner(status: DriveState['status']) {
  mockStatus = status;
  await render(
    <ThemeProvider scheme="light">
      <DriveInProgressBanner />
    </ThemeProvider>
  );
}

beforeEach(() => jest.clearAllMocks());

test('hidden unless a drive is recording', async () => {
  await renderBanner('idle');
  expect(screen.queryByTestId('drive-in-progress')).toBeNull();
  await renderBanner('finalizing');
  expect(screen.queryByTestId('drive-in-progress')).toBeNull();
});

test('a tap goes back to the driving screen', async () => {
  await renderBanner('recording');
  expect(screen.getByText(hudCopy.banner.title)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: hudCopy.banner.label }));
  expect(mockRouter.navigate).toHaveBeenCalledWith(DRIVE_HREF);
});

test('the target is at least 44 pt tall', async () => {
  await renderBanner('recording');
  const style = StyleSheet.flatten(screen.getByTestId('drive-in-progress').props.style) as { minHeight: number };
  expect(style.minHeight).toBeGreaterThanOrEqual(44);
});
