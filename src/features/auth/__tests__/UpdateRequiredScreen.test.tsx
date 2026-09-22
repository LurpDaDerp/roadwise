import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { UpdateRequiredScreen, updateRequiredCopy } from '@/features/auth/UpdateRequiredScreen';
import { ThemeProvider } from '@/ui/theme';

import UpdateRequiredRoute from '../../../../app/update-required';

const mockConfig: { store_urls: { ios?: string; android?: string } } = { store_urls: {} };
jest.mock('@/data/config/appConfig', () => ({
  useAppConfig: () => ({ config: mockConfig, ready: true }),
}));

const IOS = 'itms-apps://apps.apple.com/app/id000000';
const ANDROID = 'market://details?id=app.roadwise';

async function mount(storeUrl: string | null, open = jest.fn(async (_url: string) => {})) {
  await render(
    <ThemeProvider>
      <UpdateRequiredScreen storeUrl={storeUrl} open={open} />
    </ThemeProvider>
  );
  return open;
}

test('says what is needed, as a heading', async () => {
  await mount(IOS);
  expect(screen.getByRole('header', { name: 'Update RoadWise to keep going' })).toBeOnTheScreen();
});

test('with a store link: one action, opening that link', async () => {
  const open = await mount(IOS);
  const button = screen.getByRole('button', { name: updateRequiredCopy.getUpdate });
  expect(button.props.accessibilityHint).toBe('Opens the app store');
  await fireEvent.press(button);
  expect(open).toHaveBeenCalledWith(IOS);
  expect(screen.queryByText(updateRequiredCopy.noStore)).toBeNull();
});

test('no store link (internal builds): says where the update comes from, and offers no link', async () => {
  await mount(null);
  expect(screen.getByText('Update RoadWise from where you installed it')).toBeOnTheScreen();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
});

test('a store that will not open says so, and where else to get the update', async () => {
  await mount(ANDROID, jest.fn(async (_url: string) => { throw new Error('no handler'); }));
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: updateRequiredCopy.getUpdate }));
  });
  expect(screen.getByText(updateRequiredCopy.openFailed)).toBeOnTheScreen();
});

describe('the route picks this platform’s link', () => {
  const original = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    mockConfig.store_urls = {};
  });

  test.each([
    ['ios', { ios: IOS, android: ANDROID }, true],
    ['android', { ios: IOS, android: ANDROID }, true],
    ['ios', { android: ANDROID }, false],
    ['android', { ios: IOS }, false],
  ] as const)('%s with %j → a store button: %s', async (os, urls, hasButton) => {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    mockConfig.store_urls = { ...urls };
    await render(
      <ThemeProvider>
        <UpdateRequiredRoute />
      </ThemeProvider>
    );
    if (hasButton) expect(screen.getByRole('button', { name: updateRequiredCopy.getUpdate })).toBeOnTheScreen();
    else expect(screen.getByText(updateRequiredCopy.noStore)).toBeOnTheScreen();
  });
});
