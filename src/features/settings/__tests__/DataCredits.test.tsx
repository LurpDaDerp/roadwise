// The foot of Settings credits the weather (Open-Meteo, CC BY 4.0) and the speed limits
// (OpenStreetMap, ODbL; HPMS), as their licences ask.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ThemeProvider } from '@/ui/theme';

import { settingsCopy } from '../copy';
import { CREDIT_URLS, DataCredits } from '../DataCredits';

const mount = async (open = jest.fn(async (_url: string) => {})) => {
  await render(
    <ThemeProvider>
      <DataCredits open={open} />
    </ThemeProvider>
  );
  return open;
};

test('names Open-Meteo and OpenStreetMap with their licences, and HPMS', async () => {
  await mount();
  expect(screen.getByText(settingsCopy.root.credits.line)).toBeOnTheScreen();
  expect(settingsCopy.root.credits.line).toBe(
    'Weather data by Open-Meteo.com (CC BY 4.0). Speed limits © OpenStreetMap contributors (ODbL) and HPMS (FHWA/BTS).'
  );
});

test('a link to each source, opening its own page in the browser', async () => {
  const open = await mount();
  expect(screen.getAllByRole('link')).toHaveLength(2);
  await fireEvent.press(screen.getByRole('link', { name: 'Open-Meteo.com' }));
  await fireEvent.press(screen.getByRole('link', { name: 'OpenStreetMap copyright' }));
  expect(open.mock.calls).toEqual([[CREDIT_URLS.openMeteo], [CREDIT_URLS.osm]]);
  expect(CREDIT_URLS).toEqual({ openMeteo: 'https://open-meteo.com', osm: 'https://www.openstreetmap.org/copyright' });
  for (const link of screen.getAllByRole('link')) expect(link.props.accessibilityHint).toBe('Opens in your browser');
});

test('a browser that will not open is not a crash', async () => {
  await mount(jest.fn(async (_url: string) => Promise.reject(new Error('no browser'))));
  await fireEvent.press(screen.getByRole('link', { name: 'Open-Meteo.com' }));
  expect(screen.getByTestId('settings-credits')).toBeOnTheScreen();
});
