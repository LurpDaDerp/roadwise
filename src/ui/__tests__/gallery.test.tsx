import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { UiGallery } from '@/ui/gallery/UiGallery';

// The count-up runs on requestAnimationFrame; drive it with fake timers inside act() so no frame
// lands after a test has finished.
beforeEach(() => jest.useFakeTimers());
afterEach(async () => {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

test.each(['light', 'dark'] as const)('the gallery renders every primitive in %s', async (scheme) => {
  await render(
    <SafeAreaProvider>
      <UiGallery initialScheme={scheme} />
    </SafeAreaProvider>
  );
  expect(screen.getByRole('header', { name: 'Design system' })).toBeOnTheScreen();
  expect(screen.getByLabelText('maya_drives')).toBeOnTheScreen();
  expect(screen.getByText('Take your first drive')).toBeOnTheScreen();
});

test('the gallery switches theme and reduce motion', async () => {
  await render(
    <SafeAreaProvider>
      <UiGallery />
    </SafeAreaProvider>
  );
  await fireEvent.press(screen.getByRole('tab', { name: 'Dark' }));
  expect(screen.getByRole('tab', { name: 'Dark' })).toBeSelected();
  await fireEvent.press(screen.getByRole('switch', { name: 'Reduce motion' }));
  expect(screen.getByRole('switch', { name: 'Reduce motion' })).toBeChecked();
});

test('the gallery previews any hour with any weather: the page sky, its weather layer and a scene card', async () => {
  await render(
    <SafeAreaProvider>
      <UiGallery />
    </SafeAreaProvider>
  );
  expect(screen.getByTestId('sky-backdrop', { includeHiddenElements: true })).toBeOnTheScreen();
  expect(screen.queryByTestId('sky-ambient', { includeHiddenElements: true })).toBeNull();
  // The preview's greeting sits on the sky in the white sky ink.
  expect(screen.getByRole('header', { name: 'Hey, maya' })).toHaveStyle({ color: '#FFFFFF' });
  await fireEvent.press(screen.getByRole('button', { name: 'dusk' }));
  await fireEvent.press(screen.getByRole('button', { name: 'rain' }));
  expect(screen.getByRole('button', { name: 'dusk' })).toBeSelected();
  expect(screen.getByTestId('sky-ambient', { includeHiddenElements: true })).toBeOnTheScreen();
});
